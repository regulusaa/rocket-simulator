/**
 * MONTE CARLO SIMULATOR
 * =====================
 * Core engine for running hundreds of automated rocket simulations in parallel
 * (interleaved via batched execution so the UI stays responsive).
 *
 * WHAT IS MONTE CARLO ANALYSIS?
 * Monte Carlo simulation is named after the Monaco casino because it uses random
 * numbers as its central mechanism — just like gambling. In aerospace engineering,
 * it means running the SAME rocket scenario hundreds of times, each time with
 * slightly different parameters drawn from a probability distribution, to understand
 * the full range of possible outcomes.
 *
 * WHY DO REAL TRAJECTORIES VARY?
 * No two rocket flights are perfectly identical because of:
 *   - Manufacturing tolerances: engine thrust varies ±3-5% from batch to batch
 *   - Fuel loading uncertainty: ground crews can't fill tanks to the exact gram
 *   - Weather: wind speed/direction changes hour to hour, minute to minute
 *   - Sensor noise: guidance computers have measurement error
 *   - Random failure events: components have mean-time-between-failures statistics
 *
 * HOW NASA/SPACEX USE THIS:
 * Before any real mission, analysts run 1,000-10,000 Monte Carlo runs to compute:
 *   - What's the 99th-percentile landing miss distance? (Safety for populated areas)
 *   - What altitude can we guarantee with 95% confidence? (Payload delivery)
 *   - What fraction of runs end in a safe landing? (Mission success probability)
 *
 * IMPLEMENTATION APPROACH:
 * We use a "batch-per-frame" pattern: each animation frame, we yield control to the
 * browser (via setTimeout) after completing one full run. This keeps the page responsive
 * while 50 simulations run sequentially in the background over ~2-5 seconds.
 *
 * COORDINATE SYSTEM (same as the main simulator):
 *   x = meters east of launch pad (positive = right/east)
 *   y = meters altitude above ground (positive = up)
 */

// Import the multi-stage rocket type and all functions needed to clone and operate it
import type { MultiStageRocketConfig } from './MultiStageSystem';

// Import setStageLevelThrottle to directly control engine throttle in automated simulation
// (bypassing the player-input throttle ramp system from applyMultiStageThrottle).
// calculateTotalMass is not needed here because the dynamic pressure check uses
// state.velocity directly (kinetic energy per unit volume) rather than force/mass.
import { setStageLevelThrottle } from './MultiStageSystem';

// Import the physics engine's initial state factory and main update function
import {
  createMultiStageRocket,
  updatePhysics,
  calculateLandingScore,
} from './engine';

// Import SimulationConfig type to build the world config (gravity, wind, drag)
import type { SimulationConfig } from './types';

// Import all physics constants needed for the simulation world
import {
  GRAVITY,           // 9.81 m/s² — Earth surface gravity
  DRAG_COEFFICIENT,  // Simplified air resistance coefficient
  ROCKET_RADIUS,     // Rocket body radius for drag calculations
  PHYSICS_TICK_RATE, // 60 Hz — stored but not directly used (we use our own dt)
  MAX_TILT_ANGLE,    // Maximum allowed tilt angle before clamping (radians)
} from '../utils/constants';

// We import PHYSICS_TICK_RATE to keep track of what the original rate was, but our
// Monte Carlo uses a coarser 10 Hz step (0.1s) for speed. The _UNUSED suffix marks it.
void PHYSICS_TICK_RATE; // Suppress unused import warning — kept for documentation

// ─── INTERFACES ─────────────────────────────────────────────────────────────────

/**
 * A single point in a trajectory, enhanced with a timestamp.
 * We need timestamps (not just x,y) so we can interpolate trajectories at
 * uniform time points when computing the statistical envelope.
 *
 * WITHOUT timestamps: two runs that lasted 200s and 80s would have point arrays
 * of different "speed" — we couldn't compare them at the same flight moment.
 *
 * WITH timestamps: we can ask "where was each run at T+50s?" and average them.
 */
export interface MCTrajectoryPoint {
  x: number;  // Horizontal position in meters east of launch pad
  y: number;  // Altitude above ground in meters (clamped to ≥ 0)
  t: number;  // Simulation time in seconds since engine ignition
}

/**
 * The randomly sampled parameter values actually applied to a specific run.
 * Stored so the UI can show the player WHICH dispersions caused WHICH trajectory.
 *
 * DISPERSION in aerospace: the spread or deviation from the nominal (designed) value.
 * Multipliers: 1.0 = no change, 1.03 = 3% higher, 0.98 = 2% lower.
 */
export interface DispersionValues {
  thrustMultiplier: number;    // Applied to engineThrust on all stages (1.0 ± 3%)
  dryMassMultiplier: number;   // Applied to dryMass on all stages (1.0 ± 2%)
  fuelMassMultiplier: number;  // Applied to fuelCapacity/fuelMass (1.0 ± 1%)
  ispMultiplier: number;       // Applied to specificImpulse — affects fuel efficiency
  windSpeedX: number;          // Horizontal wind (m/s, negative = headwind if tilting right)
  ignitionDelay: number;       // Extra seconds before stage 0 ignites (±0.1s)
  thrustVectorOffset: number;  // Constant angle bias on thrust direction (radians, ±0.5°)
}

/**
 * All results from a single completed automated flight simulation.
 *
 * This represents one "throw of the dice" in the Monte Carlo analysis —
 * one possible outcome from the probability distribution of initial conditions.
 */
export interface SimulationRun {
  id: number;                                    // 0-based run index (0 to numberOfRuns-1)
  trajectoryHistory: MCTrajectoryPoint[];        // Position history with timestamps (for envelope)
  maxAltitude: number;                           // Peak altitude achieved (meters)
  maxVelocity: number;                           // Maximum total speed reached (m/s)
  flightTime: number;                            // Duration from ignition to landing (seconds)
  landingPosition: { x: number; y: number };    // Where it landed relative to launch pad (m)
  landingVelocity: number;                       // Impact speed at touchdown (m/s, positive magnitude)
  landingScore: number;                          // Quality score 0-100 (100 = perfect soft landing)
  stagesSeparated: number;                       // How many staging events occurred
  dispersionsApplied: DispersionValues;          // The random values that shaped this run
  outcome: 'nominal' | 'partial_failure' | 'engine_failure' | 'structural_failure';
  failureDescription?: string;                   // Human-readable explanation of what failed and when
}

