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
  drawMaxQFlash,
  drawWarningBanner,
  drawStructuralFailureOverlay,
  drawAltitudeMarkers,
  drawLandingTarget,
  type Star,
  type AtmosphericTelemetry, // NEW: data bundle passed to telemetry and rocket draw functions
} from "../utils/drawHelpers";
// drawMaxQFlash: large yellow "MAX-Q" callout shown for 2 seconds at peak dynamic pressure.
// drawWarningBanner: red top-of-screen banner for engine failure and heating warnings.
// drawStructuralFailureOverlay: full-screen red overlay when structural integrity hits 0%.
// AtmosphericTelemetry: interface bundling Mach, Q, Max-Q, G-force, integrity, stagnation temp.

// Import the three new physics systems.
import {
  getMachNumber,     // Mach = speed / local_speed_of_sound — needed for heating and drag telemetry
  getDynamicPressure, // Q = 0.5 × ρ × v² — primary structural load, drives Max-Q callout
  getTemperature,    // ISA temperature at altitude — used for stagnation temp calculation
} from "../physics/AtmosphereModel";

import {
  createStructuralState,    // Factory: fresh 100% integrity state for a new flight
  updateStructuralLimits,   // Per-frame: degrade integrity based on Q, G, and AoA stress
  type StructuralState,     // TypeScript interface for the structural health bundle
} from "../physics/StructuralLimits";

import {
  createEngineFailureState, // Factory: failure state initialized to chosen difficulty
  updateEngineFailures,     // Per-frame: probabilistic failure checks, applies to config
  resetEngineFailures,      // Clears failure history for reset/rocket-change
  type EngineFailureState,  // TypeScript interface for failure tracking
  type DifficultyLevel,     // "safe" | "normal" | "realistic" | "chaos"
} from "../physics/EngineFailureSystem";

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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Convert a numeric landing score (0–100) to an academic letter grade.
 * Used in the landing modal for an immediately-readable quality summary.
 *
 * Grading scale:
 *   97-100 → A+   Perfect: nearly zero impact velocity
 *   93-96  → A    Excellent soft landing
 *   90-92  → A-
 *   87-89  → B+
 *   83-86  → B    Good — reusable with minor inspection
 *   80-82  → B-
 *   77-79  → C+
 *   73-76  → C    Acceptable — hardware survived
 *   70-72  → C-
 *   60-69  → D    Hard landing — significant damage
 *   0-59   → F    Crash — total loss
 */
