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
  getStageFuelStatus,
} from "../physics/engine";

import { useTelemetryStore } from "../store/telemetryStore";
import { TelemetryDashboard } from "./dashboard/TelemetryDashboard";
import type { MultiStageRocketState } from "../physics/engine";

// TrajectoryPanel removed in favor of TelemetryDashboard
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
  DEBUG_MODE,
} from "../utils/constants";

import {
  ROCKET_FALCON_9_INSPIRED,
  ROCKET_SIMPLE_TWO_STAGE,
  ROCKET_THREE_STAGE,
  type MultiStageRocketConfig,
  resetAllStages,
  calculateTotalMass,
  calculateTotalThrust,
} from "../physics/MultiStageSystem";

import type { AltitudeGoal } from "../physics/types";

import {
  generateStars,
  drawBackground,
  drawStars,
  drawGrid,
  drawGround,
  drawGoalLine,
  drawRocket,
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
  getAirDensity,     // ρ(h) — air density at altitude, used for separated stage drag calculation
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

// ─── LOCALSTORAGE KEY CONSTANTS ──────────────────────────────────────────────
// These must match the constants in RocketBuilder.tsx so saves written there
// are readable here without any shared module (both files define the same strings).

/** Registry key: JSON array of { id, name, timestamp } for all saved custom rockets. */
const REGISTRY_KEY = "rocket_custom_list";

/** Per-rocket config key prefix: full config stored at `rocket_custom_${id}`. */
const STORAGE_KEY_PREFIX = "rocket_custom_";

/** Active launch key: the most recently launched custom config from the builder. */
const ACTIVE_ROCKET_KEY = "rocket_custom_active";

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * Metadata entry in the rocket_custom_list registry.
 * One entry per saved custom rocket; the full config is stored separately at
 * `rocket_custom_${id}` to keep the registry small and fast to read.
 */
interface CustomRocketEntry {
  id: string;        // Unique key suffix; full key = STORAGE_KEY_PREFIX + id
  name: string;      // User-given name (displayed in the dropdown with "★" prefix)
  timestamp: number; // Unix ms when saved (used for display and sort order)
}

/**
 * Physics state for a rocket stage that has separated from the main vehicle.
 *
 * When a stage separates (fuel exhausted → staging event), it doesn't vanish.
 * Instead it becomes an independent ballistic object subject to gravity and drag.
 * If it has a parachute (or if we create one automatically), it can slow its descent
 * and land safely — just like Falcon 9 booster recovery.
 *
 * This interface holds ALL state needed to simulate and render the separated stage.
 */
interface SeparatedStageState {
  stageNumber: number;           // Which stage this was (config.stages[i].stageNumber)
  stageName: string;             // Human-readable name (e.g., "Stage 1") for HUD display
  position: { x: number; y: number }; // World-space position in meters (x=east of pad, y=altitude)
  velocity: { x: number; y: number }; // World-space velocity in m/s
  mass: number;                  // Dry mass in kg — all fuel is gone when the stage separates
  parachute: Parachute;         // Parachute state — deployed when descending fast enough
  parachuteDeployed: boolean;   // True after deployParachute() has been called (one-shot edge trigger)
  hasLanded: boolean;            // True once position.y ≤ 0 (stage has hit the ground)
  landingVelocity: number;       // m/s (negative = downward) at the moment of ground contact
  landingX: number;              // x-coordinate (meters east of pad) where the stage landed
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Read all saved custom rockets from localStorage and return them as an array.
 * Returns an empty array if the registry is missing, empty, or corrupted.
 * Never throws — all errors are silently caught so the simulator doesn't crash.
 */
function loadCustomRocketsFromStorage(): CustomRocketEntry[] {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY); // Read the registry JSON string
    if (!raw) return []; // Registry doesn't exist yet (first-time user): return empty array
    const parsed = JSON.parse(raw) as CustomRocketEntry[]; // Deserialize the array
    // Validate: must be an array (guard against corrupted localStorage or old formats)
    if (!Array.isArray(parsed)) return [];
    // Filter out entries with missing required fields to guard against partial corruption
    return parsed.filter(
      (e) => typeof e.id === "string" && typeof e.name === "string" && typeof e.timestamp === "number"
    );
  } catch {
    return []; // JSON parse error or localStorage unavailable: return empty array gracefully
  }
}

/**
 * Compute a build quality score (0.0 – 1.0) for a given rocket config.
 * Used when the user DOESN'T have a saved buildQualityScore (e.g., preset rockets).
 *
 * Pre-built presets (Falcon 9, Three-Stage, Simple) return the base preset quality of 0.82,
 * which corresponds to a well-tested aerospace design with standard failure rates.
 * Custom builds should already have buildQualityScore set in their config; this function
 * is the fallback when that field is missing.
 *
 * Quality → Failure probability:  failureProb = (1 - quality) × 0.35
 *   0.95 → ~1.75% failure (excellent design)
 *   0.82 → ~6.3%  failure (solid preset / well-built custom)
 *   0.70 → ~10.5% failure (mediocre design, several missing parts)
 *   0.30 → ~24.5% failure (worst case, barely flyable)
 *
 * @param config  The rocket config to assess (uses name and stage count heuristics)
 * @returns       Quality score in [0.30, 0.95]
 */