/**
 * Configures how many runs to simulate and what range of random variations to apply.
 *
 * DISPERSION DESIGN PRINCIPLES:
 * Each dispersion value represents a real-world uncertainty source:
 *   - Engine tolerances (thrust ±3%): Merlin engines are tested to ±3% per SpaceX papers
 *   - Mass uncertainty (dry ±2%): Structure manufacturing variation
 *   - Fuel loading (±1%): Cryogenic propellant density changes with temperature
 *   - Wind (0-15 m/s): Covers ground-level breeze to jet-stream altitudes
 *   - Isp variation (±1.5%): Engine chemistry and mixing ratio variance
 *   - Ignition timing (±0.1s): Valve actuation latency scatter
 *   - Gimbal offset (±0.5°): TVC system backlash and sensor calibration error
 */
export interface MonteCarloConfig {
  numberOfRuns: number;       // How many simulations to run (10, 25, 50, or 100)
  dispersions: {
    thrustPercent: number;             // ±% applied to engine thrust on all stages (default: 3)
    dryMassPercent: number;            // ±% applied to structural dry mass (default: 2)
    fuelMassPercent: number;           // ±% applied to initial fuel loading (default: 1)
    windSpeedMax: number;              // Max random wind speed in m/s (default: 15)
    ispPercent: number;                // ±% applied to specific impulse efficiency (default: 1.5)
    ignitionTimingSeconds: number;     // ±seconds of stage 0 ignition delay (default: 0.1)
    thrustVectorDegrees: number;       // ±degrees of constant thrust vector bias (default: 0.5)
  };
  includeFailureScenarios: boolean;   // Whether to inject random failure events
  failureProbability: number;         // Fraction of runs that experience a failure (default: 0.05)
}

/**
 * Statistical summary and envelope computed from all completed runs.
 *
 * TRAJECTORY ENVELOPE:
 * The envelope describes the "tube" of space that contains all trajectories.
 * It is computed by:
 *   1. Resampling all trajectories at 100 uniform time points (T+0 to T+maxFlightTime)
 *   2. At each time point, computing the 5th percentile and 95th percentile altitude
 *   3. The upper bound curve is the 95th percentile at each time point
 *   4. The lower bound curve is the 5th percentile at each time point
 *
 * This means: 90% of all possible trajectories will fall WITHIN the envelope.
 *
 * CONFIDENCE INTERVAL (95% CI on altitude):
 * If we ran infinite simulations, 95% of peak altitudes would fall between
 * altitudeConfidenceInterval95.low and altitudeConfidenceInterval95.high.
 * With 50 runs, this is an estimate but still useful for planning margin.
 */
export interface MonteCarloResults {
  runs: SimulationRun[];                            // All individual run data
  statistics: {
    meanMaxAltitude: number;                        // Average of all runs' peak altitudes (meters)
    stdDevAltitude: number;                         // Standard deviation — spread around mean
    meanLandingVelocity: number;                    // Average landing impact speed (m/s)
    successRate: number;                            // Fraction of 'nominal' outcome runs (0-1)
    medianFlightTime: number;                       // Middle value of flight durations (seconds)
    altitudeConfidenceInterval95: {
      low: number;                                  // 5th percentile max altitude across runs
      high: number;                                 // 95th percentile max altitude across runs
    };
    landingDispersionRadius: number;                // Mean distance from mean landing point (meters)
    // This "dispersion radius" is the 1-sigma (68%) landing accuracy — how scattered
    // the landing zone is across runs. Real rockets aim for < 10 m; capsules < 5 km.
  };
  trajectoryEnvelope: {
    upper: Array<{ x: number; y: number }>;        // 95th percentile altitude at each time point
    lower: Array<{ x: number; y: number }>;        // 5th percentile altitude at each time point
    mean: Array<{ x: number; y: number }>;         // Mean position (x and y) at each time point
  };
}

// ─── DEFAULTS ────────────────────────────────────────────────────────────────────

/**
 * Create a MonteCarloConfig with sensible defaults based on real aerospace tolerances.
 * Users can customize all values via the configuration panel before running.
 */
export function createDefaultMonteCarloConfig(): MonteCarloConfig {
  return {
    numberOfRuns: 50,            // 50 runs: enough for statistics, fast enough to run live
    dispersions: {
      thrustPercent: 3,          // ±3%: matches reported Merlin 1D thrust tolerance
      dryMassPercent: 2,         // ±2%: structural weight variation between vehicles
      fuelMassPercent: 1,        // ±1%: cryogenic propellant density uncertainty
      windSpeedMax: 15,          // 0-15 m/s: covers calm to strong boundary-layer wind
      ispPercent: 1.5,           // ±1.5%: engine chemistry and mixture ratio variation
      ignitionTimingSeconds: 0.1,// ±0.1s: valve actuation latency (100 ms scatter)
      thrustVectorDegrees: 0.5,  // ±0.5°: TVC gimbal zero-offset calibration error
    },
    includeFailureScenarios: true,  // Enable failure injection by default for realism
    failureProbability: 0.05,       // 5% failure rate: ~2-3 failures in a 50-run batch
  };
}

// ─── DISPERSION APPLICATION ─────────────────────────────────────────────────────

/**
 * Deep-copy a rocket configuration and apply random dispersions to all parameters.
 *
 * WHY DEEP COPY?
 * The physics engine MUTATES the config in place (it burns fuel, changes throttle, etc.).
 * If we passed the same config to all runs, they would corrupt each other.
 * Each run MUST start with an independent copy of the rocket.
 *
 * HOW DISPERSIONS ARE SAMPLED:
 * We use a UNIFORM distribution: each parameter is equally likely to be anywhere
 * in its ±% range. A Gaussian distribution would be more physically accurate
 * (manufacturing follows normal distributions), but uniform is simpler to code
 * and still produces valid statistical spread.
 *
 * @param baseConfig   The rocket configuration to clone (not mutated)
 * @param dispersions  The ±% ranges for each parameter
 * @returns            A new config with random dispersions applied, plus the values used
 */