function getLetterGrade(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 60) return "D";
  return "F";
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

  // ── ATMOSPHERIC & STRUCTURAL PHYSICS REFS ────────────────────────────────
  // These refs are read/written inside the game loop (not React state) so the
  // loop always sees the latest value without re-render overhead.

  // Structural health of the rocket — integrity degrades under Q, G, and AoA stress.
  const structuralStateRef = useRef<StructuralState>(createStructuralState());

  // Engine failure tracking — probabilistic failures based on difficulty.
  const engineFailureStateRef = useRef<EngineFailureState>(createEngineFailureState("normal"));

  // Latest computed atmospheric/structural telemetry bundle, updated every frame.
  // Written in the game loop and passed to drawTelemetry() and drawRocket() each frame.
  const currentAtmoDataRef = useRef<AtmosphericTelemetry>({
    machNumber: 0,           // Mach number (0 at rest on pad)
    dynamicPressure: 0,      // Q in Pa (0 on pad)
    maxDynamicPressure: 0,   // Max Q reached so far (0 at start)
    maxQAltitude: 0,         // Altitude of Max-Q event (0 = not yet reached)
    currentGForce: 0,        // G-force (1G at rest due to gravity)
    structuralIntegrity: 100, // Start at 100% integrity
    stagnationTemperature: 288, // ~ambient sea-level temperature at rest
  });

  // Previous frame's dynamic pressure — used to detect when Q peaks (Max-Q passage).
  // When current Q < prevQ after having been non-trivially high, Max-Q has passed.
  const prevDynamicPressureRef = useRef<number>(0); // Pa — last frame's Q

  // Whether Max-Q passage has been detected this flight (one-shot flag).
  // Prevents multiple Max-Q callouts per flight (Q can temporarily dip and rise again).
  const maxQPassedRef = useRef<boolean>(false); // true = callout already shown

  // Countdown timer for the Max-Q "MAX-Q" flash overlay (seconds remaining).
  // Set to 2.0 when Max-Q is detected; decremented by rawDelta each frame until 0.
  const maxQFlashTimerRef = useRef<number>(0); // s — 0 = not showing, > 0 = fading

  // Active warning banners (engine failure, heating, etc.).
  // Each entry: { message: string, timeLeft: number } — timeLeft counts down to 0.
  const warningBannersRef = useRef<Array<{ message: string; timeLeft: number }>>([]);

  // True once structural integrity hits 0% — renders the structural failure overlay.
  // Latches true and stays true until the player resets.
  const isStructuralFailureRef = useRef<boolean>(false);

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

  // ── MISSION LOG REF ──────────────────────────────────────────────────────────
  // Records key flight events with timestamps for the mission log overlay.
  // Stored as a ref so the game loop can append to it without re-render overhead.
  // Synced to React state every 10 frames so the overlay updates periodically.
  const missionLogRef = useRef<Array<{ time: number; message: string }>>([]);

  // Edge-trigger flags — detect first-time transitions for log events.
  const loggedIgnitionRef  = useRef<boolean>(false); // True after first ignition logged
  const loggedLiftoffRef   = useRef<boolean>(false); // True after first liftoff logged
  const loggedMaxQRef      = useRef<boolean>(false); // True after Max-Q passage logged
  const loggedParaRef      = useRef<boolean>(false); // True after parachute deploy logged
  const prevStageSepRef    = useRef<number>(0);       // Previous stage separation count

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

  // Difficulty setting for engine failure probability (controls EngineFailureSystem).
  // Stored in React state so the top-bar selector re-renders on change.
  // The game loop reads from engineFailureStateRef.current.difficulty (kept in sync below).
  const [difficulty, setDifficulty] = useState<DifficultyLevel>("normal");

  // Audio UI state.
  const [audioMuted,   setAudioMuted]   = useState<boolean>(false);
  const [masterVolume, setMasterVolume] = useState<number>(0.5);

  // Mission log: synced from missionLogRef every 10 frames for the overlay.
  const [missionLog, setMissionLog] = useState<Array<{ time: number; message: string }>>([]);

  // Keyboard shortcuts help overlay (toggle with ? key).
  const [showKeyboardHelp, setShowKeyboardHelp] = useState<boolean>(false);

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

  // Sync difficulty React state → engineFailureStateRef so the game loop always
  // reads the latest difficulty without being in the loop's dependency array.
  // This also updates the .difficulty field on the existing failure state object
  // so in-flight difficulty changes take effect immediately (useful for demos).
  useEffect(() => {
    engineFailureStateRef.current.difficulty = difficulty; // Apply immediately to live state
  }, [difficulty]); // Re-run whenever the player changes the difficulty selector

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
      if (e.key === "Escape") { setShowFullscreenTrajectory(false); setShowKeyboardHelp(false); }
      if (e.key === " ")      e.preventDefault(); // Prevent SPACEBAR from scrolling the page
      if (e.key === "p" || e.key === "P") setShowPerfStats((p) => !p); // Toggle perf stats
      if (e.key === "?" || e.key === "/") setShowKeyboardHelp((h) => !h); // Toggle help overlay
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
            dragCoefficient:   DRAG_COEFFICIENT,   // Legacy field — new drag uses AtmosphereModel
            rocketRadius:      ROCKET_RADIUS,       // 0.5 m cross-section radius
            timeStep:          PHYSICS_TICK_RATE,   // 60 Hz target rate
          },
          subDelta
        );
        performanceMonitorRef.current.endPhysicsTimer();

        // ── ATMOSPHERIC DATA COMPUTATION ─────────────────────────────────
        // Compute all altitude-dependent quantities used by the new systems.
        // These are computed every sub-step so structural/failure checks see current values.

        // Total velocity magnitude (speed) in m/s — √(vx²+vy²).
        // Mach and dynamic pressure both need scalar speed, not the vector components.
        const velMag = Math.sqrt(
          frame.state.velocity.x * frame.state.velocity.x + // Horizontal speed component squared
          frame.state.velocity.y * frame.state.velocity.y   // Vertical speed component squared
        ); // m/s — current total speed of the rocket

        // Mach number at current speed and altitude.
        // Mach = speed / local_speed_of_sound. Depends on altitude because temperature changes.
        const currentMach = getMachNumber(velMag, frame.state.position.y); // dimensionless

        // Dynamic pressure Q = 0.5 × ρ × v² — the primary aerodynamic structural load.
        // This is what "Max-Q" refers to: the single highest Q during the entire flight.
        const currentQ = getDynamicPressure(velMag, frame.state.position.y); // Pa

        // Ambient temperature at this altitude from the ISA model.
        // Used in the stagnation temperature formula below.
        const ambientTemp = getTemperature(frame.state.position.y); // K

        // Stagnation temperature: how hot the nose cone gets from aerodynamic compression.
        // Formula: T_stag = T_ambient × (1 + 0.2 × M²)
        // This is the adiabatic stagnation temperature (isentropic flow assumption).
        // At M=3 and T=220K (stratosphere): T_stag = 220 × (1 + 1.8) = 616 K
        // At M=5 and T=220K: T_stag = 220 × (1 + 5.0) = 1320 K — orange glow territory
        const stagnationTemp = ambientTemp * (1 + 0.2 * currentMach * currentMach); // K

        // ── ENGINE FAILURE CHECK (only on first sub-step to avoid double-triggering) ──
        // Failures are probabilistic events; checking once per frame is sufficient.
        // Checking on every sub-step would artificially inflate failure probability at 10× speed.
        if (step === 0 && frame.state.isFlying) {
          // Run one frame of failure checks — may modify config (shut down engines etc.).
          const newFailures = updateEngineFailures(
            engineFailureStateRef.current, // Failure state (mutated to record new failures)
            config,                         // Rocket config (mutated to apply failures to stages)
            subDelta,                       // Time step for probability calculation
            frame.state.timeElapsed         // Flight time for failure event timestamps
          );

          // For each failure that occurred this frame: add warning banner and play beep.
          for (const failure of newFailures) {
            // Add a 4-second warning banner entry — will be drawn each frame until timeLeft = 0.
            warningBannersRef.current.push({
              message: failure.message, // e.g., "⚠ ENGINE 1 FLAMEOUT — THRUST REDUCED"
              timeLeft: 4.0,            // s — banner persists 4 seconds then fades
            });
            // Play the warning beep sound to alert the player audibly.
            audioManagerRef.current.playSound("warning-beep"); // Audible failure alert
          }
        }

        // ── STRUCTURAL LIMITS UPDATE ──────────────────────────────────────
        // Check if current Q, G-force, or angle of attack is degrading the structure.
        // Only run during flight — no structural stress sitting on the pad.
        if (frame.state.isFlying && !isStructuralFailureRef.current) {
          // Total acceleration magnitude = √(ax²+ay²) — used for G-force calculation.
          const accelMag = Math.sqrt(
            frame.state.acceleration.x * frame.state.acceleration.x + // Ax squared
            frame.state.acceleration.y * frame.state.acceleration.y   // Ay squared
          ); // m/s²

          // Update structural integrity and get breakup flag.
          const brokeApart = updateStructuralLimits(
            structuralStateRef.current, // Structural state (mutated: Q, G, integrity)
            velMag,                     // m/s — total speed for dynamic pressure
            frame.state.position.y,     // m — altitude for air density lookup
            accelMag,                   // m/s² — for G-force calculation
            frame.state.angle,          // rad — tilt angle for AoA check
            currentMach,                // dimensionless — for supersonic AoA damage scaling
            frame.state.timeElapsed,    // s — flight time for Max-Q timestamp
            subDelta                    // s — time step for damage rate integration
          );

          // Handle catastrophic structural failure (integrity hit 0%).
          if (brokeApart) {
            isStructuralFailureRef.current = true; // Latch the failure flag permanently

            // Force the rocket into a "landed" state to stop physics simulation.
            frame.state.hasLanded = true; // Mark as having "touched down" (ends physics)
            frame.state.isFlying = false;  // Clear flying flag

            // Big warning banner — structural failure is catastrophic.
            warningBannersRef.current.push({
              message: "⚠ STRUCTURAL FAILURE — MAX-Q EXCEEDED — VEHICLE BREAK-UP",
              timeLeft: 10.0, // s — show this banner for a full 10 seconds
            });
            // Play hard landing (crash) sound as a proxy for breakup sound.
            audioManagerRef.current.playSound("landing-hard"); // Closest available sound
            audioManagerRef.current.stopSound("engine-thrust"); // Stop engine roar
            engineSoundPlayingRef.current = false; // Mark engine sound as stopped
          }

          // ── AERODYNAMIC HEATING WARNING ───────────────────────────────────
          // If stagnation temperature exceeds 2000 K (material failure threshold),
          // add a warning banner. Only add it once per second to avoid spamming.
          if (stagnationTemp > 2000 && step === 0) {
            // Check if there's already an active heating warning to avoid duplicates.
            const hasHeatingWarning = warningBannersRef.current.some(
              (w) => w.message.includes("AERODYNAMIC HEATING") // Look for existing heating banner
            );
            if (!hasHeatingWarning) {
              // Add the heating warning banner — appears at top of screen in red.
              warningBannersRef.current.push({
                message: "⚠ AERODYNAMIC HEATING — NOSE CONE TEMPERATURE CRITICAL",
                timeLeft: 3.0, // s — 3-second warning banner duration
              });
            }
          }
        }

        // ── MAX-Q PASSAGE DETECTION (first sub-step only) ─────────────────
        // Detect when the rocket has passed through its peak dynamic pressure.
        // Max-Q is detected when Q starts falling after having risen above a threshold.
        // We compare current Q to the previous frame's Q to detect the peak.
        if (step === 0 && frame.state.isFlying && !maxQPassedRef.current) {
          const prevQ = prevDynamicPressureRef.current; // Previous frame's Q

          // Max-Q passed: Q is now falling (< previous frame), was above 5 kPa (meaningful),
          // and hasn't been called out yet this flight.
          if (currentQ < prevQ && prevQ > 5000) {
            maxQPassedRef.current = true;        // Mark Max-Q as passed for this flight
            maxQFlashTimerRef.current = 2.0;     // Start 2-second "MAX-Q" flash display
          }
          prevDynamicPressureRef.current = currentQ; // Remember Q for next frame comparison
        }

        // ── UPDATE ATMOSPHERIC TELEMETRY BUNDLE ───────────────────────────
        // Write the latest computed values into the bundle ref so the render
        // section (outside the sub-step loop) can pass them to drawTelemetry.
        // We update on every sub-step so the display is always current.
        currentAtmoDataRef.current = {
          machNumber:           currentMach,  // Current Mach number
          dynamicPressure:      currentQ,     // Current Q in Pa
          maxDynamicPressure:   structuralStateRef.current.maxDynamicPressure, // Peak Q Pa
          maxQAltitude:         structuralStateRef.current.maxQAltitude,       // Peak Q altitude
          currentGForce:        structuralStateRef.current.currentAccelerationG, // G-force
          structuralIntegrity:  structuralStateRef.current.structuralIntegrity,  // %
          stagnationTemperature: stagnationTemp, // K — nose cone temperature
        };

        // ── MISSION LOG EVENT DETECTION (first sub-step only) ────────────────
        if (step === 0) {
          const t = frame.state.timeElapsed; // Current mission elapsed time (seconds)

          // IGNITION: first time throttle goes above zero
          const activeStgForLog = config.stages.find((s) => s.isActive && !s.isSeparated);
          if (!loggedIgnitionRef.current && activeStgForLog && activeStgForLog.thrustPercentage > 0) {
            loggedIgnitionRef.current = true;
            missionLogRef.current.push({ time: t, message: "IGNITION" });
          }

          // LIFTOFF: first time rocket actually leaves the ground (upward velocity)
          if (!loggedLiftoffRef.current && frame.state.isFlying && frame.state.velocity.y > 2) {
            loggedLiftoffRef.current = true;
            missionLogRef.current.push({ time: t, message: "LIFTOFF" });
          }

          // STAGING: detect new stage separations by comparing count
          if (frame.state.stageSeparationCount > prevStageSepRef.current) {
            const stageNum = frame.state.stageSeparationCount;
            missionLogRef.current.push({ time: t, message: `STAGE ${stageNum} SEP` });
            prevStageSepRef.current = frame.state.stageSeparationCount;
          }

          // MAX-Q PASSAGE: when maxQPassedRef flips to true
          if (!loggedMaxQRef.current && maxQPassedRef.current) {
            loggedMaxQRef.current = true;
            const qKpa = (currentAtmoDataRef.current.maxDynamicPressure / 1000).toFixed(1);
            missionLogRef.current.push({ time: t, message: `MAX-Q ${qKpa} kPa` });
          }

          // PARACHUTE DEPLOY
          if (!loggedParaRef.current && parachuteDeployedRef.current) {
            loggedParaRef.current = true;
            missionLogRef.current.push({ time: t, message: "CHUTE DEPLOYED" });
          }
        }

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

          // Log the touchdown event with landing velocity
          const landV = Math.abs(frame.state.landingVelocity).toFixed(1);
          missionLogRef.current.push({
            time: frame.state.timeElapsed,
            message: `TOUCHDOWN ${landV} m/s`,
          });

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

      // ── WARNING BANNER TIMER DECAY (real time) ──────────────────────────
      // Decrement each warning banner's remaining display time by the wall-clock delta.
      // We use rawDelta (real seconds) not gameDelta so banners always fade at the
      // same real-world speed regardless of the time multiplier the player has set.
      warningBannersRef.current = warningBannersRef.current
        .map((w) => ({ ...w, timeLeft: w.timeLeft - rawDelta })) // Decrement each banner's timer
        .filter((w) => w.timeLeft > 0); // Remove banners whose timers have expired

      // ── MAX-Q FLASH TIMER DECAY (real time) ─────────────────────────────
      // Count down the Max-Q flash overlay timer toward 0.
      // When it reaches 0 the flash stops rendering (drawMaxQFlash is not called).
      if (maxQFlashTimerRef.current > 0) {
        maxQFlashTimerRef.current -= rawDelta; // Decrement at wall-clock speed
      }

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

      // 3a. Landing target bullseye circles centered on launch pad (x=0, y=0).
      // Only visible when the camera can see the ground area.
      drawLandingTarget(ctx, cw, ch, camera);

      // 4. Exhaust particles and stage-separation burst.
      particleSystemRef.current.draw(ctx, camera, cw, ch);

      // 5. Goal altitude indicator line.
      const goalAlt  = customGoalAltitudeRef.current ?? selectedGoalRef.current?.altitude ?? 0;
      const goalName = customGoalAltitudeRef.current
        ? "Custom"
        : (selectedGoalRef.current?.name ?? "");
      if (goalAlt > 0) drawGoalLine(ctx, cw, ch, camera, goalAlt, goalName);

      // 6. Rocket body with aerodynamic heating glow at high Mach numbers.
      // Pass currentMach from the latest atmospheric data so the glow renders
      // at the correct intensity — orange at Mach 3, white-hot at Mach 5+.
      drawRocket(
        ctx, cw, ch, camera, state,
        rocketConfigRef.current,
        parachuteRef.current,
        landingGearRef.current,
        currentAtmoDataRef.current.machNumber // NEW: Mach number for heating glow
      );

      // 7. Extended telemetry HUD with atmospheric and structural readings.
      // Passes the full AtmosphericTelemetry bundle so the panel shows MACH, Q,
      // MAX-Q, G-force, structural integrity %, and stagnation temperature.
      const activeMult = isPausedRef.current ? 0 : timeMultiplierRef.current;
      drawTelemetry(
        ctx, cw, ch, state, rocketConfigRef.current,
        activeMult, isPausedRef.current,
        currentAtmoDataRef.current // NEW: atmospheric/structural telemetry bundle
      );

      // 8. Max-Q flash overlay — shown for 2 seconds after peak dynamic pressure.
      // Alpha is clamped to 1.0 at the start of the timer and fades as it counts down.
      // Only drawn while the timer is positive (i.e., while the flash is active).
      if (maxQFlashTimerRef.current > 0) {
        const flashAlpha = Math.min(1.0, maxQFlashTimerRef.current); // Fade as timer → 0
        drawMaxQFlash(ctx, cw, ch, flashAlpha); // Draw the "MAX-Q" callout text
      }

      // 9. Warning banners — stack from top, most recent shown first.
      // Each banner has its own alpha derived from its remaining display time.
      // We show up to 3 banners simultaneously (stacked 34px apart vertically).
      const visibleBanners = warningBannersRef.current.slice(-3); // Show up to 3 most recent
      visibleBanners.forEach((banner, idx) => {
        // Alpha: fully opaque until last 1 second, then fades out.
        const bannerAlpha = Math.min(1.0, banner.timeLeft); // 0–1 opacity
        const yOffset = 50 + idx * 34; // Stack banners 34px apart, below top control bar
        drawWarningBanner(ctx, cw, banner.message, bannerAlpha, yOffset);
      });

      // 10. Structural failure overlay — shown when integrity reaches 0%.
      // Drawn on top of everything once latched (persists until Reset).
      if (isStructuralFailureRef.current) {
        drawStructuralFailureOverlay(ctx, cw, ch); // Red overlay with failure message
      }

      // 11a. Altitude markers ribbon on the right edge.
      // Drawn after all world-space elements but before DOM-overlaid HUD elements.
      drawAltitudeMarkers(ctx, cw, ch, camera);

      // 11. Debug performance panel (top-left, toggle with P key).
      // Drawn last so it appears on top of every other overlay.
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

        // Sync mission log to React state (only if it has changed recently).
        // We snapshot the last 8 entries — enough to show all key flight events.
        const logSnapshot = missionLogRef.current.slice(-8);
        setMissionLog([...logSnapshot]);
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

    // ── RESET NEW PHYSICS SYSTEMS ─────────────────────────────────────────
    // Clear structural state — fresh 100% integrity for the new flight.
    structuralStateRef.current = createStructuralState(); // New structural state

    // Clear engine failures — reset history, stuck throttles, pump failures.
    // Preserves the current difficulty setting the player selected.
    resetEngineFailures(engineFailureStateRef.current); // Clears failure history

    // Reset atmospheric telemetry bundle to ground-level defaults.
    currentAtmoDataRef.current = {
      machNumber: 0,            // Mach 0 on the pad
      dynamicPressure: 0,       // Q = 0 on the pad
      maxDynamicPressure: 0,    // No Max-Q recorded yet
      maxQAltitude: 0,          // No Max-Q altitude recorded
      currentGForce: 0,         // No G-force at rest
      structuralIntegrity: 100, // Full integrity
      stagnationTemperature: 288, // ~sea-level ambient temperature
    };

    // Reset Max-Q tracking.
    prevDynamicPressureRef.current = 0;  // No previous Q
    maxQPassedRef.current = false;       // Max-Q not yet detected for new flight
    maxQFlashTimerRef.current = 0;       // Clear any active flash timer

    // Clear all warning banners from previous flight.
    warningBannersRef.current = []; // Empty banner queue

    // Clear structural failure latch — rocket is intact for the new flight.
    isStructuralFailureRef.current = false; // No structural failure

    // Reset mission log for the new flight.
    missionLogRef.current = [];
    setMissionLog([]);
    loggedIgnitionRef.current  = false;
    loggedLiftoffRef.current   = false;
    loggedMaxQRef.current      = false;
    loggedParaRef.current      = false;
    prevStageSepRef.current    = 0;

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

    // ── RESET NEW PHYSICS SYSTEMS on rocket change ──────────────────────
    // A different rocket type means a clean new flight — reset all new systems.
    structuralStateRef.current = createStructuralState(); // Fresh structure
    resetEngineFailures(engineFailureStateRef.current);   // Clear failure history
    currentAtmoDataRef.current = { // Reset atmospheric bundle to ground defaults
      machNumber: 0, dynamicPressure: 0, maxDynamicPressure: 0,
      maxQAltitude: 0, currentGForce: 0, structuralIntegrity: 100,
      stagnationTemperature: 288,
    };
    prevDynamicPressureRef.current = 0;  // No previous Q
    maxQPassedRef.current = false;       // Max-Q detection reset
    maxQFlashTimerRef.current = 0;       // Clear flash timer
    warningBannersRef.current = [];      // Clear all warning banners
    isStructuralFailureRef.current = false; // Clear structural failure flag
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

        {/* Difficulty selector — controls engine failure probability */}
        {/* "safe"=no failures, "normal"=30% base, "realistic"=full, "chaos"=10× */}
        <div style={controlGroupStyle}>
          <span>Failures:</span>
          <select
            value={difficulty} // Controlled by React state
            onChange={(e) => setDifficulty(e.target.value as DifficultyLevel)} // Update state on change
            style={selectStyle}
            title="Engine failure probability: Safe=none, Normal=30%, Realistic=full, Chaos=10×"
          >
            <option value="safe">Safe (no failures)</option>
            <option value="normal">Normal (30%)</option>
            <option value="realistic">Realistic</option>
            <option value="chaos">Chaos (10×)</option>
          </select>
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

        {/* Key hint — updated to mention Max-Q and failure difficulty */}
        <div style={{ marginLeft: "auto", fontSize: "11px", opacity: 0.6 }}>
          SPACE=thrust · A/D=steer · 0-4=speed · P=perf · M=mute · Watch MAX-Q!
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

          {/* Score — big colored number alongside letter grade */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "16px", margin: "8px 0" }}>
            <div style={{
              fontSize: "48px",
              fontWeight: "bold",
              color: landingScore >= 80 ? "#44ff44" : landingScore >= 50 ? "#ffaa00" : "#ff4444",
            }}>
              {landingScore.toFixed(0)}<span style={{ fontSize: "20px" }}>/100</span>
            </div>
            {/* Letter grade — large, color-matched, right of the numeric score */}
            <div style={{
              fontSize: "42px",
              fontWeight: "bold",
              color: landingScore >= 80 ? "#44ff44" : landingScore >= 50 ? "#ffaa00" : "#ff4444",
              borderLeft: "2px solid rgba(74,111,165,0.5)",
              paddingLeft: "16px",
            }}>
              {getLetterGrade(landingScore)}
            </div>
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

      {/* ── MISSION LOG PANEL ────────────────────────────────────────────────── */}
      {/* Shows key flight events (Ignition, Liftoff, Staging, Max-Q, etc.) with
          elapsed mission time in T+HH:MM:SS format. Positioned bottom-right above
          the telemetry HUD so it doesn't overlap controls. */}
      {missionLog.length > 0 && !showMCPanel && (
        <div
          style={{
            position:        "absolute",
            bottom:          "220px",
            right:           "12px",
            width:           "180px",
            backgroundColor: "rgba(4, 8, 22, 0.75)",
            border:          `1px solid rgba(74, 111, 165, 0.4)`,
            borderRadius:    "4px",
            padding:         "6px 8px",
            fontFamily:      "monospace",
            fontSize:        "10px",
            zIndex:          10,
            backdropFilter:  "blur(2px)",
          }}
        >
          {/* Panel title */}
          <div style={{ color: COLORS.trajectory, fontWeight: "bold", marginBottom: "4px", fontSize: "9px", letterSpacing: "1px" }}>
            MISSION LOG
          </div>
          {/* Log entries — newest at the bottom (chronological order) */}
          {missionLog.map((entry, i) => {
            const t = entry.time;
            const h = Math.floor(t / 3600);
            const m = Math.floor((t % 3600) / 60);
            const s = (t % 60).toFixed(0).padStart(2, "0");
            const timeStr = h > 0
              ? `T+${h}:${String(m).padStart(2,"0")}:${s}`
              : `T+${String(m).padStart(2,"0")}:${s}`;
            return (
              <div key={i} style={{ display: "flex", gap: "6px", color: "rgba(180, 210, 240, 0.9)", paddingBottom: "2px" }}>
                <span style={{ color: "rgba(100, 150, 200, 0.7)", minWidth: "50px" }}>{timeStr}</span>
                <span>{entry.message}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── KEYBOARD SHORTCUTS HELP OVERLAY ──────────────────────────────────── */}
      {/* Toggles with ? or / key. Shows all keyboard controls in a centered panel.
          ESC or clicking outside also closes it. */}
      {showKeyboardHelp && (
        <div
          onClick={() => setShowKeyboardHelp(false)} // Click backdrop to dismiss
          style={{
            position:        "fixed",
            inset:           0,
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            zIndex:          50,
            display:         "flex",
            alignItems:      "center",
            justifyContent:  "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()} // Prevent click-through to backdrop
            style={{
              backgroundColor: "rgba(5, 10, 30, 0.97)",
              border:          `2px solid ${COLORS.ui}`,
              borderRadius:    "6px",
              padding:         "20px 28px",
              minWidth:        "360px",
              fontFamily:      "monospace",
              color:           COLORS.text,
              backdropFilter:  "blur(8px)",
            }}
          >
            <h3 style={{ margin: "0 0 14px 0", color: COLORS.trajectory, fontSize: "15px" }}>
              Keyboard Shortcuts
            </h3>
            {/* Shortcut table */}
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <tbody>
                {([
                  ["SPACE",       "Apply thrust burst"],
                  ["A / ←",       "Steer left"],
                  ["D / →",       "Steer right"],
                  ["0",           "Pause / Resume"],
                  ["1",           "1× speed"],
                  ["2",           "2× speed"],
                  ["3",           "5× speed"],
                  ["4",           "10× speed"],
                  ["P",           "Toggle performance stats"],
                  ["M",           "Toggle audio mute"],
                  ["? or /",      "This help screen"],
                  ["ESC",         "Close panels"],
                ] as [string, string][]).map(([key, desc]) => (
                  <tr key={key}>
                    <td style={{ padding: "3px 0", width: "90px" }}>
                      <span style={{
                        display:         "inline-block",
                        backgroundColor: "rgba(74, 111, 165, 0.25)",
                        border:          `1px solid ${COLORS.ui}`,
                        borderRadius:    "3px",
                        padding:         "1px 6px",
                        fontWeight:      "bold",
                        color:           COLORS.trajectory,
                        fontSize:        "11px",
                      }}>
                        {key}
                      </span>
                    </td>
                    <td style={{ padding: "3px 0", color: "rgba(200, 215, 240, 0.85)" }}>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: "14px", fontSize: "10px", opacity: 0.5, textAlign: "center" }}>
              Press ? or ESC to close
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