function computeBuildQuality(config: MultiStageRocketConfig): number {
  // If the builder embedded a quality score when constructing this config, use it.
  // This is the authoritative value computed from actual part-level design checks.
  if (typeof config.buildQualityScore === "number") {
    return config.buildQualityScore; // Trust the builder's assessment over heuristics
  }

  // Fallback heuristic for configs that don't have an embedded score (e.g., presets).
  // Pre-built presets are known-good, well-tested designs → assign the aerospace standard quality.
  const PRESET_NAMES = ["Simple Two-Stage", "Falcon 9 Inspired", "Three-Stage Heavy"];
  if (PRESET_NAMES.includes(config.name)) {
    return 0.82; // Known-good preset quality: ~6.3% Monte Carlo failure rate, realistic aerospace
  }

  // For custom configs without an embedded score (shouldn't happen with current builder,
  // but could occur if the user somehow creates a config object directly), apply a modest
  // quality based on the number of stages (more stages = more complex = slightly lower quality).
  const stageCount = config.stages.length;
  if (stageCount >= 3) return 0.70; // Three-stage: more staging events = more failure opportunities
  if (stageCount === 2) return 0.75; // Two-stage: one staging event
  return 0.78;                       // Single-stage: simple but limited Δv
}

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

  // ── AUTO-FLY SYSTEM REFS ──────────────────────────────────────────────────
  // The auto-fly system follows an automated flight profile without any player input.
  // It replaces manual spacebar/steering controls when active.

  // Whether auto-fly autopilot is currently engaged. Written by both the keydown
  // handler (F key toggle) and the game loop (manual override disables it).
  // The game loop reads this ref — it never reads React state directly.
  const autoFlyEnabledRef = useRef<boolean>(false); // true = autopilot active

  // Mission elapsed time (state.timeElapsed) when auto-fly was most recently activated.
  // Used to compute the "time since auto-fly start" (T+0 in the flight profile).
  // Gravity turn starts at T+10s, so this ref tells us when T+0 was.
  const autoFlyStartTimeRef = useRef<number>(0); // seconds — state.timeElapsed at activation

  // Current auto-fly phase description, updated every physics frame.
  // Passed to drawTelemetry so the HUD shows "MODE: AUTO-FLY (Gravity Turn 23°)" etc.
  // Examples: "AUTO-FLY (Throttle Up)", "AUTO-FLY (Gravity Turn 34°)", "AUTO-FLY (Coast)"
  const autoFlyStatusRef = useRef<string>("MANUAL"); // string displayed in MODE telemetry row

  // Whether the player manually overrode auto-fly this frame (spacebar or A/D pressed).
  // When true, auto-fly disengages and manual control resumes. F key re-engages.
  // This ref is only used for detecting mid-flight manual intervention.
  const autoFlyManualOverrideRef = useRef<boolean>(false); // true = player took manual control

  // ── SEPARATED STAGE REFS ──────────────────────────────────────────────────────
  // Separated stages are rocket stages that have been jettisoned and are now
  // independent physics objects falling back to Earth. They are tracked in refs
  // (not React state) so the game loop can read/write them without re-render overhead.

  // Array of all stages that have separated from the main vehicle this flight.
  // Each entry is independently simulated: gravity + drag + parachute each frame.
  // Cleared on reset and on rocket change (new flight = no prior separated stages).
  const separatedStagesRef = useRef<SeparatedStageState[]>([]);

  // Set of stageNumbers that were already separated at the start of each frame.
  // Used to detect NEWLY separated stages: isSeparated && !prevSeparatedStageNumbers.has(stageNumber).
  // Without this, the same stage would be detected as "newly separated" on every frame.
  const prevSeparatedStageNumbersRef = useRef<Set<number>>(new Set());

  // ── REACT STATE (for DOM / UI rendering) ─────────────────────────────────────

  // Current rocket config used for the select box and reset logic.
  // The actual physics-active config lives in rocketConfigRef.
  const [rocketConfig, setRocketConfig] = useState<MultiStageRocketConfig>(
    rocketConfigRef.current // Initially matches the ref
  );

  // ── CUSTOM ROCKET SELECTOR STATE ──────────────────────────────────────────────
  // These two state values manage the rocket-selector dropdown and its options.

  // List of saved custom rockets loaded from localStorage.
  // Populated on mount and refreshed when a custom rocket is saved/deleted.
  // Each entry provides the id needed to load the full config from localStorage.
  const [savedCustomRockets, setSavedCustomRockets] = useState<CustomRocketEntry[]>([]);

  // The value currently selected in the rocket dropdown.
  // For presets: value = preset name (e.g., "Simple Two-Stage")
  // For custom: value = "custom:${id}" (e.g., "custom:1716518400000_MyFalcon9")
  // For an active (just-launched) custom build: value = "custom:active"
  // We store this separately from rocketConfig.name because custom configs may have
  // the same name "Custom Build" but different ids, making name alone ambiguous.
  const [selectedRocketKey, setSelectedRocketKey] = useState<string>(() => {
    // Lazy initializer: compute the initial key based on initialConfig prop.
    // If a custom config was passed from the builder, the key is "custom:active".
    // If it's one of the 3 presets (or no config), the key is the preset name.
    if (initialConfig) {
      const presetNames = ["Simple Two-Stage", "Falcon 9 Inspired", "Three-Stage Heavy"];
      // Check if the provided config is one of the known presets by name.
      // If it IS a preset, use the preset name as the key so the select shows it correctly.
      // If it is NOT (i.e., a custom build from the builder), use "custom:active".
      return presetNames.includes(initialConfig.name) ? initialConfig.name : "custom:active";
    }
    // No initialConfig provided: start with Simple Two-Stage (the default shown on fresh load).
    return rocketConfigRef.current.name; // Will be "Simple Two-Stage" (the default clone)
  });

  // Whether the "Manage Saved Rockets" modal is open.
  // This modal shows the list of saved custom rockets with Delete buttons.
  // Opened via a button next to the custom section in the dropdown.
  const [showSaveManager, setShowSaveManager] = useState<boolean>(false);

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

  // Display copy of flight state — synced from flightStateRef every few frames.
  // Used by overlay UI that needs flight data (landing modal, etc.).
  const [displayFlightState, setDisplayFlightState] = useState<MultiStageRocketState>(
    () => flightStateRef.current // Lazy initializer so it starts correct
  );

  // Whether to show the debug performance stats panel (toggled by P key).
  const [showPerfStats, setShowPerfStats] = useState<boolean>(DEBUG_MODE);

  // Whether the fullscreen trajectory view is open.

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

  // ── AUTO-FLY STATE (for React UI rendering only) ─────────────────────────────
  // React state is only used for the top-bar button appearance ("AUTO-FLY: ON/OFF").
  // The game loop reads autoFlyEnabledRef — never this React state — to avoid
  // stale closure issues inside the rAF callback.
  // autoFlyDisplayStatus is intentionally NOT stored in React state — the canvas
  // HUD reads autoFlyStatusRef.current directly inside the rAF loop, which is always
  // current without needing a React re-render cycle. The ref is the source of truth.

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

  // ── CUSTOM ROCKET LOAD ON MOUNT ──────────────────────────────────────────────
  // On mount, read saved custom rockets from localStorage and populate the dropdown.
  // Also persist the initialConfig (if provided) to the active key so it survives
  // page refreshes even before the user explicitly saves.
  useEffect(() => {
    // Step 1: Load the saved custom rockets list for the dropdown.
    const rockets = loadCustomRocketsFromStorage(); // Read rocket_custom_list registry
    setSavedCustomRockets(rockets); // Populate dropdown options with saved rockets
    if (DEBUG_MODE) {
      console.log("[RocketSimulator] Mount: loaded", rockets.length, "custom rockets from registry:", rockets);
    }

    // Step 2: If an initialConfig was provided (from builder launch), save it to
    // rocket_custom_active so it persists after a page refresh.
    // Without this, refreshing the page after launching from builder would revert to default.
    if (initialConfig) {
      try {
        localStorage.setItem(ACTIVE_ROCKET_KEY, JSON.stringify(initialConfig));
        if (DEBUG_MODE) {
          console.log("[RocketSimulator] Mount: persisted initialConfig to active key:", initialConfig.name);
        }
      } catch (err) {
        if (DEBUG_MODE) console.warn("[RocketSimulator] Mount: could not persist initialConfig:", err);
      }
    }
  }, []); // Empty deps: run once on mount (reads are safe to do once at startup)

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
      if (e.key === " ")      e.preventDefault(); // Prevent SPACEBAR from scrolling the page
      if (e.key === "p" || e.key === "P") setShowPerfStats((p) => !p); // Toggle perf stats
      if (e.key === "?" || e.key === "/") setShowKeyboardHelp((h) => !h); // Toggle help overlay
      if (e.key === "m" || e.key === "M") { // Toggle audio mute
        const muted = audioManagerRef.current.toggleMute();
        setAudioMuted(muted);
        audioManagerRef.current.playSound("ui-click");
      }

      // ── AUTO-FLY TOGGLE (F key) ──────────────────────────────────────────
      // F key toggles the autopilot. When enabled, the rocket follows an automated
      // flight profile: throttle ramp → vertical ascent → gravity turn → coast →
      // optional landing burn. Manual spacebar/A/D presses disengage auto-fly;
      // pressing F again re-engages it from the current flight state.
      if (e.key === "f" || e.key === "F") {
        // Compute the new enabled state (toggle from current ref, not React state,
        // to avoid stale closure — the ref is always current).
        const newEnabled = !autoFlyEnabledRef.current;
        autoFlyEnabledRef.current = newEnabled; // Update the ref the game loop reads

        if (newEnabled) {
          // Auto-fly is being ENGAGED. Record the current mission elapsed time so
          // the flight profile starts from "T+0 since auto-fly activation".
          // If the rocket is already flying, the gravity turn will begin 10s later;
          // if it hasn't launched yet, T+0 marks ignition in the auto-fly profile.
          autoFlyStartTimeRef.current = flightStateRef.current.timeElapsed;
          autoFlyManualOverrideRef.current = false; // Clear any previous manual override
          autoFlyStatusRef.current = "AUTO-FLY (Throttle Up)"; // Initial phase label
        } else {
          // Auto-fly is being DISENGAGED (returning to full manual control).
          // The rocket keeps its current velocity/angle — we just stop commanding it.
          autoFlyStatusRef.current = "MANUAL"; // HUD returns to manual mode display
        }

        // Sync to React state so the top-bar button re-renders with the correct label.
        audioManagerRef.current.playSound("ui-click"); // Audible confirmation click
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
        // spacebar / tiltLeft / tiltRight may be overridden by auto-fly below.
        let spacebar  = keysPressed.current[" "] ?? false;       // Thrust (may be overridden by auto-fly)
        const clickBurst = keysPressed.current["mouseClick"] ?? false; // Click burst (one-shot)
        let tiltLeft  = (keysPressed.current["a"] ?? false) ||
                        (keysPressed.current["arrowleft"] ?? false); // Steer left (may be overridden)
        let tiltRight = (keysPressed.current["d"] ?? false) ||
                        (keysPressed.current["arrowright"] ?? false); // Steer right (may be overridden)

        // ── AUTO-FLY LOGIC ────────────────────────────────────────────────
        // When auto-fly is enabled, override the manual key inputs with computed
        // autopilot commands. The autopilot follows a programmed flight profile:
        //
        //   T+0s to T+2s:   Throttle-up phase — hold spacebar true so throttle ramps
        //                   from 0% to 100% at 50%/s (takes exactly 2 seconds).
        //   T+2s to T+10s:  Vertical ascent — hold 100% throttle, angle = 0° (straight up).
        //   T+10s to T+70s: Gravity turn — hold 100% throttle, tilt from 0° to 45° over
        //                   60 seconds. This is how real rockets fly — tilting sideways
        //                   gradually to build horizontal orbital velocity.
        //   T+70s onward:   Orbital burn — hold 45° angle with full throttle until fuel runs out.
        //   After fuel:     Coast phase — no throttle, conserve angle.
        //   Descending <5km: Parachute auto-deploys (handled by existing parachute logic).
        //   Descending <2km: Landing burn — re-ignite with retrograde (straight up) thrust.
        //
        // Manual override: if the player presses spacebar or A/D WHILE auto-fly is active,
        // auto-fly is disengaged immediately and control returns to the player. They must
        // press F again to re-engage auto-fly.
        //
        // Angle control: instead of modifying tiltLeft/tiltRight (which add angular velocity
        // incrementally), we use a proportional controller AFTER updatePhysics() below to
        // directly drive state.angularVelocity toward the desired angle. This gives precise,
        // predictable attitude control without fighting the existing damping/restoring system.
        let autoFlyTargetAngle = 0;     // Desired rocket angle this frame (radians from vertical)
        let autoFlyPhaseLabel = "MANUAL"; // Human-readable phase name for the HUD MODE row

        if (autoFlyEnabledRef.current) {
          // Check if the player just grabbed manual control (spacebar, A, or D pressed).
          // If so, disengage auto-fly immediately and let manual controls take over.
          // We check on step === 0 only to avoid triggering on every sub-step.
          if (step === 0 && (spacebar || tiltLeft || tiltRight)) {
            // Player pressed a control key while auto-fly was active — disengage.
            // The input will be passed through as manual control this frame.
            autoFlyEnabledRef.current = false;  // Disable the autopilot ref
            autoFlyManualOverrideRef.current = true; // Flag that player took over
            autoFlyStatusRef.current = "MANUAL"; // Update HUD to show manual mode
            // Do NOT set spacebar = false here — pass the manual key through.
          } else if (!autoFlyManualOverrideRef.current) {
            // Auto-fly is active and no manual override. Compute autopilot commands.

            // Time since auto-fly was activated (seconds).
            // autoFlyStartTimeRef holds the state.timeElapsed value at activation.
            // This gives us T+0=ignition, T+2=full throttle, T+10=gravity turn start.
            const afT = state.timeElapsed - autoFlyStartTimeRef.current; // s — auto-fly elapsed

            // Check whether any non-separated stage still has fuel.
            // Once all fuel is consumed, we switch to coast/landing modes.
            const hasAnyFuel = config.stages.some(
              (s) => !s.isSeparated && s.fuelMass > 0 // At least one active stage with fuel
            ); // boolean — true if there is fuel remaining anywhere

            if (!state.isFlying || afT < 2) {
              // PHASE 1: THROTTLE UP (T+0 to T+2s)
              // Hold spacebar=true so applyMultiStageThrottle ramps throttle at 50%/s.
              // This takes exactly 2 seconds to go from 0% → 100% throttle.
              // The rocket won't lift off until TWR > 1, which happens partway through this phase.
              spacebar = true;         // Simulate holding SPACE: ramp up throttle
              tiltLeft = false;        // No steering during throttle-up (keep angle = 0°)
              tiltRight = false;       // No steering
              autoFlyTargetAngle = 0;  // rad — straight up during ignition
              autoFlyPhaseLabel = "AUTO-FLY (Throttle Up)"; // HUD label

            } else if (afT < 10 && hasAnyFuel) {
              // PHASE 2: VERTICAL ASCENT (T+2s to T+10s)
              // Full throttle, rocket points straight up. Build altitude before tilting.
              // Real rockets do a brief vertical phase for stability and to clear the tower.
              spacebar = true;         // Hold full throttle
              tiltLeft = false;
              tiltRight = false;
              autoFlyTargetAngle = 0;  // rad — 0° = straight vertical (no tilt)
              autoFlyPhaseLabel = "AUTO-FLY (Vertical Ascent)"; // HUD label

            } else if (afT < 70 && hasAnyFuel) {
              // PHASE 3: GRAVITY TURN (T+10s to T+70s, 60 seconds)
              // Gradually tilt the rocket from 0° (vertical) to 45° (diagonal) over 60 seconds.
              // This "gravity turn" is how real rockets build horizontal orbital velocity —
              // it converts vertical kinetic energy into horizontal motion efficiently.
              //
              // Linear interpolation: progress goes from 0 (at T=10) to 1 (at T=70).
              // Target angle goes from 0 rad (vertical) to π/4 rad (45° right of vertical).
              const turnProgress = (afT - 10) / 60; // 0.0 to 1.0 over the 60-second turn
              autoFlyTargetAngle = turnProgress * (Math.PI / 4); // 0 → π/4 radians (0° → 45°)
              spacebar = true;  // Full throttle throughout the gravity turn
              tiltLeft = false; // Angle is controlled by the proportional controller below,
              tiltRight = false; // NOT by tiltLeft/tiltRight (which add incremental angular velocity)
              const angleDegrees = (autoFlyTargetAngle * 180 / Math.PI).toFixed(0); // For display
              autoFlyPhaseLabel = `AUTO-FLY (Gravity Turn ${angleDegrees}°)`; // e.g., "23°"

            } else if (hasAnyFuel) {
              // PHASE 4: ORBITAL BURN (T+70s onward, while fuel remains)
              // Hold 45° angle and full throttle to maximize horizontal velocity.
              // This continues until the stage runs out of fuel and separates.
              autoFlyTargetAngle = Math.PI / 4; // rad — 45° constant tilt
              spacebar = true;   // Full throttle
              tiltLeft = false;
              tiltRight = false;
              autoFlyPhaseLabel = "AUTO-FLY (Orbital Burn)"; // HUD label

            } else if (state.velocity.y > 0) {
              // PHASE 5: COAST (after fuel exhausted, still ascending)
              // Engine is off, rocket coasts on residual velocity. No thrust, no steering.
              // Gravity and (above 100km: none; below 100km: tiny) drag decelerate it.
              spacebar = false;  // No thrust — engines are off
              tiltLeft = false;
              tiltRight = false;
              autoFlyTargetAngle = state.angle; // Keep current angle (no correction during coast)
              autoFlyPhaseLabel = "AUTO-FLY (Coast Phase)"; // HUD label

            } else if (state.velocity.y <= 0 && state.position.y > 5000) {
              // PHASE 6: BALLISTIC DESCENT (above 5 km, falling back down)
              // No fuel, no thrust. Rocket falls under gravity. Parachute will deploy
              // automatically by the existing parachute logic when velocity < -5 m/s.
              spacebar = false;
              tiltLeft = false;
              tiltRight = false;
              autoFlyTargetAngle = 0; // Point straight up for aerodynamic stability during descent
              autoFlyPhaseLabel = "AUTO-FLY (Ballistic Descent)"; // HUD label

            } else if (state.velocity.y < 0 && state.position.y <= 5000 && state.position.y > 2000) {
              // PHASE 7: PARACHUTE DESCENT (below 5 km, above 2 km)
              // Parachute has deployed (or is about to). No thrust needed.
              // The parachute drag force dramatically slows the descent.
              spacebar = false;
              tiltLeft = false;
              tiltRight = false;
              autoFlyTargetAngle = 0; // Upright for chute stability
              autoFlyPhaseLabel = "AUTO-FLY (Parachute Deploy)"; // HUD label

            } else if (state.velocity.y < 0 && state.position.y <= 2000) {
              // PHASE 8: LANDING BURN (below 2 km, descending)
              // If there is any remaining fuel in any stage, fire engines retrograde
              // (pointing straight up) to slow the descent for a soft landing.
              // This mimics SpaceX booster landing burns — a final engine burn to
              // reduce velocity from ~100 m/s to < 5 m/s before touchdown.
              const hasFuelForLanding = config.stages.some(
                (s) => !s.isSeparated && s.fuelMass > 0 && s.isActive
              ); // Check if any active stage has fuel for a landing burn

              if (hasFuelForLanding) {
                spacebar = true;       // Fire engines to slow descent
                tiltLeft = false;
                tiltRight = false;
                autoFlyTargetAngle = 0; // Point straight up for retrograde (deceleration) thrust
                autoFlyPhaseLabel = "AUTO-FLY (Landing Burn)"; // HUD label
              } else {
                // No fuel for landing burn — coast to touchdown with parachute only.
                spacebar = false;
                autoFlyTargetAngle = 0;
                autoFlyPhaseLabel = "AUTO-FLY (Landing — No Fuel)";
              }

            } else {
              // PHASE 9: ANY OTHER STATE (e.g., on the ground after landing)
              // Auto-fly has nothing to do. Disengage automatically.
              spacebar = false;
              autoFlyTargetAngle = 0;
              autoFlyPhaseLabel = "AUTO-FLY (Complete)";
            }

            // Update the status ref so drawTelemetry shows the current phase.
            // This is written every sub-step; only the last sub-step's value shows in the HUD.
            autoFlyStatusRef.current = autoFlyPhaseLabel; // Synced to React state every 3 frames
          }
        } else {
          // Auto-fly is disabled — manual mode. Update the status ref to "MANUAL".
          // This ensures the HUD shows "MODE: MANUAL" when auto-fly is off.
          autoFlyStatusRef.current = "MANUAL"; // Human-readable mode for the HUD
        }

        // ── APPLY CONTROLS ───────────────────────────────────────────────
        // Throttle ramp + angular velocity change from steering input.
        // spacebar / tiltLeft / tiltRight may have been overridden by auto-fly above.
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

        // ── AUTO-FLY ANGLE CONTROLLER (post-physics proportional controller) ─
        // After updatePhysics() has applied damping and the restoring force, we
        // override angularVelocity with a proportional controller that drives the
        // rocket angle toward the autopilot's desired target angle.
        //
        // WHY POST-PHYSICS: updatePhysics() applies angular damping and restoring
        // force, then integrates angle += angularVelocity * dt. If we set
        // angularVelocity BEFORE the physics call, damping fights our command.
        // Setting it AFTER means the value we write is the starting angularVelocity
        // for the NEXT frame's integration — giving us clean, lag-free control.
        //
        // PROPORTIONAL CONTROLLER FORMULA:
        //   angularVelocity = K_p × (targetAngle − currentAngle)
        //   K_p = 3.0 rad/s per radian of error
        //   At 15° error (0.26 rad): ω = 0.79 rad/s → corrects in ~0.33 seconds
        //   At 2° error (0.035 rad): ω = 0.10 rad/s → settles gently
        //
        // This is a simple P-controller (no I or D terms). It's good enough for
        // a game simulator because the dynamics are slow compared to the frame rate.
        if (autoFlyEnabledRef.current && !autoFlyManualOverrideRef.current && frame.state.isFlying) {
          // Compute the error: difference between desired angle and current angle.
          // autoFlyTargetAngle was set in the auto-fly block above, this frame.
          const angleError = autoFlyTargetAngle - frame.state.angle; // radians — positive = turn right
          // Apply proportional gain. K_p = 3.0 means ω increases 3 rad/s per radian of error.
          frame.state.angularVelocity = angleError * 3.0; // rad/s — drives angle toward target
        }

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
          const t = frame.state.timeElapsed;
          const store = useTelemetryStore.getState();

          // IGNITION
          const activeStgForLog = config.stages.find((s) => s.isActive && !s.isSeparated);
          if (!loggedIgnitionRef.current && activeStgForLog && activeStgForLog.thrustPercentage > 0) {
            loggedIgnitionRef.current = true;
            store.addMissionEvent({ time: t, message: "IGNITION", type: "ignition" });
          }

          // LIFTOFF
          if (!loggedLiftoffRef.current && frame.state.isFlying && frame.state.velocity.y > 2) {
            loggedLiftoffRef.current = true;
            store.addMissionEvent({ time: t, message: "LIFTOFF", type: "liftoff" });
          }

          // STAGING
          if (frame.state.stageSeparationCount > prevStageSepRef.current) {
            const stageNum = frame.state.stageSeparationCount;
            store.addMissionEvent({ time: t, message: `STAGE ${stageNum} SEP`, type: "staging" });
            prevStageSepRef.current = frame.state.stageSeparationCount;
          }

          // MAX-Q
          if (!loggedMaxQRef.current && maxQPassedRef.current) {
            loggedMaxQRef.current = true;
            const qKpa = (currentAtmoDataRef.current.maxDynamicPressure / 1000).toFixed(1);
            store.addMissionEvent({ time: t, message: `MAX-Q ${qKpa} kPa`, type: "maxq" });
          }

          // PARACHUTE
          if (!loggedParaRef.current && parachuteDeployedRef.current) {
            loggedParaRef.current = true;
            store.addMissionEvent({ time: t, message: "CHUTE DEPLOYED", type: "parachute" });
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

        // ── STAGE SEPARATION EFFECTS + SEPARATED STAGE CREATION ─────────
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

          // ── CREATE SEPARATED STAGE PHYSICS OBJECTS ──────────────────
          // Loop through every stage in the config to find stages that are
          // NEWLY separated this frame (isSeparated=true but not yet tracked).
          // prevSeparatedStageNumbersRef tracks which stage indices we already
          // know about — a stage is "new" the first frame isSeparated flips true.
          config.stages.forEach((stage, idx) => {
            // Condition: stage is marked separated AND we haven't seen it before.
            // idx is used as the stage "number" for tracking (0-based index).
            if (stage.isSeparated && !prevSeparatedStageNumbersRef.current.has(idx)) {
              // Mark this stage as known so we don't create a duplicate next frame.
              prevSeparatedStageNumbersRef.current.add(idx);

              // Inherit the ROCKET's current position at separation.
              // The separated stage starts at the same world location as the rocket.
              const sepX = frame.state.position.x;
              const sepY = frame.state.position.y;

              // Inherit the rocket's current velocity, then add a small downward
              // impulse to separate it from the ascending upper stage.
              // 5 m/s downward is enough to visually diverge without being unrealistic.
              const sepVx = frame.state.velocity.x;
              const sepVy = frame.state.velocity.y - 5; // 5 m/s downward relative impulse

              // Use the stage's dry mass (structural mass without fuel).
              // At separation the stage has burned most of its fuel, so dry mass
              // is a good approximation for the separated hardware's inertia.
              const stageMass = stage.dryMass;

              // Build the initial SeparatedStageState for this stage.
              const newSeparated: SeparatedStageState = {
                stageNumber:      idx,               // 0-based index matching config.stages
                stageName:        stage.name ?? `Stage ${idx + 1}`, // Display name for the HUD
                position:         { x: sepX, y: sepY }, // World position at separation
                velocity:         { x: sepVx, y: sepVy }, // Velocity with downward impulse
                mass:             Math.max(stageMass, 50),  // At least 50 kg to prevent NaN
                parachute:        createParachute(50000, 1), // New single-use chute: min 50 km
                parachuteDeployed: false,            // Not yet deployed
                hasLanded:        false,             // Still in flight
                landingVelocity:  0,                 // Set at touchdown
                landingX:         0,                 // Set at touchdown
              };

              separatedStagesRef.current.push(newSeparated); // Add to tracked list

              if (DEBUG_MODE) {
                console.log(`[RocketSimulator] Separated stage created: idx=${idx} name="${newSeparated.stageName}" pos=(${sepX.toFixed(0)},${sepY.toFixed(0)}) vel=(${sepVx.toFixed(1)},${sepVy.toFixed(1)}) mass=${newSeparated.mass.toFixed(0)}kg`);
              }
            }
          });
        }

        // ── SEPARATED STAGE PHYSICS ──────────────────────────────────────
        // Each separated stage is an independent ballistic object with:
        //   - Gravity pulling it down
        //   - Atmospheric drag slowing it (proportional to air density and velocity²)
        //   - Parachute drag when deployed (auto-deploys when descending > 5 m/s)
        //   - Euler integration at the same sub-step resolution as the main rocket
        separatedStagesRef.current.forEach((sep) => {
          if (sep.hasLanded) return; // Skip stages that have already touched down

          // ── GRAVITY ─────────────────────────────────────────────────────
          // Same gravitational model as the main physics engine: g = 9.81 m/s²
          // downward (−y). Applied first before drag and parachute forces.
          const gravity = -9.81; // m/s² downward in world-space y

          // ── ATMOSPHERIC DRAG ────────────────────────────────────────────
          // Simplified cylindrical drag: F_drag = 0.5 × ρ × v² × Cd × A
          // Where: ρ = air density at current altitude (from ISA model)
          //        v = speed of stage (scalar magnitude)
          //        Cd = drag coefficient (1.0 for a tumbling cylinder)
          //        A = cross-sectional area (0.5 m² placeholder for a typical stage)
          const airDensity = getAirDensity(Math.max(sep.position.y, 0)); // kg/m³ at altitude
          const velMag = Math.sqrt(sep.velocity.x ** 2 + sep.velocity.y ** 2); // Speed in m/s
          const Cd = 1.0;  // Drag coefficient for a tumbling cylinder
          const A = 0.5;   // Cross-sectional area in m² (rough estimate for a rocket stage)
          // Drag magnitude: F_drag = 0.5 × ρ × v² × Cd × A
          const dragMag = 0.5 * airDensity * velMag * velMag * Cd * A;
          // Drag direction is always opposite to velocity.
          // Guard against division by zero if velMag ≈ 0 (stage at rest in the air).
          const dragAccX = velMag > 0.01 ? -(sep.velocity.x / velMag) * (dragMag / sep.mass) : 0;
          const dragAccY = velMag > 0.01 ? -(sep.velocity.y / velMag) * (dragMag / sep.mass) : 0;

          // ── PARACHUTE AUTO-DEPLOY ────────────────────────────────────────
          // Deploy when descending faster than 5 m/s and above minimum altitude.
          // Mirrors the main rocket's parachute logic.
          if (
            !sep.parachuteDeployed &&            // Only deploy once
            sep.velocity.y < -5 &&              // Descending at > 5 m/s
            sep.position.y > sep.parachute.minAltitudeForDeployment // Above minimum altitude
          ) {
            deployParachute(sep.parachute); // Begin inflation (gradual drag increase)
            sep.parachuteDeployed = true;   // Flag so we don't call deploy again
          }
          updateParachute(sep.parachute, subDelta); // Inflate parachute over time

          // ── PARACHUTE FORCE ──────────────────────────────────────────────
          // Parachute drag acts upward when descending (reduces terminal velocity).
          // LandingMechanics.Parachute stores a rated dragForce (Newtons at full inflation)
          // and scales it by deploymentProgress² to model gradual inflation.
          // Formula matches LandingMechanics.updateParachute: F = dragForce × progress²
          let chuteAccY = 0;
          if (sep.parachuteDeployed && sep.velocity.y < 0) {
            // Only applies upward when descending; ignore during ascent
            // Use progress² so drag builds up as the canopy opens (same as main physics)
            const chuteForce = sep.parachute.dragForce * (sep.parachute.deploymentProgress ** 2);
            chuteAccY = chuteForce / sep.mass; // Upward deceleration: a = F / m
          }

          // ── INTEGRATE ───────────────────────────────────────────────────
          // Euler integration: new velocity = old velocity + acceleration × dt
          // Acceleration = gravity + drag + parachute
          sep.velocity.x += dragAccX * subDelta;                    // X: only drag (no lateral gravity)
          sep.velocity.y += (gravity + dragAccY + chuteAccY) * subDelta; // Y: gravity + drag + chute

          // New position = old position + velocity × dt
          sep.position.x += sep.velocity.x * subDelta;
          sep.position.y += sep.velocity.y * subDelta;

          // ── LANDING DETECTION ────────────────────────────────────────────
          // Stage touches down when it crosses y = 0 (ground level)
          if (sep.position.y <= 0) {
            sep.position.y   = 0;                        // Clamp to ground
            sep.hasLanded    = true;                     // Stop physics updates
            sep.landingVelocity = Math.abs(sep.velocity.y); // Record impact speed
            sep.landingX     = sep.position.x;           // Record landing X for display
            sep.velocity.x   = 0;                        // Come to rest
            sep.velocity.y   = 0;
            if (DEBUG_MODE) {
              console.log(`[RocketSimulator] Separated stage landed: "${sep.stageName}" at x=${sep.landingX.toFixed(0)}m, v=${sep.landingVelocity.toFixed(1)}m/s`);
            }
          }
        });

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
          useTelemetryStore.getState().updateMission({ landingScore: score });

          // Snapshot the player's flight trajectory at the moment of landing.
          // We spread the buffer into a new array so this copy is independent —
          // if the player hits Reset, trajectoryBufferRef is cleared but this snapshot persists.
          // The snapshot is used as the gold comparison line in the Monte Carlo trajectory plot.
          playerTrajectoryRef.current = [...trajectoryBufferRef.current];

          // Log the touchdown event with landing velocity
          const landV = Math.abs(frame.state.landingVelocity).toFixed(1);
          useTelemetryStore.getState().addMissionEvent({
            time: frame.state.timeElapsed,
            message: `TOUCHDOWN ${landV} m/s`,
            type: "landing",
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
        // At high time multipliers we generate fewer particles so the system doesn't
        // accumulate thousands of long-lived smoke particles at once.
        const spawnChance = Math.min(1, 1 / Math.max(1, effectiveMult));
        if (Math.random() < spawnChance) {
          // Spawn orange/yellow FLAME particles at the rocket's nozzle (world space).
          particleSystemRef.current.createExhaustTrail(
            flightStateRef.current.position.x,
            flightStateRef.current.position.y,
            flightStateRef.current.velocity.x,
            flightStateRef.current.velocity.y,
            flightStateRef.current.angle,
            activeStage.thrustPercentage
          );
          // Spawn grey/white SMOKE particles on every 3rd frame (smoke is coarser than flame).
          // Smoke particles live 3–4× longer than flame particles, so spawning less often
          // keeps the particle budget balanced: ~3 smoke + ~10 flame per frame.
          if (Math.random() < 0.35) {
            particleSystemRef.current.createSmokeTrail(
              flightStateRef.current.position.x,
              flightStateRef.current.position.y,
              flightStateRef.current.velocity.x,
              flightStateRef.current.velocity.y,
              flightStateRef.current.angle,
              activeStage.thrustPercentage
            );
          }
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

      // 2b. World-space reference grid — faint lines at adaptive intervals.
      // Drawn after stars so the grid sits in front of the star field but behind
      // ground, rocket, and particles. Very low alpha keeps it unobtrusive.
      drawGrid(ctx, cw, ch, camera);

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

      // 6b. Draw separated stage bodies falling back to Earth.
      // Each stage is rendered as a small grey cylinder rectangle at its current
      // world position, with a parachute canopy triangle drawn above it when deployed.
      separatedStagesRef.current.forEach((sep) => {
        // Convert world position to screen coords using the same camera as the main rocket.
        const { x: sx, y: sy } = camera.worldToScreen(sep.position.x, sep.position.y, cw, ch);

        // Skip stages that are off-screen to avoid wasting canvas draw calls.
        // Off-screen: more than 200px outside the viewport on any edge.
        if (sx < -200 || sx > cw + 200 || sy < -200 || sy > ch + 200) return;

        // ── STAGE BODY ────────────────────────────────────────────────────
        // Render as a small dark-grey filled rectangle (cylinder silhouette).
        // Width = 8px, height = 16px in screen space regardless of zoom, so it's
        // always visible but never dominates the viewport.
        const bw = 8;  // Body width in screen pixels
        const bh = 16; // Body height in screen pixels
        ctx.save(); // Preserve canvas transform state
        ctx.fillStyle = sep.hasLanded ? "#556677" : "#889aaa"; // Darker if landed
        ctx.strokeStyle = "#aabbcc";
        ctx.lineWidth = 1;
        ctx.fillRect(sx - bw / 2, sy - bh / 2, bw, bh);   // Centered on screen pos
        ctx.strokeRect(sx - bw / 2, sy - bh / 2, bw, bh); // Outline for visibility

        // ── STAGE LABEL ──────────────────────────────────────────────────
        // Small white text below the body: stage name + landing velocity if landed.
        ctx.fillStyle = "rgba(180, 200, 220, 0.75)"; // Muted white
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        if (sep.hasLanded) {
          // Show landing velocity so players can assess how hard the stage hit.
          ctx.fillText(`${sep.stageName} ${sep.landingVelocity.toFixed(0)} m/s`, sx, sy + bh / 2 + 11);
        } else {
          ctx.fillText(sep.stageName, sx, sy + bh / 2 + 11); // Just name while descending
        }

        // ── PARACHUTE CANOPY ─────────────────────────────────────────────
        // Draw a coloured triangle above the stage body when the chute is deployed.
        // Size scales with deploymentProgress (0 → 1) so it opens over ~1 second.
        if (sep.parachuteDeployed && !sep.hasLanded) {
          const progress = sep.parachute.deploymentProgress; // 0–1 inflation progress
          const chuteW = 22 * progress; // Canopy base width grows as it inflates
          const chuteH = 14 * progress; // Canopy height grows proportionally

          // Draw the canopy as a triangle:
          //   apex  = top-centre of the triangle (above the stage)
          //   left  = bottom-left of the canopy spread
          //   right = bottom-right of the canopy spread
          const apexY  = sy - bh / 2 - chuteH - 4; // 4px gap above stage body
          const baseY  = sy - bh / 2 - 4;           // Bottom of canopy aligns with gap

          ctx.beginPath();
          ctx.moveTo(sx, apexY);                 // Apex (top centre)
          ctx.lineTo(sx - chuteW / 2, baseY);   // Bottom-left corner
          ctx.lineTo(sx + chuteW / 2, baseY);   // Bottom-right corner
          ctx.closePath();

          // Fill: orange-white gradient tint to distinguish from rocket
          ctx.fillStyle = `rgba(255, 200, 80, ${0.55 * progress})`; // Fades in with progress
          ctx.fill();
          ctx.strokeStyle = `rgba(255, 220, 120, ${0.8 * progress})`;
          ctx.lineWidth = 1;
          ctx.stroke();

          // Draw lines from canopy base corners down to the stage body (suspension lines)
          ctx.strokeStyle = `rgba(255, 220, 120, ${0.4 * progress})`; // Faint orange lines
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(sx - chuteW / 2, baseY); // Left base corner → stage body
          ctx.lineTo(sx, sy - bh / 2);
          ctx.moveTo(sx + chuteW / 2, baseY); // Right base corner → stage body
          ctx.lineTo(sx, sy - bh / 2);
          ctx.stroke();
        }

        ctx.restore(); // Restore canvas state (undo save)
      });

      // Telemetry HUD rendering removed (now handled by React DOM TelemetryDashboard)

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

      // ── SYNC TO REACT STATE & ZUSTAND STORE (every 3 frames) ──────────
      if (frameCount % 3 === 0) {
        setDisplayFlightState({ ...flightStateRef.current });
        const store = useTelemetryStore.getState();
        const st = flightStateRef.current;
        const atmo = currentAtmoDataRef.current;
        const struct = structuralStateRef.current;
        const config = rocketConfigRef.current;
        const activeStage = config.stages.find(s => s.isActive && !s.isSeparated);
        const activeStageIdx = config.stages.findIndex(s => s.isActive && !s.isSeparated);

        store.updateDynamics({
          altitude: st.position.y,
          velocityX: st.velocity.x,
          velocityY: st.velocity.y,
          speed: Math.sqrt(st.velocity.x**2 + st.velocity.y**2),
          angle: st.angle,
          angularVelocity: st.angularVelocity,
          maxAltitude: st.maxAltitudeReached,
          isFlying: st.isFlying,
          hasLanded: st.hasLanded,
          positionX: st.position.x,
        });

        store.updateEnvironment({
          machNumber: atmo.machNumber,
          dynamicPressureQ: atmo.dynamicPressure,
          maxQ: atmo.maxDynamicPressure,
          maxQAltitude: atmo.maxQAltitude,
          stagnationTemp: atmo.stagnationTemperature,
          currentGForce: struct.currentAccelerationG,
        });

        const stagesInfo = getStageFuelStatus(config);
        const totalMass = calculateTotalMass(config);
        const totalThrust = calculateTotalThrust(config);
        store.updateVehicle({
          structuralIntegrity: struct.structuralIntegrity,
          throttlePercent: activeStage ? activeStage.thrustPercentage : 0,
          stages: stagesInfo.map(s => {
            const stg = config.stages.find(st => st.stageNumber === s.stageNumber);
            return {
              stageNumber: s.stageNumber,
              name: s.name,
              fuelPercent: s.fuelPercent,
              isActive: s.isActive,
              isSeparated: s.isSeparated,
              isThrusting: stg ? stg.thrustPercentage > 0 : false,
              thrustPercentage: stg ? stg.thrustPercentage : 0
            };
          }),
          activeStage: activeStageIdx + 1,
          totalMass: totalMass,
          totalThrust: totalThrust,
          twr: totalMass > 0 ? totalThrust / (totalMass * GRAVITY) : 0,
          didBreakApart: isStructuralFailureRef.current
        });

        let phase: import('../store/telemetryStore').FlightPhase = 'PRELAUNCH';
        if (isStructuralFailureRef.current) phase = 'STRUCTURAL_FAILURE';
        else if (st.hasLanded) phase = 'LANDED';
        else if (st.isFlying && st.velocity.y < -5) phase = 'DESCENDING';
        else if (st.isFlying && st.velocity.y > 2) {
          if (atmo.dynamicPressure > 10000 && atmo.dynamicPressure > atmo.maxDynamicPressure * 0.9) phase = 'MAX_Q';
          else phase = 'ASCENDING';
        }
        else if (st.isFlying) phase = 'COASTING';

        store.updateMission({
          phase,
          timeElapsed: st.timeElapsed,
          autoFlyEnabled: autoFlyEnabledRef.current,
          autoFlyPhase: autoFlyStatusRef.current,
          difficulty: engineFailureStateRef.current.difficulty,
          isPaused: isPausedRef.current,
          timeMultiplier: timeMultiplierRef.current
        });
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
        trajectoryLimiterRef.current.limitTrajectory(          [...trajectoryBufferRef.current] // Pass a copy — limiter may truncate
        );
        
        useTelemetryStore.getState().pushChartPoint(
          flightStateRef.current.timeElapsed,
          Math.sqrt(flightStateRef.current.velocity.x**2 + flightStateRef.current.velocity.y**2),
          flightStateRef.current.position.y,
          currentAtmoDataRef.current.dynamicPressure,
          structuralStateRef.current.currentAccelerationG
        );
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

  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Shared rocket-switch logic used by both handleReset and handleRocketChange.
   * Applies a new config to all game-state refs and resets all per-flight state.
   * Extracted into a helper to avoid duplicating ~30 lines of reset code.
   *
   * @param freshConfig  Cloned, reset MultiStageRocketConfig ready for a new flight
   * @param newKey       The select-box key to set (preset name or "custom:${id}")
   */
  const applyRocketSwitch = useCallback((
    freshConfig: MultiStageRocketConfig,
    newKey: string,
  ) => {
    // Update the physics-active config ref — the game loop reads this every frame
    rocketConfigRef.current = freshConfig;
    setRocketConfig(freshConfig);         // Sync React state for dropdown display
    setSelectedRocketKey(newKey);         // Update the select-box value

    // Create a new flight state for the fresh config (rocket at launch pad, all zeros)
    const freshState = createMultiStageRocket(freshConfig);
    flightStateRef.current = freshState;
    setDisplayFlightState({ ...freshState }); // Sync display state for UI overlays

    // Reset landing mechanics for the new flight
    landingStateRef.current = createLandingState();
    parachuteRef.current = createParachute(100000, 1); // New single-use parachute
    landingGearRef.current = createLandingGear(500000); // Fresh shock absorbers
    parachuteDeployedRef.current = false; // Allow parachute deployment on the new flight

    // Clear the old trajectory (previous flight) and landing results
    trajectoryBufferRef.current = [];
    setLandingScore(null);
    setLandingState(createLandingState());

    // Clear exhaust particles and snap camera to ground
    particleSystemRef.current.clear();
    cameraRef.current.reset();

    // Stop all audio from the previous flight
    audioManagerRef.current.stopAllSounds();
    engineSoundPlayingRef.current = false;

    // Reset new physics systems (structure, engine failures, atmospheric telemetry)
    structuralStateRef.current = createStructuralState();
    resetEngineFailures(engineFailureStateRef.current);
    currentAtmoDataRef.current = {
      machNumber: 0, dynamicPressure: 0, maxDynamicPressure: 0,
      maxQAltitude: 0, currentGForce: 0, structuralIntegrity: 100,
      stagnationTemperature: 288,
    };
    prevDynamicPressureRef.current = 0;
    maxQPassedRef.current = false;
    maxQFlashTimerRef.current = 0;
    warningBannersRef.current = [];
    isStructuralFailureRef.current = false;

    // Reset mission log for the new flight
    missionLogRef.current = [];
    setMissionLog([]);
    loggedIgnitionRef.current  = false;
    loggedLiftoffRef.current   = false;
    loggedMaxQRef.current      = false;
    loggedParaRef.current      = false;
    prevStageSepRef.current    = 0;

    // Clear ALL separated stage tracking — this flight has no separated stages yet.
    // Cleared here (not just on reset) so switching rockets mid-flight doesn't
    // carry over separated stages from the previous rocket.
    separatedStagesRef.current = [];          // Remove all tracked separated stages
    prevSeparatedStageNumbersRef.current = new Set(); // Reset detection set

    performanceMonitorRef.current.reset();

    if (DEBUG_MODE) {
      console.log(`[RocketSimulator] applyRocketSwitch: switched to "${freshConfig.name}" (key="${newKey}")`);
    }
  }, []); // No deps: reads all game data via refs and stable setState functions

  // ─────────────────────────────────────────────────────────────────────────────

  /** Reset the simulation to the pre-launch state using the SAME rocket config. */
  const handleReset = useCallback(() => {
    // Clone the CURRENT rocket config so all tanks are full again.
    // We use rocketConfigRef.current (not a preset constant) so a custom build
    // stays as the active rocket after reset — it doesn't revert to Simple Two-Stage.
    const freshConfig = cloneRocketConfig(rocketConfigRef.current);
    resetAllStages(freshConfig); // Fill all tanks and clear staging flags

    // applyRocketSwitch handles all the physics/state/ref resets; keep the same key
    // so the dropdown stays on the current rocket (don't switch to a different name).
    applyRocketSwitch(freshConfig, selectedRocketKey);

    // Extras that applyRocketSwitch doesn't handle (reset-specific state):

    // Play a click confirmation after all sounds are stopped by applyRocketSwitch
    audioManagerRef.current.playSound("ui-click");

    // ── RESET AUTO-FLY STATE ─────────────────────────────────────────────────
    // Disengage the autopilot on reset — the player starts from scratch on the pad
    // and should be in manual control by default. If they want auto-fly, they press F.
    autoFlyEnabledRef.current = false;        // Disengage autopilot (game loop reads this ref)
    autoFlyManualOverrideRef.current = false; // Clear any previous manual override flag
    autoFlyStartTimeRef.current = 0;          // Reset the T+0 reference time for auto-fly
    autoFlyStatusRef.current = "MANUAL";      // HUD returns to "MANUAL" mode label

    // ── CANCEL MONTE CARLO & CLEAR MC STATE ─────────────────────────────────
    // Abort any in-progress simulation so it doesn't call setState after reset.
    mcCancelRef.current?.();   // Abort the async simulation loop if one is running
    mcCancelRef.current = null; // Clear the stale cancel handle
    setShowMCConfig(false);    // Close MC config panel if open
    setShowMCPanel(false);     // Close MC results panel if open
    setMCProgress(null);       // Clear progress bar
    // Note: intentionally keep mcResults so the user can reopen the last results panel.
    playerTrajectoryRef.current = []; // Clear the gold comparison line for a fresh flight
    if (DEBUG_MODE) console.log("[RocketSimulator] handleReset: reset complete");
  }, [selectedRocketKey, applyRocketSwitch]); // Deps: selectedRocketKey (for key preservation), applyRocketSwitch

  /** Switch to a different rocket type (preset or saved custom). */
  const handleRocketChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const key = e.target.value; // The select value (preset name, "custom:${id}", or "Build Custom")

    if (DEBUG_MODE) console.log(`[RocketSimulator] handleRocketChange: key="${key}"`);

    // "Build Custom" is not a rocket: it asks App.tsx to switch to BUILD mode.
    if (key === "Build Custom") {
      onSwitchToBuildMode?.(); // Optional chaining: safe even if prop is undefined
      return;                   // Don't try to load a config for this virtual option
    }

    // ── HANDLE CUSTOM ROCKETS ───────────────────────────────────────────────
    // Custom rockets are identified by keys starting with "custom:".
    // The suffix after "custom:" is either the id or "active".
    if (key.startsWith("custom:")) {
      const idPart = key.substring(7); // Remove the "custom:" prefix to get id or "active"
      let loadedConfig: MultiStageRocketConfig | null = null;

      if (idPart === "active") {
        // Load from the active-launch key (the most recently launched custom config).
        // Written by RocketBuilder.handleLaunch and by our own mount effect.
        try {
          const raw = localStorage.getItem(ACTIVE_ROCKET_KEY);
          if (raw) {
            loadedConfig = JSON.parse(raw) as MultiStageRocketConfig;
            if (DEBUG_MODE) console.log(`[RocketSimulator] handleRocketChange: loaded active config "${loadedConfig.name}"`);
          }
        } catch (err) {
          if (DEBUG_MODE) console.warn("[RocketSimulator] handleRocketChange: failed to load active config:", err);
        }
      } else {
        // Load from a specific saved custom rocket's localStorage key.
        try {
          const storageKey = `${STORAGE_KEY_PREFIX}${idPart}`; // e.g., "rocket_custom_1716518400000_MyFalcon9"
          const raw = localStorage.getItem(storageKey);
          if (raw) {
            loadedConfig = JSON.parse(raw) as MultiStageRocketConfig;
            if (DEBUG_MODE) console.log(`[RocketSimulator] handleRocketChange: loaded saved config "${loadedConfig.name}" from "${storageKey}"`);
          }
        } catch (err) {
          if (DEBUG_MODE) console.warn(`[RocketSimulator] handleRocketChange: failed to load custom id "${idPart}":`, err);
        }
      }

      if (!loadedConfig) {
        if (DEBUG_MODE) console.warn(`[RocketSimulator] handleRocketChange: no config found for key "${key}", ignoring`);
        return; // Couldn't load config: don't change the rocket (keep current selection)
      }

      // Clone and reset the loaded config so the flight starts with full tanks.
      // Cloning is essential: the loaded object is from localStorage and should not be mutated.
      const freshConfig = cloneRocketConfig(loadedConfig);
      resetAllStages(freshConfig); // Fill all fuel tanks, clear staging flags

      applyRocketSwitch(freshConfig, key); // Apply the new config and reset all flight state
      audioManagerRef.current.playSound("ui-select"); // Pleasant confirmation sound
      return; // Done — custom rocket handling complete
    }

    // ── HANDLE PRESET ROCKETS ───────────────────────────────────────────────
    // Find the matching preset constant by name.
    let baseConfig: MultiStageRocketConfig | null = null;
    if (key === "Simple Two-Stage")  baseConfig = ROCKET_SIMPLE_TWO_STAGE;
    if (key === "Falcon 9 Inspired") baseConfig = ROCKET_FALCON_9_INSPIRED;
    if (key === "Three-Stage Heavy") baseConfig = ROCKET_THREE_STAGE;
    if (!baseConfig) {
      if (DEBUG_MODE) console.warn(`[RocketSimulator] handleRocketChange: unknown preset key "${key}", ignoring`);
      return; // Unknown key: ignore (shouldn't happen with controlled dropdown)
    }

    // Clone the preset constant so physics mutations (fuel burn) don't corrupt the exported module.
    const freshConfig = cloneRocketConfig(baseConfig);
    resetAllStages(freshConfig); // Ensure full tanks for the new flight

    applyRocketSwitch(freshConfig, key); // Apply preset and reset all flight state
    // applyRocketSwitch already resets engineSound, performanceMonitor, structuralState,
    // engineFailures, atmoData, warningBanners, etc. — no duplication needed here.
    audioManagerRef.current.playSound("ui-select"); // Confirmation sound
  }, [onSwitchToBuildMode, applyRocketSwitch]); // Deps: mode-switch callback + shared reset helper

  /** Delete a saved custom rocket from localStorage and refresh the in-memory list.
   *  Called by the save-manager modal's delete button for each rocket entry. */
  const handleDeleteCustomRocket = useCallback((id: string) => {
    // Remove the per-config storage key so the config data is gone
    const storageKey = `${STORAGE_KEY_PREFIX}${id}`; // e.g., "rocket_custom_1716518400000_MyFalcon9"
    localStorage.removeItem(storageKey); // Delete the config JSON blob

    // Read the current registry, filter out the deleted entry, and write it back.
    // This keeps the dropdown in sync — the deleted rocket won't appear next time.
    try {
      const raw = localStorage.getItem(REGISTRY_KEY);
      if (raw) {
        const list = JSON.parse(raw) as CustomRocketEntry[]; // Deserialize the registry array
        const updated = list.filter(r => r.id !== id);      // Remove the matching entry
        localStorage.setItem(REGISTRY_KEY, JSON.stringify(updated)); // Write the pruned registry
        setSavedCustomRockets(updated); // Sync React state so the dropdown re-renders immediately

        // If the deleted rocket is currently selected, switch back to the first preset.
        // Without this, the dropdown would show a key that no longer has a backing config.
        if (selectedRocketKey === `custom:${id}`) {
          const freshConfig = cloneRocketConfig(ROCKET_SIMPLE_TWO_STAGE);
          resetAllStages(freshConfig); // Full tanks for the new flight
          applyRocketSwitch(freshConfig, "Simple Two-Stage"); // Reset to the default preset
        }

        if (DEBUG_MODE) console.log(`[RocketSimulator] handleDeleteCustomRocket: deleted id="${id}", registry now has ${updated.length} entries`);
      }
    } catch (err) {
      if (DEBUG_MODE) console.warn("[RocketSimulator] handleDeleteCustomRocket: registry update failed:", err);
    }
  }, [selectedRocketKey, applyRocketSwitch]); // Deps: selectedRocketKey (to detect if deleted rocket is active), applyRocketSwitch

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
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val > 0) {
      setCustomGoalAltitude(val);
      setSelectedGoal(null);
    } else {
      setCustomGoalAltitude(null);
      setSelectedGoal(ALTITUDE_GOALS[0]);
    }
  }, []);
  /** Handle volume slider change. */
  const handleVolumeChange = useCallback((v: number) => {
    setMasterVolume(v);
    audioManagerRef.current.setMasterVolume(v);
  }, []);

  /** Handle canvas click to trigger a burst of thrust. */
  const handleCanvasClick = useCallback(() => {
    keysPressed.current["mouseClick"] = true; // Set for next game loop tick
  }, []);

  // ── OVERLAY STYLE HELPERS ─────────────────────────────────────────────────


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
    <TelemetryDashboard
      rocketName={rocketConfig.name}
      onReset={handleReset}
      onToggleAutoFly={() => {
        const newEnabled = !autoFlyEnabledRef.current;
        autoFlyEnabledRef.current = newEnabled;
        if (newEnabled) {
          autoFlyStartTimeRef.current = flightStateRef.current.timeElapsed;
          autoFlyManualOverrideRef.current = false;
          autoFlyStatusRef.current = "AUTO-FLY (Throttle Up)";
        } else {
          autoFlyStatusRef.current = "MANUAL";
        }
        audioManagerRef.current.playSound("ui-click");
      }}
      onSetTimeMultiplier={(m) => { setTimeMultiplier(m); setIsPaused(false); }}
      onTogglePause={() => setIsPaused((p) => !p)}
      onToggleMute={() => {
        const muted = audioManagerRef.current.toggleMute();
        setAudioMuted(muted);
      }}
      onVolumeChange={handleVolumeChange}
      audioMuted={audioMuted}
      masterVolume={masterVolume}
      onGoalChange={handleGoalChange}
      onCustomGoalChange={handleCustomGoal}
      selectedGoalName={selectedGoal?.name ?? "custom"}
      customGoalAltitude={customGoalAltitude}
      altitudeGoals={ALTITUDE_GOALS}
      onRocketChange={handleRocketChange}
      selectedRocketKey={selectedRocketKey}
      savedCustomRockets={savedCustomRockets}
      onShowSaveManager={() => setShowSaveManager(true)}
      difficulty={difficulty}
      onDifficultyChange={(e) => setDifficulty(e.target.value as any)}
      onShowKeyboardHelp={() => setShowKeyboardHelp(true)}
    >
      <div
        style={{
          position:   "absolute",
          inset:      0,
          overflow:   "hidden",
        }}
      >
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={canvasHeight}
          onClick={handleCanvasClick}
          style={{
            position: "absolute",
            top:      0,
            left:     0,
            width:    "100%",
            height:   "100%",
            cursor:   "crosshair",
          }}
        />


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

          {/* Auto-calculated failure probability — read-only, derived from build quality.
              Formula: failureProb = (1 - buildQualityScore) × 0.35
              No manual slider: the probability is determined by rocket design quality.
              High-quality builds (custom rockets with good design) have lower failure rates.
              Preset rockets fall back to quality=0.82 → ~6.3% failure rate. */}
          {mcConfig.includeFailureScenarios && (() => {
            // Compute quality and failure probability at render time so they always
            // reflect the CURRENT rocket (including any just-switched custom config).
            const quality = computeBuildQuality(rocketConfigRef.current); // 0.30–0.95 for custom, 0.82 for presets
            const autoFailureProb = (1 - quality) * 0.35;                 // Derived from design quality
            const expectedFailures = Math.round(mcConfig.numberOfRuns * autoFailureProb); // For display

            return (
              <div style={{ marginBottom: 14, padding: "8px 10px", backgroundColor: "rgba(255,136,68,0.08)", borderRadius: 4, border: "1px solid rgba(255,136,68,0.25)" }}>
                {/* Quality score row */}
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                  <span style={{ opacity: 0.7 }}>Build quality score:</span>
                  <strong style={{ color: quality >= 0.8 ? "#44dd88" : quality >= 0.6 ? "#ffcc44" : "#ff6644" }}>
                    {/* Color: green = good, yellow = marginal, red = poor */}
                    {(quality * 100).toFixed(0)}%
                  </strong>
                </div>

                {/* Failure probability row — read-only, derived from quality */}
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                  <span style={{ opacity: 0.7 }}>Auto failure probability:</span>
                  <strong style={{ color: "#ffaa44" }}>
                    {(autoFailureProb * 100).toFixed(1)}%
                  </strong>
                </div>

                {/* Expected failures count */}
                <div style={{ fontSize: 11, opacity: 0.55, marginTop: 3 }}>
                  ~{expectedFailures} of {mcConfig.numberOfRuns} runs will include a failure scenario
                </div>

                {/* Explanation of how to improve quality */}
                {quality < 0.75 && (
                  <div style={{ fontSize: 10, opacity: 0.5, marginTop: 5, fontStyle: "italic" }}>
                    Improve quality: add nose cone &amp; fins, fix thrust-to-weight ratio (1.3–3.0)
                  </div>
                )}
              </div>
            );
          })()}

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

                // Initialize progress tracking before the async batch starts
                setMCProgress({ completed: 0, total: mcConfig.numberOfRuns });

                // Clone the current rocket config so the MC simulation uses the same
                // rocket the player just flew (not a stale reference from before reset).
                const configForMC = cloneRocketConfig(rocketConfigRef.current);

                // Auto-compute failure probability from build quality at launch time.
                // This replaces the manual slider — quality score determines reliability.
                // Formula: (1 - buildQuality) × 0.35  (higher quality → fewer failures)
                const autoFailureProb = (1 - computeBuildQuality(rocketConfigRef.current)) * 0.35;

                // Build the final MC config: override failureProbability with auto value.
                // All other config fields (numberOfRuns, includeFailureScenarios) from mcConfig state.
                const finalMCConfig = { ...mcConfig, failureProbability: autoFailureProb };

                // Start the async Monte Carlo simulation.
                // onProgress: called after each run to update the progress bar.
                // onComplete: called with full results once all runs finish.
                const { cancel } = runMonteCarloSimulation(
                  configForMC,
                  finalMCConfig, // Use auto-computed failure probability, not the stale state value
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

                // Store cancel handle so handleReset can abort the simulation mid-batch
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
                  ["F",           "Toggle AUTO-FLY autopilot"],
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

      {/* ── SAVE MANAGER MODAL ───────────────────────────────────────────────────
          Shows all saved custom rockets with delete buttons.
          Opened by the "✎ Manage" button next to the rocket selector.
          Clicking the backdrop or the Close button dismisses without changes. */}
      {showSaveManager && (
        <div
          onClick={() => setShowSaveManager(false)} // Click backdrop to dismiss
          style={{
            position:        "fixed",
            inset:           0,              // Cover the entire viewport
            backgroundColor: "rgba(0,0,0,0.72)", // Dark semi-transparent backdrop
            display:         "flex",
            alignItems:      "center",
            justifyContent:  "center",
            zIndex:          100,            // Above all other overlays
          }}
        >
          {/* Modal card — stopPropagation prevents backdrop click-through */}
          <div
            onClick={e => e.stopPropagation()} // Don't close when clicking inside the modal
            style={{
              backgroundColor: "rgba(5, 10, 28, 0.97)",
              border:          `1px solid ${COLORS.ui}`,
              borderRadius:    "6px",
              padding:         "20px 24px",
              minWidth:        "340px",
              maxWidth:        "460px",
              maxHeight:       "80vh",       // Scroll if many rockets saved
              overflowY:       "auto",
              fontFamily:      "monospace",
              color:           COLORS.text,
            }}
          >
            {/* Modal title */}
            <h3 style={{ margin: "0 0 14px 0", fontSize: "14px", color: COLORS.ui }}>
              Saved Custom Rockets ({savedCustomRockets.length})
            </h3>

            {/* List of saved rockets, each with a delete button */}
            {savedCustomRockets.length === 0 ? (
              // Empty state shown if all rockets were deleted during this session
              <div style={{ fontSize: "12px", opacity: 0.5, textAlign: "center", padding: "16px 0" }}>
                No saved rockets. Build and save one in the ⚙ builder.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {savedCustomRockets.map(r => (
                  // Row per saved rocket: name + timestamp on the left, delete on the right
                  <div
                    key={r.id}
                    style={{
                      display:         "flex",
                      justifyContent:  "space-between",
                      alignItems:      "center",
                      padding:         "8px 10px",
                      backgroundColor: selectedRocketKey === `custom:${r.id}`
                        ? "rgba(74,111,165,0.20)" // Highlight currently-active rocket
                        : "rgba(255,255,255,0.03)",
                      borderRadius:    "4px",
                      border:          `1px solid rgba(74,111,165,0.2)`,
                    }}
                  >
                    {/* Rocket info: name + save date */}
                    <div>
                      <div style={{ fontSize: "13px", fontWeight: "bold" }}>★ {r.name}</div>
                      <div style={{ fontSize: "10px", opacity: 0.45 }}>
                        {/* Convert timestamp to a human-readable save date */}
                        Saved {new Date(r.timestamp).toLocaleDateString()} at {new Date(r.timestamp).toLocaleTimeString()}
                      </div>
                    </div>

                    {/* Delete button — removes from localStorage and refreshes the list */}
                    <button
                      onClick={() => {
                        handleDeleteCustomRocket(r.id); // Remove from storage + state
                        // If this was the last rocket, close the modal automatically
                        if (savedCustomRockets.length === 1) setShowSaveManager(false);
                      }}
                      style={{
                        padding:         "4px 9px",
                        backgroundColor: "rgba(180,40,40,0.25)", // Danger red tint
                        color:           "#ff8888",
                        border:          "1px solid rgba(180,40,40,0.5)",
                        borderRadius:    "3px",
                        cursor:          "pointer",
                        fontSize:        "11px",
                        fontFamily:      "monospace",
                      }}
                      title={`Delete "${r.name}" from saved rockets`}
                    >
                      ✕ Delete
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Close button at the bottom */}
            <button
              onClick={() => setShowSaveManager(false)} // Dismiss modal
              style={{
                ...btnStyle(false),
                marginTop: "16px",
                width:     "100%",
                padding:   "7px 0",
                textAlign: "center",
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
      </div>
    </TelemetryDashboard>
  );
};