function applyDispersions(
  baseConfig: MultiStageRocketConfig,
  dispersions: MonteCarloConfig['dispersions']
): { config: MultiStageRocketConfig; applied: DispersionValues } {
  // Helper: generate a random multiplier uniformly distributed in [1 - pct/100, 1 + pct/100]
  // Example: thrustPercent=3 → multiplier in [0.97, 1.03]
  // Math.random() returns [0, 1); we scale to [-1, 1) then to the desired ±range
  const randMult = (pct: number) => 1 + (Math.random() * 2 - 1) * (pct / 100);

  // Sample each dispersion parameter independently (they're statistically uncorrelated)
  const thrustMultiplier    = randMult(dispersions.thrustPercent);     // ±3% thrust
  const dryMassMultiplier   = randMult(dispersions.dryMassPercent);    // ±2% structure mass
  const fuelMassMultiplier  = randMult(dispersions.fuelMassPercent);   // ±1% fuel loading
  const ispMultiplier       = randMult(dispersions.ispPercent);        // ±1.5% engine efficiency

  // Wind: uniform between -max and +max (negative = leftward, positive = rightward)
  // Real wind is directional; in 2D simulation we model the horizontal component only
  const windSpeedX = (Math.random() * 2 - 1) * dispersions.windSpeedMax;

  // Ignition delay: small timing jitter on when stage 0 engine fires
  const ignitionDelay = (Math.random() * 2 - 1) * dispersions.ignitionTimingSeconds;

  // Thrust vector offset: constant angular bias applied throughout powered flight
  // Converts degrees to radians since the physics engine uses radians for angles
  const thrustVectorOffset = (Math.random() * 2 - 1) * dispersions.thrustVectorDegrees * (Math.PI / 180);

  // Deep-copy the rocket config with dispersions applied to each stage
  const config: MultiStageRocketConfig = {
    ...baseConfig,          // Shallow copy of top-level fields (name, payloadMass)
    stages: baseConfig.stages.map(stage => {
      // Apply Isp dispersion to specific impulse
      const newIsp   = stage.specificImpulse * ispMultiplier;
      // Apply thrust dispersion to max engine thrust
      const newThrust = stage.engineThrust * thrustMultiplier;
      // Recalculate burn rate from new thrust and Isp using the rocket equation:
      //   burnRate = thrust / (g₀ × Isp)
      // If thrust goes up 3% AND Isp goes down 1.5%, burn rate increases ~4.6% — larger effect
      const newBurnRate = newThrust / (9.81 * newIsp);
      // Apply mass dispersions to structural weight
      const newDryMass = stage.dryMass * dryMassMultiplier;
      // Apply fuel loading dispersion — both capacity and initial fill amount change together
      // This models: tank was slightly over- or under-filled compared to design specification
      const newFuelCapacity = stage.fuelCapacity * fuelMassMultiplier;

      // Return a new stage object with all dispersed values
      return {
        ...stage,                        // Copy all other stage fields (stageNumber, name, etc.)
        engineThrust: newThrust,         // Dispersed thrust
        specificImpulse: newIsp,         // Dispersed efficiency
        burnRate: newBurnRate,           // Recalculated from dispersed thrust/Isp
        dryMass: newDryMass,             // Dispersed structural mass
        fuelCapacity: newFuelCapacity,   // Dispersed max fuel capacity
        fuelMass: newFuelCapacity,       // Start FULL: initial fuel = dispersed capacity
        // Stage status resets: not separated, not thrusting, throttle at zero
        isActive: stage.stageNumber === 0, // Only stage 0 starts active (same as original)
        isSeparated: false,              // No stage jettisoned at launch
        isThrusting: false,              // Engine off until ignition command
        thrustPercentage: 0,             // Throttle starts at zero (autopilot ramps it up)
      };
    }),
  };

  // Bundle the applied dispersion values for display in results UI
  const applied: DispersionValues = {
    thrustMultiplier,
    dryMassMultiplier,
    fuelMassMultiplier,
    ispMultiplier,
    windSpeedX,
    ignitionDelay,
    thrustVectorOffset,
  };

  return { config, applied };
}

// ─── SINGLE RUN SIMULATION ───────────────────────────────────────────────────────

/**
 * Physics time step for Monte Carlo runs.
 *
 * WHY 0.1s (10 Hz) instead of 1/60s (60 Hz) like the game loop?
 * 60 Hz × 800 seconds = 48,000 physics steps per run.
 * At 50 runs, that's 2,400,000 total steps. Each step calls updatePhysics()
 * which is ~10 µs → 24 seconds of computation. TOO SLOW.
 *
 * 10 Hz × 800 seconds = 8,000 steps per run.
 * At 50 runs: 400,000 steps → ~4 seconds of computation. Acceptable.
 *
 * Euler integration error at Δt=0.1s is still small relative to flight durations
 * of 100-800 seconds. The trajectory will be smooth enough for statistical analysis.
 */
const MC_DT = 0.1; // Seconds per physics step in Monte Carlo mode (10 Hz)

/**
 * Maximum number of physics steps per simulation run.
 * 8000 steps × 0.1s = 800 seconds = ~13 minutes of simulated flight.
 * This safely covers even the longest multi-stage flights without infinite loops.
 */
const MC_MAX_STEPS = 8000;

/**
 * Record a trajectory point every N physics steps to limit memory usage.
 * Every 5 steps at 0.1s/step = record every 0.5 seconds.
 * A 400-second flight → 800 recorded points per run.
 * At 100 runs: 80,000 points total — manageable for the canvas renderer.
 */
const MC_TRAJ_SAMPLE_EVERY = 5;

/**
 * Structural failure dynamic pressure limit for WEAKENED rockets (Pascals).
 * Normal rockets withstand 30-40 kPa at max-Q.
 * A rocket with structural damage (failure mode) fails at this lower threshold.
 * This represents a crack or weakened joint that reduces the safety margin.
 */
const STRUCTURAL_FAILURE_Q_LIMIT = 10000; // 10 kPa — significantly below normal 35 kPa

/**
 * Run a complete automated flight simulation for a single Monte Carlo run.
 *
 * AUTOMATED FLIGHT PROFILE (what the autopilot does):
 *   T+0s:     Engine ignition commanded (throttle begins ramping)
 *   T+0-2s:   Throttle ramps from 0% → 100% (engine spooling, like real rockets)
 *   T+2-10s:  Full 100% throttle, rocket climbs vertically (hold-down release)
 *   T+10-70s: Pitch program — gravity turn from 0° to 45° tilt (over 60 seconds)
 *             This is the "gravity turn" maneuver used on all orbital launches.
 *             Tilting converts vertical velocity into horizontal velocity (for orbit).
 *   T+70s+:   Maintain 45° tilt until fuel exhaustion
 *   Staging:  Automatic (handled by updatePhysics via checkAndPerformStaging)
 *   Burnout:  All stages empty → coast phase (ballistic trajectory, no thrust)
 *   Coast:    Angular physics takes over — restoring force gradually straightens rocket
 *   Below 5km descending: 8× drag simulates parachute deployment
 *   Landing:  hasLanded flag set when position.y ≤ 0
 *
 * GRAVITY TURN (explanation for comments):
 * Named because gravity itself provides the turning force. The rocket starts vertical
 * (perpendicular to gravity), then tilts slightly. Gravity pulls the nose downward,
 * which turns the velocity vector. The engine keeps pointing along the new velocity
 * direction. This is more efficient than steering: you're using gravity "for free."
 * Every rocket from Saturn V to Falcon 9 to New Shepard uses a gravity turn.
 *
 * @param id           Run index (0-based) for identification in results
 * @param baseConfig   Original rocket configuration (not mutated)
 * @param mcConfig     Monte Carlo configuration (dispersions, failures)
 * @returns            Complete SimulationRun with trajectory and statistics
 */
