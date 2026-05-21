/**
 * ROCKET SIMULATOR - MAIN COMPONENT (FULLSCREEN + CAMERA VERSION)
 * ================================================================
 * The top-level React component that owns the entire simulator.
 *
 * ARCHITECTURE OVERVIEW:
 *   - Canvas fills 100% of the browser window (window.innerWidth × window.innerHeight).
 *   - A single game loop useEffect runs ONCE (empty dep array).
 *     All physics, camera, and rendering happen inside this loop.
 *     React state is never read inside the loop — only refs — to avoid stale closures.
 *   - Mutable game data lives in refs (flightStateRef, rocketConfigRef, cameraRef, …).
 *   - React state is used ONLY for UI elements that need re-rendering (top bar, modals).
 *   - Every few frames the game loop syncs key values from refs → React state for UI.
 *
 * NEW FEATURES vs. OLD VERSION:
 *   1. Fullscreen canvas with resize listener
 *   2. Camera class: lerp tracking + logarithmic zoom + shake
 *   3. Throttle ramping (50 %/s up, 100 %/s down) — no more instant full-thrust
 *   4. Horizontal steering: A / D or Arrow keys apply angular velocity
 *   5. Time controls: 1×/2×/5×/10× and PAUSE (keyboard 0-4)
 *   6. Physics sub-stepping at high time multipliers (no tunneling)
 *   7. Improved rocket visuals: tapered body, fins, porthole, curved nose, glow flame
 *   8. Parallax star field (3-layer depth)
 *   9. Camera shake during thrust and stage separation
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  createMultiStageRocket,
  updatePhysics,
  applyControls,
  calculateLandingScore,
} from "../physics/engine";
import type { MultiStageRocketState } from "../physics/engine";

import { TrajectoryPanel } from "./TrajectoryPanel";
import { ParticleSystem } from "../physics/ParticleSystem";

import {
  createParachute,
  createLandingGear,
  createLandingState,
  deployParachute,
  updateParachute,
  processLanding,
  type Parachute,
  type LandingGear,
  type LandingState,
} from "../physics/LandingMechanics";

import {
  PerformanceMonitor,
  TrajectoryLimiter,
} from "../utils/PerformanceMonitor";

import { AudioManager } from "../utils/AudioSystem";
import { Camera } from "../utils/Camera";

import {
  GRAVITY,
  DRAG_COEFFICIENT,
  ROCKET_RADIUS,
  PHYSICS_TICK_RATE,
  WIND_SPEED,
  COLORS,
  ALTITUDE_GOALS,
  INFO_PANEL_MARGIN,
  TRAJECTORY_PANEL_WIDTH,
  TRAJECTORY_PANEL_HEIGHT,
  DEBUG_MODE,
} from "../utils/constants";

import {
  ROCKET_FALCON_9_INSPIRED,
  ROCKET_SIMPLE_TWO_STAGE,
  ROCKET_THREE_STAGE,
  type MultiStageRocketConfig,
  resetAllStages,
} from "../physics/MultiStageSystem";

import type { AltitudeGoal } from "../physics/types";

import {
  generateStars,
  drawBackground,
  drawStars,
  drawGround,
  drawGoalLine,
  drawRocket,
  drawTelemetry,
  drawPerfStats,
  type Star,
} from "../utils/drawHelpers";

// Import Monte Carlo simulation engine and supporting types.
// runMonteCarloSimulation: async runner that yields between runs to keep UI responsive.
// createDefaultMonteCarloConfig: factory for the default dispersion settings.
// MonteCarloConfig / MonteCarloResults: TypeScript interfaces for configuration and results.
import {
  runMonteCarloSimulation,
  createDefaultMonteCarloConfig,
  type MonteCarloConfig,
  type MonteCarloResults,
} from "../physics/MonteCarloSimulator";

// Import the full-screen Monte Carlo results visualization panel.
// This component renders the trajectory overlay plot, histograms, pie chart, and run table.
import { MonteCarloPanel } from "./MonteCarloPanel";

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Deep-clone a rocket configuration object.
 * The stages array in the original constants is module-level and would be
 * MUTATED by the physics engine (fuelMass decreases each frame).
 * By cloning before use, we ensure each flight starts with pristine full tanks,
 * and resetting/switching rockets doesn't corrupt the original exported constants.
 *
 * @param config  The source rocket configuration to clone.
 * @returns       A new config object with brand-new stage objects (full tanks).
 */
function cloneRocketConfig(config: MultiStageRocketConfig): MultiStageRocketConfig {
  return {
    ...config, // Shallow copy of config-level fields (name, payloadMass)
    // Deep-copy the stages array so we get independent stage objects.
    // Each stage is spread into a new object so mutations don't affect the original.
    stages: config.stages.map((stage) => ({ ...stage })),
  };
}

// ─── COMPONENT ───────────────────────────────────────────────────────────────

/**
 * Props accepted by RocketSimulator.
 * Both props are optional so existing call-sites with no props continue to work.
 */
interface RocketSimulatorProps {
  // initialConfig: if provided (from RocketBuilder after launching), the simulator
  // uses this custom rocket instead of the default Simple Two-Stage.
  // If undefined, the simulator starts with ROCKET_SIMPLE_TWO_STAGE as before.
  initialConfig?: MultiStageRocketConfig;

  // onSwitchToBuildMode: called when the user selects "Build Custom" from the
  // rocket dropdown, asking App.tsx to switch to BUILD mode.
  // If undefined, the "Build Custom" option is still shown but does nothing.
  onSwitchToBuildMode?: () => void;
}

/**
 * RocketSimulator — the top-level component.
 * Renders a fullscreen canvas with a game loop and React DOM overlays.
 */