function simulateOneRun(
  id: number,
  baseConfig: MultiStageRocketConfig,
  mcConfig: MonteCarloConfig
): SimulationRun {
  // ── APPLY DISPERSIONS ─────────────────────────────────────────────────────
  // Create a dispersed copy of the rocket config for this specific run.
  // Every run gets its own independent random draw from the dispersion distributions.
  const { config, applied } = applyDispersions(baseConfig, mcConfig.dispersions);

  // ── CREATE INITIAL FLIGHT STATE ───────────────────────────────────────────
  // Fresh state: rocket on the pad, no velocity, no rotation, all gauges at zero.
  const state = createMultiStageRocket(config);

  // ── PER-RUN RANDOM PARAMETERS ─────────────────────────────────────────────

  // Wind: horizontal wind applied throughout the simulation.
  // Stored separately from 'applied' because it shapes the simConfig, not the rocket.
  const windSpeedX = applied.windSpeedX;

  // Ignition delay: how many seconds after T=0 before stage 0 throttle begins ramping.
  // A negative value means "ignites slightly early" — throttle ramp starts immediately (clamped to T=0).
  const ignitionDelay = applied.ignitionDelay;

  // Thrust vector offset: a fixed angle bias applied on top of the autopilot's commanded angle.
  // Represents gimbal zero-offset calibration error — the rocket points slightly "wrong" all flight.
  const thrustVectorOffset = applied.thrustVectorOffset;

  // Pitch noise: a systematic bias in the pitch program angle, representing autopilot trim error.
  // Different from thrust vector offset: this affects how far the gravity turn goes, not the direction.
  // Sampled from ±2° — some runs tilt to 43°, some to 47° at the end of the pitch program.
  const pitchNoiseDeg = (Math.random() * 2 - 1) * 2; // ±2 degrees
  const pitchNoise = pitchNoiseDeg * (Math.PI / 180); // Convert to radians

  // Gravity turn direction: +1 = turns right (positive X), -1 = turns left (negative X).
  // In real missions, the azimuth is fixed (e.g., "launch east for orbital mechanics").
  // For Monte Carlo visual spread, we randomize this so trajectories fan in both directions,
  // creating the "starburst" pattern seen in aerospace trajectory dispersion analysis.
  // This models different launch azimuth dispersions or heading error.
  const gravityTurnSign = Math.random() < 0.5 ? 1 : -1;

  // ── FAILURE SCENARIO SETUP ────────────────────────────────────────────────
  // Determine whether this run experiences a failure and what kind.
  // 5% of runs (by default) will have a failure injected at a random mid-flight time.
  //
  // FAILURE MODES (modeling real rocket failure statistics):
  //   Engine shutdown (50%): One engine cuts out mid-burn — most common failure type
  //   Fuel leak (20%): Propellant line rupture causes rapid fuel loss — rare but dramatic
  //   Structural (15%): Weakened airframe buckles at max-Q — aerodynamic loads event
  //   Guidance (15%): Flight computer locks up, thrust vector freezes — avionics failure
  type FailureMode = 'none' | 'engine_shutdown' | 'fuel_leak' | 'structural' | 'guidance';
  let failureMode: FailureMode = 'none';
  let failureTime = Infinity; // Time (seconds) when failure begins — infinity = no failure

  if (mcConfig.includeFailureScenarios && Math.random() < mcConfig.failureProbability) {
    // This run is unlucky — a failure will be injected
    const failureRoll = Math.random(); // Second random draw to determine failure type
    if      (failureRoll < 0.50) failureMode = 'engine_shutdown'; // 50% of failures
    else if (failureRoll < 0.70) failureMode = 'fuel_leak';        // 20% of failures
    else if (failureRoll < 0.85) failureMode = 'structural';       // 15% of failures
    else                          failureMode = 'guidance';          // 15% of failures

    // Failure occurs at a random time between T+10s and T+80s.
    // T+10 is after initial ascent; T+80 covers most of the powered phase.
    // Failures early in flight (T+5-10) are too common and unrealistic; we skip them.
    failureTime = 10 + Math.random() * 70; // T+10 to T+80 seconds
  }

  // Flags to track whether each failure has been triggered (prevents repeated application)
  let engineShutdownApplied = false; // True after engine shutdown failure has been applied once
  let guidanceLocked = false;         // True once guidance failure locks the angle
  let guidanceLockedAngle = 0;        // The angle at which guidance froze (radians)
  let structurallyFailed = false;     // True if structural failure terminated the flight
  let failureDescription: string | undefined; // Human-readable failure text for the UI

  // ── RESULT TRACKERS ──────────────────────────────────────────────────────
  // Variables that accumulate statistics throughout the simulation loop
  const trajectoryHistory: MCTrajectoryPoint[] = []; // Recorded positions with timestamps
  let maxVelocity = 0;  // Peak total speed achieved (m/s), used for statistics
  let outcome: SimulationRun['outcome'] = 'nominal'; // Start optimistic — update if failure occurs

  // ── SIMULATION CONFIG FOR THIS RUN ────────────────────────────────────────
  // The SimulationConfig defines the world environment (gravity, wind, drag, etc.)
  // We build one per run but modify dragCoefficient dynamically for parachute simulation.
  const baseSimConfig: SimulationConfig = {
    gravity:         GRAVITY,          // 9.81 m/s² — always constant for this Earth simulation
    windSpeed:       { x: windSpeedX, y: 0 }, // Horizontal wind from dispersion; no vertical wind
    dragCoefficient: DRAG_COEFFICIENT, // Base drag = 0.1 — multiplied 8× when parachute active
    rocketRadius:    ROCKET_RADIUS,    // Rocket body radius for drag cross-section
    timeStep:        MC_DT,            // Physics step rate — stored for reference in simConfig
  };

  // Record initial position at T=0 (on the launchpad, x=0, y=0, t=0)
  trajectoryHistory.push({ x: 0, y: 0, t: 0 });

  // ── MAIN SIMULATION LOOP ──────────────────────────────────────────────────
  // Each iteration advances the simulation by MC_DT (0.1 seconds).
  // The loop exits when the rocket lands, fails structurally, or hits the step limit.
  for (let step = 0; step < MC_MAX_STEPS; step++) {
    // Current simulation time at the START of this step (before physics advances it)
    const t = state.timeElapsed;

    // ── THROTTLE CONTROL (AUTOPILOT) ──────────────────────────────────────
    // Stage 0 throttle: ramp from 0% to 100% over 2 seconds starting at ignitionDelay.
    // Stage 1+ throttle: set to 100% automatically by checkAndPerformStaging() (inside updatePhysics).
    // We only manage stage 0 here; subsequent stages self-ignite at full throttle.
    const stage0 = config.stages[0]; // First stage (bottom of the stack)
    if (stage0 && !stage0.isSeparated && stage0.isActive) {
      // Time since the ignition command was issued (may be negative if before ignition delay)
      const timeSinceIgnition = t - ignitionDelay;
      if (timeSinceIgnition >= 0) {
        // Throttle ramp: 0% at T+0 → 100% at T+2 (linear ramp over 2 seconds)
        // This mirrors real rocket ignition sequences where turbopumps spin up gradually.
        // Math.min(100, ...) clamps to 100% once the 2-second ramp is complete.
        const rampedThrottle = Math.min(100, (timeSinceIgnition / 2) * 100);
        setStageLevelThrottle(stage0, rampedThrottle);
      } else {
        // Before ignition delay: engine is off (hold-down period)
        setStageLevelThrottle(stage0, 0);
      }
    }

    // ── FUEL LEAK FAILURE (extra consumption, applied before physics) ──────
    // A fuel leak causes propellant to escape 10× faster than normal combustion.
    // We apply the EXTRA 9× leak here (the normal 1× burn happens inside updatePhysics).
    // Combined effect: total fuel consumption = 10× design rate from failure time onward.
    if (failureMode === 'fuel_leak' && t >= failureTime) {
      for (const stage of config.stages) {
        // Only affect stages that are currently burning (active, not separated, has fuel)
        if (stage.isActive && !stage.isSeparated && stage.fuelMass > 0 && stage.isThrusting) {
          // Extra leak = 9× the normal burn rate, scaled by throttle and time step
          // This rapidly depletes the tank: a full 2000 kg tank at 20 kg/s burns to empty in 100s normally
          // but with a 10× leak it's gone in 10s — catastrophically shortened burn time
          const extraLeak = stage.burnRate * (stage.thrustPercentage / 100) * 9 * MC_DT;
          stage.fuelMass = Math.max(0, stage.fuelMass - extraLeak); // Clamp to zero (can't have negative fuel)
          if (!failureDescription) {
            // Set failure description on first frame of the leak (t is approximately failureTime)
            failureDescription = `Fuel leak at T+${failureTime.toFixed(0)}s — burn depleted in ~${(stage.fuelMass / (stage.burnRate * 10)).toFixed(0)}s`;
            outcome = 'partial_failure'; // Rocket flew but with dramatically reduced performance
          }
        }
      }
    }

    // ── ENGINE SHUTDOWN FAILURE ────────────────────────────────────────────
    // At failure time, permanently halve the thrust on the active stage.
    // Models one engine in a multi-engine cluster cutting out (e.g., 1 of 2 engines).
    // Applied ONCE via the shutdownApplied flag to prevent repeated halving each step.
    if (failureMode === 'engine_shutdown' && t >= failureTime && !engineShutdownApplied) {
      engineShutdownApplied = true; // Mark as applied so this block runs exactly once
      const affectedStage = config.stages.find(s => s.isActive && !s.isSeparated && s.fuelMass > 0);
      if (affectedStage) {
        affectedStage.engineThrust *= 0.5; // Halve max thrust — models 1 of 2 engines cutting out
        // Recalculate burn rate for the reduced thrust (less thrust = proportionally less fuel flow)
        affectedStage.burnRate = affectedStage.engineThrust / (9.81 * affectedStage.specificImpulse);
        failureDescription = `Engine shutdown at T+${t.toFixed(0)}s — thrust reduced to 50%`;
        outcome = 'engine_failure'; // Classify as an engine failure outcome
      }
    }

    // ── ANGLE/PITCH CONTROL (AUTOPILOT) ──────────────────────────────────
    // Determine the desired rocket orientation based on the flight phase.
    // The gravity turn pitch program is the key maneuver for efficient ascent.
    //
    // GRAVITY TURN MATH:
    // targetAngle = 0 (vertical) at T+10s, linearly increases to 45° at T+70s.
    // pitchProgress = (t - 10) / 60 goes from 0 to 1 over the 60-second program.
    // finalAngle = π/4 (45°) × direction × (1 + noise).
    let targetAngle = 0; // Default: vertical (0 radians = straight up)

    if (t >= 10 && t <= 70) {
      // Mid-pitch-program: linearly interpolate from 0° to 45°
      const pitchProgress = (t - 10) / 60; // 0 at T+10, 1 at T+70
      // Final pitch angle: 45° in the gravity turn direction, plus per-run noise
      const finalAngle = (Math.PI / 4 + pitchNoise) * gravityTurnSign;
      targetAngle = finalAngle * pitchProgress; // Gradually approach final angle
    } else if (t > 70) {
      // Post-pitch-program: hold the final 45° attitude
      targetAngle = (Math.PI / 4 + pitchNoise) * gravityTurnSign;
    }

    // Add the constant thrust vector offset (TVC bias) on top of the program angle
    targetAngle += thrustVectorOffset;

    // Guidance failure: the flight computer froze — lock the angle at failure time
    if (failureMode === 'guidance' && t >= failureTime && !guidanceLocked) {
      guidanceLocked = true;             // Latch the lock flag (only lock once)
      guidanceLockedAngle = state.angle; // Freeze at whatever angle the rocket was at
      failureDescription = `Guidance failure at T+${t.toFixed(0)}s — thrust vector locked at ${(state.angle * 180 / Math.PI).toFixed(1)}°`;
      outcome = 'partial_failure'; // Rocket continues flying but uncontrolled
    }

    // Determine whether any stage is currently thrusting (powered flight vs. coast)
    // During powered flight, the autopilot overrides natural angular physics.
    // During coast phase, we let the restoring force and damping act naturally.
    const anyStageThrusting = config.stages.some(
      s => s.isActive && !s.isSeparated && s.fuelMass > 0 && s.thrustPercentage > 0
    );

    if (anyStageThrusting) {
      // POWERED FLIGHT: override the physics engine's angular dynamics with autopilot command.
      // Without this override, the restoring force and damping would fight the pitch program.
      // Set the angle directly and zero out angular velocity for clean autopilot control.
      const effectiveAngle = guidanceLocked ? guidanceLockedAngle : targetAngle;
      // Clamp to the same maximum tilt as the player can achieve (safety limit)
      state.angle = Math.max(-MAX_TILT_ANGLE, Math.min(MAX_TILT_ANGLE, effectiveAngle));
      state.angularVelocity = 0; // No rotation when autopilot is commanding a specific angle
    }
    // COAST PHASE: don't touch angle or angularVelocity — the physics engine's
    // restoring force (ANGULAR_RESTORE_RATE) will gradually straighten the rocket.
    // This produces a natural tumbling/stabilizing behavior during ballistic coast.

    // ── PARACHUTE SIMULATION ───────────────────────────────────────────────
    // Below 5 km altitude while descending, multiply drag by 8× to simulate
    // a deployed parachute slowing the rocket for a survivable landing.
    // A real parachute creates a drag force ∝ v², but this simplified drag increase
    // via dragCoefficient is close enough for statistical analysis purposes.
    const parachuteActive = state.position.y < 5000 && state.velocity.y < -5;
    const simConfigForStep: SimulationConfig = {
      ...baseSimConfig,
      // 8× drag when parachute active (slows descent from ~50 m/s to ~10 m/s)
      // Without parachute: 0.1 drag. With parachute: 0.8 drag (8× multiplier).
      dragCoefficient: parachuteActive ? baseSimConfig.dragCoefficient * 8 : baseSimConfig.dragCoefficient,
    };

    // ── PHYSICS STEP ──────────────────────────────────────────────────────
    // Run one time step of the full physics simulation.
    // This handles: staging, thrust, gravity, drag, wind, fuel consumption,
    // angular physics, and ground detection — all in one call.
    const frame = updatePhysics(state, config, simConfigForStep, MC_DT);

    // ── STRUCTURAL FAILURE CHECK (post-physics, uses updated velocity) ────
    // Dynamic pressure q = ½ρv² measures how hard the air is pushing on the rocket.
    // At q > structural limit, the airframe buckles. This is called "Max-Q" in real launches.
    // Max-Q for Falcon 9 is ~35 kPa at ~15 km altitude. Our weakened-structure limit is 10 kPa.
    if (failureMode === 'structural' && t >= failureTime && !structurallyFailed) {
      // Exponential atmosphere: density decreases with scale height H = 8,500 m
      // ρ(h) = ρ₀ × exp(-h / 8500) where ρ₀ = 1.225 kg/m³ at sea level
      const airDensity = 1.225 * Math.exp(-state.position.y / 8500);
      // Total speed = magnitude of velocity vector
      const speed = Math.sqrt(state.velocity.x * state.velocity.x + state.velocity.y * state.velocity.y);
      // Dynamic pressure: kinetic energy per unit volume of airstream
      const dynamicPressure = 0.5 * airDensity * speed * speed;

      if (dynamicPressure > STRUCTURAL_FAILURE_Q_LIMIT) {
        // Airframe buckles — flight ends here
        structurallyFailed = true;
        failureDescription = `Structural failure at T+${t.toFixed(0)}s — Max-Q exceeded (q=${(dynamicPressure / 1000).toFixed(1)} kPa)`;
        outcome = 'structural_failure';
        // Record the failure point as the last trajectory point before breaking
        trajectoryHistory.push({ x: state.position.x, y: Math.max(0, state.position.y), t });
        break; // Terminate the simulation — rocket no longer exists
      }
    }

    // ── VELOCITY TRACKING ─────────────────────────────────────────────────
    // Track the maximum total speed for statistics (used in summary panel).
    const totalSpeed = Math.sqrt(
      state.velocity.x * state.velocity.x + state.velocity.y * state.velocity.y
    );
    if (totalSpeed > maxVelocity) maxVelocity = totalSpeed; // New speed record for this run

    // ── TRAJECTORY RECORDING ───────────────────────────────────────────────
    // Record one trajectory point every MC_TRAJ_SAMPLE_EVERY steps (every 0.5 seconds).
    // This balances trajectory resolution against memory usage.
    // Math.max(0, ...) prevents negative altitude from appearing in the trajectory plot
    // (the rocket technically goes to y=0 at landing but numerical noise could give -0.001).
    if (step % MC_TRAJ_SAMPLE_EVERY === 0) {
      trajectoryHistory.push({
        x: state.position.x,
        y: Math.max(0, state.position.y), // Clamp altitude to ground level
        t: state.timeElapsed,             // Current simulation time (already incremented by updatePhysics)
      });
    }

    // ── LANDING DETECTION ──────────────────────────────────────────────────
    // The physics engine sets hasLanded=true when the rocket returns to y≤0.
    // frame.groundImpact is a one-shot edge-trigger for the moment of impact.
    if (frame.groundImpact || state.hasLanded) {
      // Record the exact landing point before exiting the loop
      trajectoryHistory.push({
        x: state.position.x,
        y: 0, // Exactly at ground level
        t: state.timeElapsed,
      });
      break; // Landing complete — exit simulation loop
    }
  } // end simulation loop

  // ── COMPUTE FINAL STATISTICS ───────────────────────────────────────────
  // Gather all the results from the completed simulation into a SimulationRun object.

  // Final landing position — wherever the rocket stopped horizontally
  const landingPosition = { x: state.position.x, y: 0 };

  // Landing velocity magnitude — absolute value so it's always positive in the UI
  const landingVelocity = Math.abs(state.landingVelocity);

  // Landing quality score 0-100 based on impact speed
  const landingScore = calculateLandingScore(state.landingVelocity);

  // Update outcome if a failure was set but no description yet (shouldn't normally happen)
  if (failureMode !== 'none' && failureDescription && outcome === 'nominal') {
    outcome = 'partial_failure';
  }

  // Build and return the complete simulation run result
  return {
    id,
    trajectoryHistory,
    maxAltitude: state.maxAltitudeReached,          // Peak altitude from the flight state tracker
    maxVelocity,                                      // Maximum speed during the entire flight
    flightTime: state.timeElapsed,                   // Total duration from T=0 to landing/failure
    landingPosition,
    landingVelocity,
    landingScore,
    stagesSeparated: state.stageSeparationCount,     // Number of staging events that occurred
    dispersionsApplied: applied,                     // The random values used — for display/debugging
    outcome,
    failureDescription,
  };
}

// ─── STATISTICS COMPUTATION ─────────────────────────────────────────────────────

/**
 * Compute mean (average) of an array of numbers.
 * Mean = sum of all values / count of values.
 * The arithmetic mean is the "central tendency" — the expected value.
 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0; // Guard against empty array (no runs = 0)
  return arr.reduce((sum, v) => sum + v, 0) / arr.length; // Sum divided by count
}

/**
 * Compute population standard deviation of an array.
 * Std dev measures the SPREAD around the mean — larger = more variable results.
 * In aerospace, std dev is the "1-sigma" uncertainty used for trajectory analysis.
 *
 * Formula: σ = √(Σ(xᵢ - μ)² / n)
 * where μ is the mean and n is the count.
 *
 * @param arr  Array of values
 * @param m    Pre-computed mean (pass to avoid recomputing)
 */
function stdDev(arr: number[], m: number): number {
  if (arr.length === 0) return 0; // No data = zero variance
  const variance = arr.reduce((sum, v) => sum + (v - m) * (v - m), 0) / arr.length;
  return Math.sqrt(variance); // Square root converts variance → standard deviation
}

/**
 * Compute a percentile from a sorted array using linear interpolation.
 *
 * WHY PERCENTILES MATTER IN MONTE CARLO:
 * The 95th percentile altitude means "95% of all simulated flights reached AT LEAST this altitude."
 * Mission planners use percentiles to define success criteria:
 *   - "We need 90% probability of reaching X altitude" → check 10th percentile ≥ X
 *   - "Worst 5% of runs should still clear Y altitude" → check 5th percentile ≥ Y
 *
 * @param sorted  Array sorted in ascending order (caller must sort first)
 * @param p       Percentile 0-100 (e.g., 95 for the 95th percentile)
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0; // No data case
  // Convert percentile to 0-1 fraction and scale to array index
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);  // Lower index for interpolation
  const hi = Math.ceil(idx);   // Upper index for interpolation
  if (lo === hi) return sorted[lo]; // Exact integer index — no interpolation needed
  // Linear interpolation between the two surrounding values
  const frac = idx - lo; // Fractional part: how far between lo and hi
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac; // Blend lo and hi values
}

/**
 * Interpolate trajectory position at a specific simulation time.
 * Uses binary search to find the surrounding points, then linearly interpolates.
 *
 * WHY INTERPOLATION IS NEEDED:
 * Different runs have different flight durations. Run A might last 420s, Run B might last 380s.
 * To compare "where was each rocket at T+200s?", we need to look up positions at a
 * uniform time grid, which requires interpolating between the recorded points.
 *
 * After the flight ends (t > flightTime), the rocket is on the ground (y=0) at its
 * final landing position. We return that static ground position.
 *
 * @param trajectory  Array of points with timestamps, in ascending time order
 * @param t           The target time to interpolate at (seconds)
 * @param flightTime  Total flight duration (seconds) — used to detect post-landing queries
 */