export const RocketSimulator: React.FC<RocketSimulatorProps> = ({
  initialConfig,        // Optional custom config from the builder; undefined = use default
  onSwitchToBuildMode,  // Optional callback to switch App.tsx to BUILD mode
}) => {

  // ── CANVAS REF ──────────────────────────────────────────────────────────────
  // Direct reference to the <canvas> DOM element used for rendering.
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── CANVAS SIZE STATE ────────────────────────────────────────────────────────
  // React state for canvas dimensions so <canvas width={} height={}/> re-renders
  // when the window is resized. Initialized to the current window size.
  const [canvasWidth,  setCanvasWidth]  = useState(() => window.innerWidth);
  const [canvasHeight, setCanvasHeight] = useState(() => window.innerHeight);

  // ── GAME-STATE REFS (used inside game loop — never stale) ────────────────────
  // The game loop reads from refs so it doesn't need to be in the useEffect
  // dependency array, which would restart the loop on every state change.

  // Initial rocket config: use the custom config from the builder if provided,
  // otherwise fall back to the built-in Simple Two-Stage preset.
  // We always clone so physics mutations (fuel burn) don't corrupt the source object.
  const rocketConfigRef = useRef<MultiStageRocketConfig>(
    cloneRocketConfig(initialConfig ?? ROCKET_SIMPLE_TWO_STAGE)
    // ?? ROCKET_SIMPLE_TWO_STAGE: nullish coalescing — only falls back when initialConfig is undefined/null
  );

  // Flight state: position, velocity, angle, and all in-flight metrics.
  const flightStateRef = useRef<MultiStageRocketState>(
    createMultiStageRocket(rocketConfigRef.current) // Initial state from fresh config
  );

  // Camera: tracks the rocket with lerp smoothing + logarithmic zoom.
  const cameraRef = useRef<Camera>(new Camera());

  // Keys currently held down (set by keydown/keyup event listeners).
  // Using an object (hash map) allows O(1) key-state lookup each frame.
  const keysPressed = useRef<{ [key: string]: boolean }>({});

  // Particle system: manages exhaust trails, separation bursts, landing impacts.
  const particleSystemRef = useRef<ParticleSystem>(new ParticleSystem());

  // Performance monitor: tracks FPS, frame time, physics time, render time.
  const performanceMonitorRef = useRef<PerformanceMonitor>(new PerformanceMonitor());

  // Trajectory limiter: caps the trajectory history array to prevent memory growth.
  const trajectoryLimiterRef = useRef(
    new TrajectoryLimiter({ maxPoints: 50000, sampleRate: 1, cleanupInterval: 5 })
  );

  // Audio manager: plays all sound effects (engine, staging, landing).
  const audioManagerRef = useRef<AudioManager>(new AudioManager());

  // Star field: pre-generated at startup, read every frame for rendering.
  const starsRef = useRef<Star[]>([]);

  // Trajectory buffer: raw position history accumulated between React state syncs.
  // We sync to React state every N frames rather than every frame to reduce re-renders.
  const trajectoryBufferRef = useRef<Array<{ x: number; y: number }>>([]);

  // rAF handle so we can cancel the loop on cleanup (component unmount).
  const animationFrameRef = useRef<number | null>(null);

  // ── LANDING MECHANICS REFS ────────────────────────────────────────────────
  // Stored in refs (not React state) so they can be read/written in the game loop.
  const parachuteRef    = useRef<Parachute>   (createParachute(100000, 1));   // Single-use chute
  const landingGearRef  = useRef<LandingGear> (createLandingGear(500000));    // Shock-absorbing gear
  const landingStateRef = useRef<LandingState>(createLandingState());          // Landing outcome
  const parachuteDeployedRef = useRef<boolean>(false); // Edge-trigger: only deploy once per flight

  // ── AUDIO TRACKING REFS ────────────────────────────────────────────────────
  // Track throttle and engine sound state to trigger sounds at the right moments.
  const previousThrottleRef    = useRef<number>(0);   // Last frame's throttle (for change detection)
  const engineSoundPlayingRef  = useRef<boolean>(false); // Is the looping engine sound active?
  const sepShakeTimerRef       = useRef<number>(0);   // Countdown for stage-sep camera shake

  // ── GAME-CONTROL REFS (synced FROM React state) ────────────────────────────
  // These refs are written by small useEffects whenever the matching React state
  // changes, so the game loop always reads the current value without being in deps.
  const timeMultiplierRef      = useRef<number>(1);    // 1, 2, 5, or 10
  const isPausedRef            = useRef<boolean>(false); // true = simulation frozen
  const selectedGoalRef        = useRef<AltitudeGoal | null>(ALTITUDE_GOALS[0]);
  const customGoalAltitudeRef  = useRef<number | null>(null);
  const showPerfStatsRef       = useRef<boolean>(DEBUG_MODE);

  // ── REACT STATE (for DOM / UI rendering) ─────────────────────────────────────

  // Current rocket config used for the select box and reset logic.
  // The actual physics-active config lives in rocketConfigRef.
  const [rocketConfig, setRocketConfig] = useState<MultiStageRocketConfig>(
    rocketConfigRef.current // Initially matches the ref
  );

  // Time multiplier shown on the time-control buttons.
  const [timeMultiplier, setTimeMultiplier] = useState<number>(1);

  // Pause state shown in the time-control buttons.
  const [isPaused, setIsPaused] = useState<boolean>(false);

  // Selected altitude goal for the goal selector.
  const [selectedGoal, setSelectedGoal] = useState<AltitudeGoal | null>(ALTITUDE_GOALS[0]);

  // Custom altitude goal entered manually by the player.
  const [customGoalAltitude, setCustomGoalAltitude] = useState<number | null>(null);

  // Landing results: set when the rocket touches down, cleared on reset.
  const [landingScore,      setLandingScore]      = useState<number | null>(null);
  const [landingState,      setLandingState]      = useState<LandingState>(createLandingState());

  // Trajectory history for the trajectory panel component.
  const [trajectoryHistory, setTrajectoryHistory] = useState<Array<{ x: number; y: number }>>([]);

  // Display copy of flight state — synced from flightStateRef every few frames.
  // Used by overlay UI that needs flight data (landing modal, etc.).
  const [displayFlightState, setDisplayFlightState] = useState<MultiStageRocketState>(
    () => flightStateRef.current // Lazy initializer so it starts correct
  );

  // Whether to show the debug performance stats panel (toggled by P key).
  const [showPerfStats, setShowPerfStats] = useState<boolean>(DEBUG_MODE);

  // Whether the fullscreen trajectory view is open.
  const [showFullscreenTrajectory, setShowFullscreenTrajectory] = useState<boolean>(false);

  // ── MONTE CARLO STATE ─────────────────────────────────────────────────────
  // Controls visibility of the Monte Carlo configuration panel (pre-run setup).
  // Set to true when the user clicks "Monte Carlo Analysis" in the landing modal.
  const [showMCConfig, setShowMCConfig] = useState<boolean>(false);

  // Controls visibility of the full-screen Monte Carlo results panel.
  // Set to true once all simulation runs complete and results are ready.
  const [showMCPanel, setShowMCPanel] = useState<boolean>(false);

  // The user-configurable Monte Carlo parameters: number of runs, dispersion ranges, failures.
  // Initialized from createDefaultMonteCarloConfig() which applies real aerospace tolerances.
  const [mcConfig, setMCConfig] = useState<MonteCarloConfig>(() => createDefaultMonteCarloConfig());

  // The computed results from the last completed Monte Carlo batch.
  // null before any simulation has been run; set once all runs complete.
  const [mcResults, setMCResults] = useState<MonteCarloResults | null>(null);

  // Simulation progress: how many runs have completed out of the total.
  // null when not simulating; set to { completed, total } during active simulation.
  const [mcProgress, setMCProgress] = useState<{ completed: number; total: number } | null>(null);

  // Cancellation handle returned by runMonteCarloSimulation().
  // Calling mcCancelRef.current?.() aborts the simulation mid-run if the user navigates away.
  const mcCancelRef = useRef<(() => void) | null>(null);

  // Snapshot of the player's manual flight trajectory at the moment of landing.
  // Populated when the rocket lands; used as the gold comparison line in the MC plot.
  // We store a copy (not a ref to the buffer) so it persists after the buffer is cleared on reset.
  const playerTrajectoryRef = useRef<Array<{ x: number; y: number }>>([]);

  // Audio UI state.
  const [audioMuted,   setAudioMuted]   = useState<boolean>(false);
  const [masterVolume, setMasterVolume] = useState<number>(0.5);

  // ── SYNC: React state → Refs ──────────────────────────────────────────────
  // These tiny effects write updated React state values into the corresponding refs
  // so the game loop (which only reads refs) always has current values without
  // needing to be in the dependency array.

  // Sync effective time multiplier: 0 when paused, otherwise the selected multiplier.
  useEffect(() => {
    timeMultiplierRef.current = isPaused ? 0 : timeMultiplier;
  }, [timeMultiplier, isPaused]); // Re-sync whenever either changes

  // Sync selected goal reference.
  useEffect(() => {
    selectedGoalRef.current = selectedGoal;
  }, [selectedGoal]);

  // Sync custom goal altitude reference.
  useEffect(() => {
    customGoalAltitudeRef.current = customGoalAltitude;
  }, [customGoalAltitude]);

  // Sync performance stats visibility reference.
  useEffect(() => {
    showPerfStatsRef.current = showPerfStats;
  }, [showPerfStats]);

  // ── WINDOW RESIZE ────────────────────────────────────────────────────────────
  useEffect(() => {
    // Update canvas size React state so the canvas element re-renders with new dimensions.
    const handleResize = () => {
      setCanvasWidth(window.innerWidth);   // New pixel width
      setCanvasHeight(window.innerHeight); // New pixel height
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize); // Cleanup on unmount
  }, []); // Only run once at mount — the handler itself reads window.inner* fresh each time

  // ── CANVAS DIMENSION EFFECT ────────────────────────────────────────────────
  // When canvasWidth/Height React state changes, update the actual canvas DOM attributes.
  // React re-renders the element but setting width/height as attributes clears the canvas
  // and updates its rendering buffer size — this is how you resize an HTML canvas.
  useEffect(() => {
    if (canvasRef.current) {
      canvasRef.current.width  = canvasWidth;  // Update drawing buffer width
      canvasRef.current.height = canvasHeight; // Update drawing buffer height
    }
  }, [canvasWidth, canvasHeight]);

  // ── STAR FIELD GENERATION ────────────────────────────────────────────────────
  // Generate 300 stars once at mount. Stored in a ref so the game loop
  // can read them each frame without triggering re-renders.
  useEffect(() => {
    starsRef.current = generateStars(300); // 300 stars: enough density, not too many to draw
  }, []); // Only generate once — star positions are random but fixed per session

  // ── KEYBOARD EVENT LISTENERS ──────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Store both lowercase and original-case key so A=="a" and ArrowLeft=="arrowleft".
      keysPressed.current[e.key] = true;             // Original key (e.g., "ArrowLeft")
      keysPressed.current[e.key.toLowerCase()] = true; // Lowercase (e.g., "arrowleft")

      // ── Time controls ──
      if (e.key === "1") { setTimeMultiplier(1);  setIsPaused(false); } // 1× speed
      else if (e.key === "2") { setTimeMultiplier(2);  setIsPaused(false); } // 2× speed
      else if (e.key === "3") { setTimeMultiplier(5);  setIsPaused(false); } // 5× speed
      else if (e.key === "4") { setTimeMultiplier(10); setIsPaused(false); } // 10× speed
      else if (e.key === "0") { setIsPaused((p) => !p); } // Toggle pause

      // ── UI controls ──
      if (e.key === "Escape") setShowFullscreenTrajectory(false); // Close fullscreen trajectory
      if (e.key === " ")      e.preventDefault(); // Prevent SPACEBAR from scrolling the page
      if (e.key === "p" || e.key === "P") setShowPerfStats((p) => !p); // Toggle perf stats
      if (e.key === "m" || e.key === "M") { // Toggle audio mute
        const muted = audioManagerRef.current.toggleMute();
        setAudioMuted(muted);
        audioManagerRef.current.playSound("ui-click");
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Release both original and lowercase entries so steering stops when key is lifted.
      keysPressed.current[e.key] = false;
      keysPressed.current[e.key.toLowerCase()] = false;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup",   handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup",   handleKeyUp);
    };
  }, []); // Only attach once — handler reads refs dynamically, no stale values

  // ── MAIN GAME LOOP ─────────────────────────────────────────────────────────
  // Runs ONCE on mount (empty dependency array).
  // All game data is accessed via refs — no stale closures.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let lastFrameTime = performance.now(); // Timestamp of the previous frame (ms)
    let frameCount = 0;                    // Total frames rendered since loop start

    const gameLoop = () => {
      frameCount++; // Increment global frame counter
      performanceMonitorRef.current.startFrame(); // Start perf measurement for this frame

      // Compute wall-clock time since last frame, capped at 0.1 s.
      // The cap prevents a "spiral of death" if the tab was backgrounded for several seconds:
      // without the cap, one giant Δt would send the rocket flying impossibly fast.
      const now = performance.now();
      const rawDelta = Math.min((now - lastFrameTime) / 1000, 0.1); // Seconds, max 0.1 s
      lastFrameTime = now;

      // Read the current canvas dimensions (may have changed via resize).
      const cw = canvas.width;
      const ch = canvas.height;

      // ── TIME MULTIPLIER ──────────────────────────────────────────────────
      // effectiveMult is 0 when paused (no physics), 1-10 otherwise.
      const effectiveMult = timeMultiplierRef.current;
      // Game-time delta: how much simulated time passes this frame.
      const gameDelta = rawDelta * effectiveMult;

      // ── PHYSICS SUB-STEPPING ────────────────────────────────────────────
      // At high time multipliers we run multiple physics ticks per frame.
      // Each tick uses rawDelta (real-time step), so the total game time per
      // frame is rawDelta × subSteps = gameDelta.
      //
      // WHY SUB-STEPPING?
      //   At 10× speed, one giant Δt = 0.16 s per frame. With fast acceleration
      //   and small objects, the rocket could pass through the ground in a single
      //   step (numerical tunneling). 10 sub-steps of 0.016 s each are safer.
      const subSteps = effectiveMult > 0 ? Math.max(1, Math.round(effectiveMult)) : 0;
      // subDelta: time per physics sub-step.
      const subDelta = subSteps > 0 ? gameDelta / subSteps : 0;

      // Run all sub-steps this frame.
      for (let step = 0; step < subSteps; step++) {
        const state  = flightStateRef.current;  // Current flight state (ref — always fresh)
        const config = rocketConfigRef.current; // Current rocket config (ref — always fresh)

        // ── READ KEYS ────────────────────────────────────────────────────
        const spacebar  = keysPressed.current[" "] ?? false;       // Thrust
        const clickBurst = keysPressed.current["mouseClick"] ?? false; // Click burst
        const tiltLeft  = (keysPressed.current["a"] ?? false) ||
                          (keysPressed.current["arrowleft"] ?? false); // Steer left
        const tiltRight = (keysPressed.current["d"] ?? false) ||
                          (keysPressed.current["arrowright"] ?? false); // Steer right

        // ── APPLY CONTROLS ───────────────────────────────────────────────
        // Throttle ramp + angular velocity change from steering input.
        applyControls(config, state, spacebar, clickBurst, tiltLeft, tiltRight, subDelta);

        // Clear mouse-click flag after the first sub-step — it's a one-shot event,
        // not a held state. Consuming it on step 0 prevents applying it 10 times at 10×.
        if (step === 0) keysPressed.current["mouseClick"] = false;

        // ── PHYSICS UPDATE ───────────────────────────────────────────────
        performanceMonitorRef.current.startPhysicsTimer();
        const frame = updatePhysics(
          state,
          config,
          {
            gravity:           GRAVITY,           // 9.81 m/s²
            windSpeed:         WIND_SPEED,         // {x: 3, y: 0} light breeze
            dragCoefficient:   DRAG_COEFFICIENT,   // 0.1
            rocketRadius:      ROCKET_RADIUS,       // 0.5 m
            timeStep:          PHYSICS_TICK_RATE,   // 60 Hz target rate
          },
          subDelta
        );
        performanceMonitorRef.current.endPhysicsTimer();

        // ── AUDIO: ENGINE SOUNDS (only on first sub-step to avoid sound spam) ──
        if (step === 0) {
          const activeStg  = config.stages.find((s) => s.isActive && !s.isSeparated);
          const throttle   = activeStg ? activeStg.thrustPercentage : 0;

          // Engine ignition: rising from 0 to >0 throttle.
          if (throttle > 0 && previousThrottleRef.current === 0) {
            audioManagerRef.current.playSound("engine-ignition");
          }
          // Throttle-up click: throttle increased by more than 10% since last frame.
          if (throttle > previousThrottleRef.current + 10) {
            audioManagerRef.current.playSound("thrust-increase");
          }
          // Throttle-down click: throttle dropped by more than 10%.
          if (throttle < previousThrottleRef.current - 10) {
            audioManagerRef.current.playSound("thrust-decrease");
          }
          // Continuous engine sound while flying and thrusting.
          if (throttle > 0 && frame.state.isFlying) {
            if (!engineSoundPlayingRef.current) {
              audioManagerRef.current.playSound("engine-thrust", {
                loop:  true,
                pitch: 0.8 + (throttle / 100) * 0.4, // Higher pitch at higher throttle
              });
              engineSoundPlayingRef.current = true;
            }
          } else {
            if (engineSoundPlayingRef.current) {
              audioManagerRef.current.stopSound("engine-thrust");
              engineSoundPlayingRef.current = false;
            }
          }
          previousThrottleRef.current = throttle; // Remember for next frame
        }

        // ── PARACHUTE ───────────────────────────────────────────────────
        // Auto-deploy when descending fast above minimum altitude (first time only).
        if (
          frame.state.isFlying &&
          !parachuteDeployedRef.current &&
          frame.state.velocity.y < -5 &&   // Moving downward at > 5 m/s
          frame.state.position.y > parachuteRef.current.minAltitudeForDeployment
        ) {
          deployParachute(parachuteRef.current); // Start parachute inflation
          parachuteDeployedRef.current = true;  // Only deploy once
          audioManagerRef.current.playSound("parachute-deploy");
        }
        updateParachute(parachuteRef.current, subDelta); // Inflate over time

        // ── STAGE SEPARATION EFFECTS ─────────────────────────────────────
        if (frame.state.didStageSeperateThisFrame) {
          // Burst of orange particles at separation point.
          particleSystemRef.current.createBurst(
            frame.state.position.x,
            frame.state.position.y,
            20,                          // 20 particles
            "rgba(255, 200, 100, 1)",    // Orange-yellow burst color
            40                           // 40 m/s max outward speed
          );
          sepShakeTimerRef.current = 0.5; // Stage shake lasts 0.5 real seconds
          cameraRef.current.addShake(5);  // Immediate 5-pixel camera jolt
          if (step === 0) audioManagerRef.current.playSound("stage-separation");
        }

        // ── LANDING DETECTION ────────────────────────────────────────────
        if (frame.groundImpact && !landingStateRef.current.hasTouchedDown) {
          // Process landing: compute damage, quality, score.
          const updatedLanding = processLanding(
            landingStateRef.current,
            frame.state.landingVelocity,
            1000, // Rocket mass estimate for damage calculation
            landingGearRef.current,
            parachuteRef.current.hasBeenUsed ? 1 : 0
          );
          landingStateRef.current = updatedLanding;

          const score = calculateLandingScore(frame.state.landingVelocity);

          // Sync landing results to React state (triggers UI re-render for landing modal).
          setLandingScore(score);
          setLandingState({ ...updatedLanding });

          // Snapshot the player's flight trajectory at the moment of landing.
          // We spread the buffer into a new array so this copy is independent —
          // if the player hits Reset, trajectoryBufferRef is cleared but this snapshot persists.
          // The snapshot is used as the gold comparison line in the Monte Carlo trajectory plot.
          playerTrajectoryRef.current = [...trajectoryBufferRef.current];

          // Landing visual effects.
          if (score > 50) {
            // Soft landing: small dust puff.
            particleSystemRef.current.createBurst(frame.state.position.x, 0, 5, "rgba(200,200,200,0.8)", 8);
            audioManagerRef.current.playSound("landing-soft");
          } else {
            // Hard landing / crash: big explosion burst.
            particleSystemRef.current.createBurst(frame.state.position.x, 0, 20, "rgba(255,80,0,1)", 30);
            audioManagerRef.current.playSound("landing-hard");
          }
          audioManagerRef.current.stopSound("engine-thrust");
          engineSoundPlayingRef.current = false;
        }

        // Update the flight state ref with the result of this physics sub-step.
        flightStateRef.current = frame.state;
      } // END physics sub-steps

      // ── PARTICLES ────────────────────────────────────────────────────────
      // Spawn exhaust particles at REAL time rate (not game-time rate).
      // At 10× speed we don't want 10× the particles — cap spawn via probability.
      const activeStage = rocketConfigRef.current.stages.find(
        (s) => s.isActive && !s.isSeparated
      );
      if (activeStage && activeStage.isThrusting && activeStage.fuelMass > 0) {
        // spawnChance: 1.0 at 1× speed, 0.1 at 10× speed — inversely proportional.
        const spawnChance = Math.min(1, 1 / Math.max(1, effectiveMult));
        if (Math.random() < spawnChance) {
          // Spawn exhaust at the rocket's current position in WORLD SPACE.
          particleSystemRef.current.createExhaustTrail(
            flightStateRef.current.position.x,
            flightStateRef.current.position.y,
            flightStateRef.current.velocity.x,
            flightStateRef.current.velocity.y,
            flightStateRef.current.angle,       // NEW: angle so exhaust comes from the nozzle
            activeStage.thrustPercentage
          );
        }
      }

      // Update particles at REAL time speed (rawDelta), not game time.
      // Particles are visual — they should always fade at wall-clock speed.
      particleSystemRef.current.update(rawDelta);

      // ── CAMERA UPDATE ──────────────────────────────────────────────────
      const state = flightStateRef.current;
      const camera = cameraRef.current;

      // Tell camera to follow the rocket's current position.
      camera.setTarget(state.position.x, state.position.y);

      // Set camera zoom based on current altitude.
      camera.setTargetZoom(state.position.y);

      // Engine vibration shake: subtle above 50% throttle.
      if (activeStage && activeStage.thrustPercentage > 50) {
        // Intensity: 0 px at 50% throttle, up to 2 px at 100% throttle.
        const shakeIntensity = ((activeStage.thrustPercentage - 50) / 50) * 2;
        camera.addShake(shakeIntensity);
      }

      // Stage-separation shake: persist the jolt for 0.5 real seconds.
      if (sepShakeTimerRef.current > 0) {
        sepShakeTimerRef.current -= rawDelta; // Countdown in real seconds
        camera.addShake(4); // Strong shake during countdown
      }

      // Smooth zoom back to normal after landing.
      if (state.hasLanded) {
        camera.setTargetZoom(0); // Target zoom=1.0 (ground level)
        // Also re-target to rocket's landing position so camera doesn't drift.
        camera.setTarget(state.position.x, 0);
      }

      camera.update(rawDelta); // Lerp position/zoom, decay shake

      // ── RENDER ────────────────────────────────────────────────────────────
      performanceMonitorRef.current.startRenderTimer();

      ctx.clearRect(0, 0, cw, ch); // Clear previous frame

      // 1. Sky gradient (changes color with altitude).
      drawBackground(ctx, cw, ch, state.position.y);

      // 2. Parallax star field (only visible above ~5 km).
      drawStars(ctx, starsRef.current, cw, ch, camera, state.position.y);

      // 3. Ground surface line at world Y=0.
      drawGround(ctx, cw, ch, camera);

      // 4. Exhaust particles and stage-separation burst.
      particleSystemRef.current.draw(ctx, camera, cw, ch);

      // 5. Goal altitude indicator line.
      const goalAlt  = customGoalAltitudeRef.current ?? selectedGoalRef.current?.altitude ?? 0;
      const goalName = customGoalAltitudeRef.current
        ? "Custom"
        : (selectedGoalRef.current?.name ?? "");
      if (goalAlt > 0) drawGoalLine(ctx, cw, ch, camera, goalAlt, goalName);

      // 6. Rocket body (camera-transformed, angle-rotated, detailed visual).
      drawRocket(
        ctx, cw, ch, camera, state,
        rocketConfigRef.current,
        parachuteRef.current,
        landingGearRef.current
      );

      // 7. Telemetry HUD (bottom-right canvas overlay).
      const activeMult = isPausedRef.current ? 0 : timeMultiplierRef.current;
      drawTelemetry(ctx, cw, ch, state, rocketConfigRef.current, activeMult, isPausedRef.current);

      // 8. Debug performance panel (top-left, toggle with P key).
      if (showPerfStatsRef.current) {
        drawPerfStats(ctx, performanceMonitorRef.current.getMetrics());
      }

      performanceMonitorRef.current.endRenderTimer();
      performanceMonitorRef.current.setParticleCount(particleSystemRef.current.getParticleCount());
      performanceMonitorRef.current.setTrajectoryPointCount(trajectoryBufferRef.current.length);
      performanceMonitorRef.current.endFrame();

      // ── SYNC TO REACT STATE (every 3 frames to reduce re-renders) ──────────
      if (frameCount % 3 === 0) {
        // Copy flight state to React state for overlay UI (landing modal, etc.).
        setDisplayFlightState({ ...flightStateRef.current });

      }

      // ── TRAJECTORY BUFFER ────────────────────────────────────────────────
      // Append current position to the raw buffer every frame.
      trajectoryBufferRef.current.push({
        x: state.position.x,
        y: state.position.y,
      });

      // Sync trajectory buffer to React state every 10 frames.
      // TrajectoryPanel reads from React state, so we need periodic syncs.
      if (frameCount % 10 === 0) {
        const limited = trajectoryLimiterRef.current.limitTrajectory(
          [...trajectoryBufferRef.current] // Pass a copy — limiter may truncate
        );
        setTrajectoryHistory(limited);
      }

      // Schedule next frame via rAF.
      animationFrameRef.current = requestAnimationFrame(gameLoop);
    }; // END gameLoop

    // Kick off the loop.
    animationFrameRef.current = requestAnimationFrame(gameLoop);

    // Cleanup: cancel the rAF when the component unmounts.
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []); // EMPTY DEPS — game loop runs once and reads all values from refs

  // ── EVENT HANDLERS (React UI) ─────────────────────────────────────────────

  /** Reset the simulation to the pre-launch state. */
  const handleReset = useCallback(() => {
    // Clone the current rocket config fresh so all tanks are full again.
    const freshConfig = cloneRocketConfig(rocketConfigRef.current);
    resetAllStages(freshConfig); // Ensure all stages are reset to initial state

    // Update the physics-active config ref immediately (the game loop will see this next tick).
    rocketConfigRef.current = freshConfig;

    // Reset flight state: back to ground, no velocity, no rotation.
    const freshState = createMultiStageRocket(freshConfig);
    flightStateRef.current = freshState;

    // Sync fresh state to React for UI display.
    setDisplayFlightState({ ...freshState });
    setRocketConfig(freshConfig); // Update React state so the select box label stays correct

    // Reset landing state.
    landingStateRef.current = createLandingState();
    parachuteRef.current = createParachute(100000, 1); // New parachute (not used)
    landingGearRef.current = createLandingGear(500000); // Fresh gear
    parachuteDeployedRef.current = false; // Allow parachute deployment on new flight

    // Snap camera back to ground.
    cameraRef.current.reset();

    // Clear trajectory.
    trajectoryBufferRef.current = [];
    setTrajectoryHistory([]);
    setLandingScore(null);
    setLandingState(createLandingState());

    // Clear particles (no leftover exhaust from previous flight).
    particleSystemRef.current.clear();

    // Stop all audio and play a click confirmation.
    audioManagerRef.current.stopAllSounds();
    audioManagerRef.current.playSound("ui-click");
    engineSoundPlayingRef.current = false;

    // Reset performance monitor stats.
    performanceMonitorRef.current.reset();
    setShowFullscreenTrajectory(false);

    // Cancel any in-progress Monte Carlo simulation so it doesn't call setState
    // on an unmounted or reset component. Then clear all MC UI state.
    mcCancelRef.current?.();              // Abort the async simulation loop
    mcCancelRef.current = null;           // Clear the stale cancel handle
    setShowMCConfig(false);              // Close config panel if open
    setShowMCPanel(false);               // Close results panel if open
    setMCProgress(null);                 // Clear progress bar
    // Note: we intentionally keep mcResults so the user can reopen the last
    // results panel via "Monte Carlo Analysis" in the new landing modal.
    // Clear playerTrajectoryRef so a fresh flight starts without the old comparison line.
    playerTrajectoryRef.current = [];
  }, []); // No deps — all game data accessed via refs

  /** Switch to a different rocket type. */
  const handleRocketChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value;

    // "Build Custom" is not a preset — it asks App.tsx to switch to BUILD mode instead.
    // onSwitchToBuildMode is the callback passed in as a prop from App.tsx.
    if (name === "Build Custom") {
      onSwitchToBuildMode?.(); // Optional chaining: safe to call even if prop is undefined
      return;                   // Don't try to load a config for this virtual option
    }

    // Find the selected config constant.
    let baseConfig: MultiStageRocketConfig | null = null;
    if (name === "Simple Two-Stage")   baseConfig = ROCKET_SIMPLE_TWO_STAGE;
    if (name === "Falcon 9 Inspired")  baseConfig = ROCKET_FALCON_9_INSPIRED;
    if (name === "Three-Stage Heavy")  baseConfig = ROCKET_THREE_STAGE;
    if (!baseConfig) return;

    // Clone it so mutations don't corrupt the exported constants.
    const freshConfig = cloneRocketConfig(baseConfig);
    resetAllStages(freshConfig); // Ensure full tanks

    // Update physics ref and React state.
    rocketConfigRef.current = freshConfig;
    setRocketConfig(freshConfig);

    // Create a fresh flight state for the new rocket.
    const freshState = createMultiStageRocket(freshConfig);
    flightStateRef.current = freshState;
    setDisplayFlightState({ ...freshState });

    // Reset landing mechanics for the new rocket.
    landingStateRef.current = createLandingState();
    parachuteRef.current = createParachute(100000, 1);
    landingGearRef.current = createLandingGear(500000);
    parachuteDeployedRef.current = false;

    // Clear old trajectory and landing results.
    trajectoryBufferRef.current = [];
    setTrajectoryHistory([]);
    setLandingScore(null);
    setLandingState(createLandingState());

    // Clear particles and snap camera.
    particleSystemRef.current.clear();
    cameraRef.current.reset();

    // Stop audio.
    audioManagerRef.current.stopAllSounds();
    audioManagerRef.current.playSound("ui-select");
    engineSoundPlayingRef.current = false;

    performanceMonitorRef.current.reset();
  }, []);

  /** Handle goal selector change. */
  const handleGoalChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const goal = ALTITUDE_GOALS.find((g) => g.name === e.target.value);
    if (goal) {
      setSelectedGoal(goal);
      setCustomGoalAltitude(null); // Clear custom goal when preset is selected
      audioManagerRef.current.playSound("ui-select");
    }
  }, []);

  /** Handle custom goal altitude input. */
  const handleCustomGoal = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "") {
      setCustomGoalAltitude(null);           // Empty input clears custom goal
      setSelectedGoal(ALTITUDE_GOALS[0]);    // Fall back to first preset
    } else {
      const alt = parseFloat(val);
      if (!isNaN(alt) && alt > 0) {
        setCustomGoalAltitude(alt);  // Store valid positive altitude
        setSelectedGoal(null);       // Deselect preset when custom is entered
      }
    }
  }, []);

  /** Handle volume slider change. */
  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value);
    setMasterVolume(vol);
    audioManagerRef.current.setMasterVolume(vol); // Apply to AudioManager immediately
  }, []);

  /** Handle canvas click to trigger a burst of thrust. */
  const handleCanvasClick = useCallback(() => {
    keysPressed.current["mouseClick"] = true; // Set for next game loop tick
  }, []);

  // ── OVERLAY STYLE HELPERS ─────────────────────────────────────────────────

  // Shared style for the semi-transparent top control bar.
  const topBarStyle: React.CSSProperties = {
    position:        "absolute",
    top:             0,
    left:            0,
    right:           0,
    display:         "flex",
    flexWrap:        "wrap",
    gap:             "8px",
    alignItems:      "center",
    padding:         "8px 12px",
    backgroundColor: "rgba(5, 8, 25, 0.85)", // Dark semi-transparent
    backdropFilter:  "blur(4px)",             // Frosted-glass effect
    borderBottom:    `1px solid ${COLORS.ui}`,
    fontFamily:      "monospace",
    color:           COLORS.text,
    fontSize:        "13px",
    zIndex:          10,
  };

  // Shared style for all top-bar control groups.
  const controlGroupStyle: React.CSSProperties = {
    display:    "flex",
    alignItems: "center",
    gap:        "6px",
  };

  // Style for select/input controls in the top bar.
  const selectStyle: React.CSSProperties = {
    padding:         "4px 6px",
    backgroundColor: "#0d1a35",
    color:           COLORS.text,
    border:          `1px solid ${COLORS.ui}`,
    borderRadius:    "3px",
    cursor:          "pointer",
    fontSize:        "12px",
    fontFamily:      "monospace",
  };

  // Style for buttons in the top bar.
  const btnStyle = (active: boolean, accent?: string): React.CSSProperties => ({
    padding:         "4px 10px",
    backgroundColor: active ? (accent ?? COLORS.ui) : "rgba(15, 25, 50, 0.9)",
    color:           active ? "#fff" : COLORS.text,
    border:          `1px solid ${active ? (accent ?? COLORS.ui) : "rgba(74,111,165,0.5)"}`,
    borderRadius:    "3px",
    cursor:          "pointer",
    fontSize:        "12px",
    fontFamily:      "monospace",
    fontWeight:      active ? "bold" : "normal",
  });

  // ── RENDER ───────────────────────────────────────────────────────────────
  return (
    // Root container: fixed position filling the entire viewport, overflow hidden
    // so the canvas never creates a scrollbar.
    <div
      style={{
        position:   "fixed",  // Fixed removes it from normal flow
        inset:      0,         // top/right/bottom/left all 0 — fills viewport
        overflow:   "hidden",  // Prevent scrollbars from appearing
        fontFamily: "monospace",
        color:      COLORS.text,
      }}
    >
      {/* CANVAS — fills the entire window, sits behind all overlays */}
      <canvas
        ref={canvasRef}
        width={canvasWidth}   // Drawing buffer width (actual canvas resolution)
        height={canvasHeight} // Drawing buffer height
        onClick={handleCanvasClick} // Click triggers burst thrust
        style={{
          position: "absolute", // Behind all overlays
          top:      0,
          left:     0,
          width:    "100%",   // CSS size = 100% viewport (matches buffer size)
          height:   "100%",
          cursor:   "crosshair", // Crosshair cursor indicates click-to-thrust
        }}
      />

      {/* ── TOP CONTROL BAR ─────────────────────────────────────────────── */}
      {/* Positioned absolutely over the canvas. Semi-transparent overlay. */}
      <div style={topBarStyle}>

        {/* Rocket selector */}
        <div style={controlGroupStyle}>
          <span>Rocket:</span>
          <select value={rocketConfig.name} onChange={handleRocketChange} style={selectStyle}>
            <option value="Simple Two-Stage">Simple Two-Stage</option>
            <option value="Falcon 9 Inspired">Falcon 9 Inspired</option>
            <option value="Three-Stage Heavy">Three-Stage Heavy</option>
            {/* Sentinel option: selecting this calls onSwitchToBuildMode via handleRocketChange */}
            <option value="Build Custom">⚙ Build Custom...</option>
          </select>
        </div>

        {/* Goal selector */}
        <div style={controlGroupStyle}>
          <span>Goal:</span>
          <select
            value={selectedGoal?.name ?? "custom"}
            onChange={handleGoalChange}
            style={selectStyle}
          >
            {ALTITUDE_GOALS.map((g) => (
              <option key={g.name} value={g.name}>{g.name}</option>
            ))}
          </select>
        </div>

        {/* Custom altitude input */}
        <div style={controlGroupStyle}>
          <span>Custom (m):</span>
          <input
            type="number"
            value={customGoalAltitude ?? ""}
            onChange={handleCustomGoal}
            placeholder="altitude"
            style={{ ...selectStyle, width: "90px" }}
          />
        </div>

        {/* Reset button */}
        <button onClick={handleReset} style={btnStyle(false)}>
          ↺ Reset
        </button>

        {/* Vertical separator */}
        <div style={{ width: "1px", height: "22px", backgroundColor: COLORS.ui, opacity: 0.4 }} />

        {/* ── TIME CONTROLS ──────────────────────────────────────────── */}
        <div style={controlGroupStyle}>
          <span>Speed:</span>
          {/* Pause button */}
          <button
            onClick={() => setIsPaused((p) => !p)}
            style={btnStyle(isPaused, "#cc6600")}
            title="Pause/Resume (0 key)"
          >
            {isPaused ? "▶ RESUME" : "⏸ PAUSE"}
          </button>
          {/* 1× speed */}
          <button
            onClick={() => { setTimeMultiplier(1);  setIsPaused(false); }}
            style={btnStyle(!isPaused && timeMultiplier === 1,  "#226633")}
            title="1× speed (1 key)"
          >1×</button>
          {/* 2× speed */}
          <button
            onClick={() => { setTimeMultiplier(2);  setIsPaused(false); }}
            style={btnStyle(!isPaused && timeMultiplier === 2,  "#226633")}
            title="2× speed (2 key)"
          >2×</button>
          {/* 5× speed */}
          <button
            onClick={() => { setTimeMultiplier(5);  setIsPaused(false); }}
            style={btnStyle(!isPaused && timeMultiplier === 5,  "#446611")}
            title="5× speed (3 key)"
          >5×</button>
          {/* 10× speed */}
          <button
            onClick={() => { setTimeMultiplier(10); setIsPaused(false); }}
            style={btnStyle(!isPaused && timeMultiplier === 10, "#663311")}
            title="10× speed (4 key)"
          >10×</button>
        </div>

        {/* Vertical separator */}
        <div style={{ width: "1px", height: "22px", backgroundColor: COLORS.ui, opacity: 0.4 }} />

        {/* ── AUDIO CONTROLS ─────────────────────────────────────────── */}
        <div style={controlGroupStyle}>
          <button
            onClick={() => {
              const muted = audioManagerRef.current.toggleMute();
              setAudioMuted(muted);
            }}
            style={btnStyle(audioMuted, "#882222")}
            title="Toggle mute (M key)"
          >
            {audioMuted ? "🔇 MUTED" : "🔊 AUDIO"}
          </button>
          <input
            type="range"
            min="0" max="1" step="0.05"
            value={masterVolume}
            onChange={handleVolumeChange}
            style={{ width: "70px", cursor: "pointer", accentColor: COLORS.ui }}
            title="Master volume"
          />
          <span style={{ fontSize: "11px" }}>{Math.round(masterVolume * 100)}%</span>
        </div>

        {/* Key hint */}
        <div style={{ marginLeft: "auto", fontSize: "11px", opacity: 0.6 }}>
          SPACE=thrust · A/D=steer · 0-4=speed · P=perf · M=mute
        </div>
      </div>

      {/* ── TRAJECTORY PANEL — bottom-left overlay ────────────────────────── */}
      {!showFullscreenTrajectory && (
        <div
          style={{
            position: "absolute",
            bottom:   INFO_PANEL_MARGIN,
            left:     INFO_PANEL_MARGIN,
            width:    TRAJECTORY_PANEL_WIDTH,
            height:   TRAJECTORY_PANEL_HEIGHT,
            zIndex:   10,
          }}
        >
          <TrajectoryPanel
            rocketState={displayFlightState as any} // TrajectoryPanel accepts RocketState shape
            trajectoryHistory={trajectoryHistory}
            isFullscreen={false}
            onCloseFullscreen={() => {}}
          />
          {/* Expand button in the top-right corner of the trajectory panel */}
          <button
            onClick={() => setShowFullscreenTrajectory(true)}
            style={{
              position:        "absolute",
              top:             "4px",
              right:           "4px",
              padding:         "2px 6px",
              fontSize:        "11px",
              backgroundColor: COLORS.ui,
              color:           COLORS.text,
              border:          `1px solid ${COLORS.text}`,
              cursor:          "pointer",
              borderRadius:    "2px",
              zIndex:          11,
            }}
            title="Expand trajectory to fullscreen"
          >⛶</button>
        </div>
      )}

      {/* ── FULLSCREEN TRAJECTORY VIEW ──────────────────────────────────────── */}
      {showFullscreenTrajectory && (
        <TrajectoryPanel
          rocketState={displayFlightState as any}
          trajectoryHistory={trajectoryHistory}
          isFullscreen={true}
          onCloseFullscreen={() => setShowFullscreenTrajectory(false)}
        />
      )}

      {/* ── LANDING RESULTS MODAL — centered overlay ────────────────────────── */}
      {landingScore !== null && (
        <div
          style={{
            position:        "absolute",
            top:             "50%",
            left:            "50%",
            transform:       "translate(-50%, -50%)", // True center of viewport
            backgroundColor: "rgba(5, 8, 25, 0.95)",
            border:          `2px solid ${COLORS.ui}`,
            borderRadius:    "6px",
            padding:         "20px 28px",
            minWidth:        "300px",
            textAlign:       "center",
            zIndex:          20,
            backdropFilter:  "blur(8px)",
          }}
        >
          <h2 style={{ marginTop: 0, color: COLORS.trajectory }}>Landing Report</h2>

          {/* Score — big colored number */}
          <div style={{
            fontSize: "48px",
            fontWeight: "bold",
            color: landingScore >= 80 ? "#44ff44" : landingScore >= 50 ? "#ffaa00" : "#ff4444",
            margin: "8px 0",
          }}>
            {landingScore.toFixed(0)}<span style={{ fontSize: "20px" }}>/100</span>
          </div>

          {/* Quality label */}
          <p style={{ margin: "4px 0", fontSize: "16px" }}>
            {landingState.landingQuality}
          </p>

          {/* Details grid */}
          <table style={{ width: "100%", fontSize: "13px", borderCollapse: "collapse", marginTop: "12px" }}>
            <tbody>
              {[
                ["Max Altitude", `${(displayFlightState.maxAltitudeReached / 1000).toFixed(2)} km`],
                ["Landing Velocity", `${Math.abs(displayFlightState.landingVelocity).toFixed(1)} m/s`],
                ["Structural Damage", `${landingState.structuralDamage.toFixed(1)}%`],
                ["Reusable", landingState.isReusable ? "✓ YES" : "✗ NO"],
                ["Stages Separated", `${displayFlightState.stageSeparationCount}`],
                ["Parachutes Used", `${landingState.parachutesDeployed}`],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td style={{ textAlign: "left", padding: "3px 8px", color: "#aabbcc" }}>{label}</td>
                  <td style={{ textAlign: "right", padding: "3px 8px", fontWeight: "bold" }}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Dismiss / Reset / Monte Carlo buttons */}
          <div style={{ display: "flex", gap: "10px", marginTop: "16px", justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => setLandingScore(null)} // Dismiss modal but keep the landed state
              style={{
                ...btnStyle(false),
                padding: "6px 16px",
              }}
            >
              Dismiss
            </button>
            <button
              onClick={handleReset} // Full reset for another flight
              style={{
                ...btnStyle(true, COLORS.ui),
                padding: "6px 16px",
              }}
            >
              ↺ Fly Again
            </button>
            {/* Monte Carlo button: opens the configuration panel to set up parallel simulations.
                Only shown after landing so the user has a manual flight to compare against.
                The ⚡ lightning bolt visually signals "run a batch of simulations now." */}
            <button
              onClick={() => {
                setLandingScore(null);    // Close landing modal to reduce UI clutter
                setShowMCConfig(true);    // Open Monte Carlo configuration panel
              }}
              style={{
                ...btnStyle(true, "#1a5c38"), // Dark green: distinct from UI blue
                padding: "6px 16px",
              }}
              title="Run multiple automated simulations to see the range of possible outcomes"
            >
              ⚡ Parallel Simulations
            </button>
          </div>
        </div>
      )}
      {/* ── MONTE CARLO CONFIGURATION PANEL ────────────────────────────────────── */}
      {/* Modal dialog for setting up the Monte Carlo simulation before running.
          Lets the user choose: number of runs, whether to include failures, and failure rate.
          Appears after the user clicks "⚡ Parallel Simulations" in the landing modal. */}
      {showMCConfig && (
        <div
          style={{
            position:        "absolute",
            top:             "50%",
            left:            "50%",
            transform:       "translate(-50%, -50%)", // Perfectly centered on viewport
            backgroundColor: "rgba(4, 8, 22, 0.98)",
            border:          `2px solid ${COLORS.ui}`,
            borderRadius:    "6px",
            padding:         "20px 24px",
            minWidth:        "340px",
            zIndex:          25,                      // Above landing modal (z=20) and canvas
            backdropFilter:  "blur(8px)",
            fontFamily:      "monospace",
            color:           "#e0e8ff",
          }}
        >
          {/* Config panel title */}
          <h3 style={{ marginTop: 0, color: COLORS.trajectory, fontSize: 15 }}>
            Monte Carlo Analysis Configuration
          </h3>

          {/* Brief explanation of what Monte Carlo analysis does */}
          <p style={{ fontSize: 11, opacity: 0.65, margin: "0 0 16px 0", lineHeight: 1.5 }}>
            Runs N automated simulations of <strong>{rocketConfig.name}</strong> with randomized
            thrust (±3%), mass (±2%), fuel loading (±1%), wind (0-15 m/s), and Isp (±1.5%)
            variations to show the statistical range of possible trajectories.
          </p>

          {/* Number of runs selector */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
              Number of simulation runs:
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              {/* Four preset run counts — more runs = better statistics but takes longer */}
              {([10, 25, 50, 100] as const).map(n => (
                <button
                  key={n}
                  onClick={() => setMCConfig(prev => ({ ...prev, numberOfRuns: n }))}
                  style={{
                    flex:            1,
                    padding:         "5px 0",
                    backgroundColor: mcConfig.numberOfRuns === n
                      ? COLORS.ui           // Active/selected: accent blue
                      : "rgba(10, 20, 50, 0.8)", // Inactive: dark background
                    color:           mcConfig.numberOfRuns === n ? "#fff" : "#aabbcc",
                    border:          `1px solid ${mcConfig.numberOfRuns === n ? COLORS.ui : "rgba(74,111,165,0.4)"}`,
                    borderRadius:    3,
                    cursor:          "pointer",
                    fontFamily:      "monospace",
                    fontSize:        13,
                    fontWeight:      mcConfig.numberOfRuns === n ? "bold" : "normal",
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
            {/* Hint about trade-off between speed and statistical accuracy */}
            <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>
              More runs = better statistics. 50 runs takes ~2-3 seconds.
            </div>
          </div>

          {/* Include failure scenarios toggle */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={mcConfig.includeFailureScenarios} // Controlled by mcConfig state
                onChange={e => setMCConfig(prev => ({
                  ...prev,
                  includeFailureScenarios: e.target.checked, // Toggle failure injection
                }))}
                style={{ cursor: "pointer", accentColor: COLORS.ui }}
              />
              Include failure scenarios (engine shutdown, fuel leak, structural, guidance)
            </label>
          </div>

          {/* Failure probability slider — only shown when failures are enabled */}
          {mcConfig.includeFailureScenarios && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                Failure probability:{" "}
                <strong style={{ color: "#ffaa44" }}>
                  {(mcConfig.failureProbability * 100).toFixed(0)}%
                </strong>
                {" "}(~{Math.round(mcConfig.numberOfRuns * mcConfig.failureProbability)} of {mcConfig.numberOfRuns} runs)
              </label>
              <input
                type="range"
                min="0"
                max="0.2"       // 0% to 20% failure probability
                step="0.01"     // 1% increments
                value={mcConfig.failureProbability}
                onChange={e => setMCConfig(prev => ({
                  ...prev,
                  failureProbability: parseFloat(e.target.value),
                }))}
                style={{ width: "100%", cursor: "pointer", accentColor: "#ff8844" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, opacity: 0.5 }}>
                <span>0% (no failures)</span>
                <span>20% (1 in 5 fail)</span>
              </div>
            </div>
          )}

          {/* Action buttons: Run or Cancel */}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            {/* Cancel: dismiss config panel without running */}
            <button
              onClick={() => setShowMCConfig(false)}
              style={{ ...btnStyle(false), padding: "7px 16px", flex: 1 }}
            >
              Cancel
            </button>

            {/* Run: start the simulation batch */}
            <button
              onClick={() => {
                setShowMCConfig(false); // Close config panel

                // Initialize progress tracking
                setMCProgress({ completed: 0, total: mcConfig.numberOfRuns });

                // Clone the current rocket config so the MC simulation uses the same
                // rocket the player just flew (not a stale reference from before reset)
                const configForMC = cloneRocketConfig(rocketConfigRef.current);

                // Start the async Monte Carlo simulation.
                // onProgress: called after each run to update the progress bar.
                // onComplete: called with full results once all runs finish.
                const { cancel } = runMonteCarloSimulation(
                  configForMC,
                  mcConfig,
                  (completed, total) => {
                    // Update progress bar — triggers re-render via React state
                    setMCProgress({ completed, total });
                  },
                  (results) => {
                    // All runs complete — store results and show the panel
                    setMCResults(results);
                    setMCProgress(null);     // Clear progress bar
                    setShowMCPanel(true);    // Open the full results panel
                  }
                );

                // Store cancel handle so Reset can abort the simulation
                mcCancelRef.current = cancel;
              }}
              style={{
                ...btnStyle(true, "#1a5c38"), // Dark green "go" button
                padding: "7px 16px",
                flex:    2,
                fontWeight: "bold",
              }}
            >
              ▶ Run {mcConfig.numberOfRuns} Simulations
            </button>
          </div>
        </div>
      )}

      {/* ── MONTE CARLO PROGRESS BAR ─────────────────────────────────────────── */}
      {/* Shown while simulation is running — a progress bar with run count.
          Positioned in the center-bottom area so it's visible but not intrusive. */}
      {mcProgress !== null && (
        <div
          style={{
            position:        "absolute",
            bottom:          60,
            left:            "50%",
            transform:       "translateX(-50%)", // Center horizontally
            backgroundColor: "rgba(4, 8, 22, 0.95)",
            border:          `1px solid ${COLORS.ui}`,
            borderRadius:    6,
            padding:         "10px 18px",
            minWidth:        260,
            textAlign:       "center",
            zIndex:          20,
            backdropFilter:  "blur(4px)",
            fontFamily:      "monospace",
          }}
        >
          {/* Progress label */}
          <div style={{ fontSize: 12, marginBottom: 6, color: COLORS.trajectory }}>
            Simulating... {mcProgress.completed}/{mcProgress.total} runs complete
          </div>

          {/* Progress bar track */}
          <div
            style={{
              width:           "100%",
              height:          6,
              backgroundColor: "rgba(30, 50, 100, 0.6)",
              borderRadius:    3,
              overflow:        "hidden",
            }}
          >
            {/* Progress bar fill — width proportional to completed / total */}
            <div
              style={{
                width:           `${(mcProgress.completed / mcProgress.total) * 100}%`,
                height:          "100%",
                backgroundColor: COLORS.trajectory, // Cyan fill
                borderRadius:    3,
                transition:      "width 0.2s ease", // Smooth animation as progress updates
              }}
            />
          </div>

          {/* Cancel button */}
          <button
            onClick={() => {
              mcCancelRef.current?.(); // Abort the simulation
              mcCancelRef.current = null;
              setMCProgress(null);     // Clear progress bar
            }}
            style={{
              marginTop:       6,
              padding:         "3px 10px",
              fontSize:        10,
              backgroundColor: "rgba(60, 10, 10, 0.8)",
              color:           "#ff8888",
              border:          "1px solid rgba(200, 60, 60, 0.4)",
              borderRadius:    3,
              cursor:          "pointer",
              fontFamily:      "monospace",
            }}
          >
            ✕ Cancel
          </button>
        </div>
      )}

      {/* ── MONTE CARLO RESULTS PANEL ─────────────────────────────────────────── */}
      {/* Full-screen overlay that appears once all simulation runs complete.
          Contains the trajectory envelope plot, statistics histograms, and run table.
          The playerTrajectoryRef.current contains the player's flight as the gold comparison line. */}
      {showMCPanel && mcResults !== null && (
        <MonteCarloPanel
          results={mcResults}                            // All runs, statistics, and envelope
          playerTrajectory={playerTrajectoryRef.current.length > 0
            ? playerTrajectoryRef.current                // Show player's flight as gold line
            : undefined                                  // No gold line if player trajectory is empty
          }
          onClose={() => setShowMCPanel(false)}          // Return to manual flight view
        />
      )}
    </div>
  );
};