function interpolateAtTime(
  trajectory: MCTrajectoryPoint[],
  t: number,
  flightTime: number
): { x: number; y: number } {
  // Edge case: no trajectory data — return launch pad origin
  if (trajectory.length === 0) return { x: 0, y: 0 };

  // After the flight ends, the rocket is stationary on the ground
  // Return the last recorded position (which should be at or near y=0)
  if (t >= flightTime) {
    const last = trajectory[trajectory.length - 1];
    return { x: last.x, y: Math.max(0, last.y) }; // Ensure altitude ≥ 0 (ground level)
  }

  // Binary search: find the two trajectory points that bracket the target time t
  let lo = 0;
  let hi = trajectory.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2); // Midpoint index
    if (trajectory[mid].t <= t) lo = mid;  // Target is after midpoint → search right half
    else hi = mid;                          // Target is before midpoint → search left half
  }

  // We now have trajectory[lo].t <= t <= trajectory[hi].t
  const p0 = trajectory[lo];  // Earlier point
  const p1 = trajectory[hi];  // Later point (might equal lo if at end of array)

  // If the two bounding points are at the same time (shouldn't happen but safety check)
  if (p0.t === p1.t) return { x: p0.x, y: p0.y };

  // Linear interpolation factor: 0 at p0.t, 1 at p1.t
  const alpha = (t - p0.t) / (p1.t - p0.t);

  // Interpolate x and y positions
  return {
    x: p0.x + (p1.x - p0.x) * alpha, // Weighted average of horizontal position
    y: p0.y + (p1.y - p0.y) * alpha, // Weighted average of altitude
  };
}

/**
 * Compute the trajectory envelope from all completed runs.
 *
 * ENVELOPE ALGORITHM:
 *   1. Find the maximum flight time across all runs (longest simulation)
 *   2. For 100 uniformly-spaced time points from T=0 to T=maxFlightTime:
 *      a. Interpolate each run's position at that time point
 *      b. Compute the mean (x,y) → the "mean trajectory"
 *      c. Compute the 5th and 95th percentile of the y values → envelope bounds
 *   3. Return upper (95th percentile), lower (5th percentile), and mean curves
 *
 * The envelope represents the "tube" containing 90% of all possible trajectories.
 * An analyst can say: "if you fire this rocket with these dispersions, the
 * trajectory will fall within this envelope 90% of the time."
 *
 * @param runs  All completed simulation runs with trajectory data
 */
function computeTrajectoryEnvelope(
  runs: SimulationRun[]
): MonteCarloResults['trajectoryEnvelope'] {
  const NUM_POINTS = 100; // Number of time steps at which to evaluate the envelope

  // Find the longest flight duration among all runs
  const maxFlightTime = Math.max(...runs.map(r => r.flightTime));

  // Interval between sample points
  const timeStep = maxFlightTime / (NUM_POINTS - 1);

  const upper: Array<{ x: number; y: number }> = []; // 95th percentile altitude curve
  const lower: Array<{ x: number; y: number }> = []; // 5th percentile altitude curve
  const meanCurve: Array<{ x: number; y: number }> = []; // Mean trajectory curve

  // For each uniformly-spaced time point, gather all runs' positions at that instant
  for (let i = 0; i < NUM_POINTS; i++) {
    const t = i * timeStep; // Current sample time in seconds

    // Interpolate position for each run at this time point
    const positions = runs.map(run =>
      interpolateAtTime(run.trajectoryHistory, t, run.flightTime)
    );

    // Extract x and y arrays from the position objects
    const xs = positions.map(p => p.x); // All horizontal positions at this time
    const ys = positions.map(p => p.y); // All altitudes at this time

    // Compute mean x and mean y — the "center" of the trajectory bundle at this time
    const meanX = mean(xs); // Average horizontal position
    const meanY = mean(ys); // Average altitude

    // Sort y values to compute percentiles (percentile() requires sorted input)
    const sortedYs = [...ys].sort((a, b) => a - b); // Ascending sort

    // 5th percentile altitude: 5% of runs are BELOW this — the "lower bound"
    const p5Y  = percentile(sortedYs, 5);
    // 95th percentile altitude: 95% of runs are BELOW this — the "upper bound"
    const p95Y = percentile(sortedYs, 95);

    // Store mean trajectory point: average x and average y at this time
    meanCurve.push({ x: meanX, y: meanY });
    // Store upper envelope: mean x position with 95th-percentile altitude
    upper.push({ x: meanX, y: p95Y });
    // Store lower envelope: mean x position with 5th-percentile altitude
    lower.push({ x: meanX, y: p5Y });
  }

  return { upper, lower, mean: meanCurve };
}

/**
 * Compute all statistics from the completed simulation runs.
 * This is called once all runs are done, before returning results to the UI.
 *
 * @param runs  All completed simulation runs
 */
function computeMonteCarloResults(runs: SimulationRun[]): MonteCarloResults {
  // Extract arrays of key metrics for statistical computations
  const altitudes     = runs.map(r => r.maxAltitude);     // All peak altitudes (meters)
  const landingVels   = runs.map(r => r.landingVelocity); // All landing speeds (m/s)
  const flightTimes   = runs.map(r => r.flightTime);      // All flight durations (seconds)

  // MEAN MAX ALTITUDE: average of all runs' peak altitudes
  const meanMaxAltitude = mean(altitudes);

  // STD DEV ALTITUDE: 1-sigma spread around the mean altitude
  // A small std dev means runs are tightly clustered; large std dev = wide spread
  const stdDevAltitude = stdDev(altitudes, meanMaxAltitude);

  // MEAN LANDING VELOCITY: average impact speed across all runs
  const meanLandingVelocity = mean(landingVels);

  // SUCCESS RATE: fraction of runs with 'nominal' outcome (no failures, full performance)
  // Expressed as 0-1 (multiply by 100 for percentage display in UI)
  const successRate = runs.filter(r => r.outcome === 'nominal').length / runs.length;

  // MEDIAN FLIGHT TIME: middle value when flight times are sorted ascending
  // Median is more robust than mean when outliers (failures) skew the distribution
  const sortedTimes = [...flightTimes].sort((a, b) => a - b); // Sort ascending
  const medianFlightTime = percentile(sortedTimes, 50);       // 50th percentile = median

  // 95% CONFIDENCE INTERVAL ON MAX ALTITUDE:
  // The interval [5th percentile, 95th percentile] contains 90% of all run altitudes.
  // This is also called the "90% containment interval" in trajectory analysis.
  const sortedAltitudes = [...altitudes].sort((a, b) => a - b); // Must sort first
  const altitudeConfidenceInterval95 = {
    low:  percentile(sortedAltitudes, 5),  // Worst 5% of runs achieved at least this
    high: percentile(sortedAltitudes, 95), // Best 5% of runs exceeded this altitude
  };

  // LANDING DISPERSION RADIUS:
  // Average distance from the mean landing point — measures how scattered the landing zone is.
  // Real rockets target: SpaceX Falcon 9 < 10 m (ASDS landing), Mars missions < 1 km.
  // This is the 1-sigma "CEP" (Circular Error Probable) style metric in 2D.
  const landingXs     = runs.map(r => r.landingPosition.x); // All landing X positions
  const landingYs     = runs.map(r => r.landingPosition.y); // All landing Y positions (≈ 0)
  const meanLandX     = mean(landingXs); // Mean landing horizontal position
  const meanLandY     = mean(landingYs); // Mean landing vertical position (≈ 0 for ground)
  // Distance from each landing to the mean landing point
  const landingRadii  = runs.map(r =>
    Math.sqrt(
      (r.landingPosition.x - meanLandX) * (r.landingPosition.x - meanLandX) +
      (r.landingPosition.y - meanLandY) * (r.landingPosition.y - meanLandY)
    )
  );
  const landingDispersionRadius = mean(landingRadii); // Mean radius = 1-sigma dispersion

  // Compute trajectory envelope (upper, lower, mean curves for visualization)
  const trajectoryEnvelope = computeTrajectoryEnvelope(runs);

  return {
    runs,
    statistics: {
      meanMaxAltitude,
      stdDevAltitude,
      meanLandingVelocity,
      successRate,
      medianFlightTime,
      altitudeConfidenceInterval95,
      landingDispersionRadius,
    },
    trajectoryEnvelope,
  };
}

// ─── MAIN ENTRY POINT ────────────────────────────────────────────────────────────

/**
 * Run the full Monte Carlo simulation asynchronously.
 *
 * EXECUTION MODEL:
 * We use async/await with a helper that yields to the event loop between runs.
 * This pattern — called "cooperative multitasking" — lets the browser render frames
 * and respond to user input between runs, keeping the UI fully responsive.
 *
 * HOW YIELDING WORKS:
 * `setTimeout(resolve, 0)` schedules the resolve callback at the END of the current
 * event loop task. The browser processes all pending UI updates before running the
 * next task. So between each simulation run, the browser gets a chance to render.
 *
 * COMPARED TO WEB WORKERS:
 * Web Workers run on a separate thread (true parallelism). They would be faster but
 * require transferring data via postMessage, which needs serializable types.
 * The current approach is simpler and still fast enough: 50 runs × ~15ms each ≈ 750ms
 * total computation, interleaved with ~50 frame renders. Total wall time: ~2 seconds.
 *
 * @param baseConfig   The rocket to simulate (cloned per run, not mutated)
 * @param mcConfig     How many runs, what dispersions, failure settings
 * @param onProgress   Called after each run with (completedCount, totalCount)
 * @param onComplete   Called once with the full results when all runs finish
 * @returns            Object with a cancel() function to abort the simulation
 */
export function runMonteCarloSimulation(
  baseConfig: MultiStageRocketConfig,
  mcConfig: MonteCarloConfig,
  onProgress: (completed: number, total: number) => void,
  onComplete: (results: MonteCarloResults) => void
): { cancel: () => void } {
  // Cancellation flag: when set to true, the async loop will stop after the current run
  let cancelled = false;

  // Expose a cancel function so the UI can abort mid-simulation
  const cancel = () => { cancelled = true; };

  // Helper: yields to the browser event loop once.
  // This is the key to non-blocking execution — each `await yieldToEventLoop()`
  // gives the browser time to render a frame and handle user interactions.
  const yieldToEventLoop = (): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, 0));

  // Async IIFE (Immediately Invoked Function Expression) to run all simulations
  // in sequence, yielding between each one for UI responsiveness.
  (async () => {
    const allRuns: SimulationRun[] = []; // Accumulates completed runs

    // Run each simulation in sequence (not truly parallel, but interleaved with UI)
    for (let i = 0; i < mcConfig.numberOfRuns; i++) {
      if (cancelled) return; // Check cancellation before each run

      // Yield to browser: allows React to re-render the progress bar
      // and the user to still click buttons while simulation runs
      await yieldToEventLoop();

      if (cancelled) return; // Check again after yield (user might cancel during yield)

      // Run one complete automated flight simulation (synchronous, ~15ms)
      const run = simulateOneRun(i, baseConfig, mcConfig);
      allRuns.push(run); // Add to accumulator

      // Notify the UI of progress (updates the progress bar)
      onProgress(i + 1, mcConfig.numberOfRuns);
    }

    if (cancelled) return; // Final check: don't compute results if cancelled

    // All runs complete — compute statistics and envelope, then notify the UI
    const results = computeMonteCarloResults(allRuns);
    onComplete(results); // Triggers the UI to show the MonteCarloPanel
  })();

  return { cancel }; // Return cancel handle so caller can abort if needed
}
