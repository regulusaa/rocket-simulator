/**
 * ROCKET SIMULATOR - PHYSICS ENGINE (MULTI-STAGE + ROTATION VERSION)
 * ===================================================================
 * Core physics simulation: forces, kinematics, staging, and angular motion.
 *
 * NEW IN THIS VERSION:
 *   - angle / angularVelocity fields on MultiStageRocketState
 *   - Thrust is applied in the direction the rocket is POINTING (not always up)
 *   - Angular damping keeps the rocket from spinning forever
 *   - Restoring force returns the rocket toward vertical when not steered
 *   - applyControls() now accepts tiltLeft/tiltRight and deltaTime for steering
 *
 * PHYSICS OVERVIEW (every frame):
 *   1. Check automatic staging (empty fuel tank → separate stage → ignite next)
 *   2. Sum forces: gravity (always down) + thrust (along rocket angle) + drag
 *   3. Integrate: acceleration → velocity → position  (Euler method, Δt per frame)
 *   4. Consume fuel from active stages
 *   5. Update angle via angular velocity + damping
 *   6. Clamp angle, detect ground collision, track metrics
 */

import type { Vector2D, SimulationConfig } from "./types";
// Vector2D: {x, y} for positions/velocities/forces.
// SimulationConfig: gravity, wind, drag, rocketRadius, timeStep.

// Import atmospheric functions for physically-accurate drag calculation.
// Physical drag replaces the old linear approximation (dragForce = Cd × v).
// Real drag: F_drag = 0.5 × ρ(altitude) × v² × Cd(Mach) × A
// where ρ is air density from the ISA model, Cd varies with Mach number,
// and A is the rocket's cross-sectional area (π × radius²).
import { getAirDensity, getMachNumber, getDragCoefficient } from "./AtmosphereModel";

import type { MultiStageRocketConfig } from "./MultiStageSystem";
// The full rocket definition: all stages with their mass/thrust/fuel specs.

import {
  calculateTotalMass,
  calculateTotalThrust,
  applyMultiStageThrottle,
  checkAndPerformStaging,
  consumeFuel,
  resetAllStages,
} from "./MultiStageSystem";
// Import all multi-stage helper functions so this file only handles high-level physics.

import {
  ANGULAR_THRUST_RATE,
  ANGULAR_DAMPING,
  MAX_TILT_ANGLE,
  ANGULAR_RESTORE_RATE,
} from "../utils/constants";
// Angular control constants extracted to constants.ts for easy tuning.

// ─── STATE TYPE ───────────────────────────────────────────────────────────────

/**
 * Complete flight state for a multi-stage rocket at a single instant in time.
 *
 * COORDINATE SYSTEM:
 *   position.x — meters east of launch pad (positive = right)
 *   position.y — meters altitude above ground (positive = up)
 *   velocity / acceleration follow the same axes
 *
 * ANGLE SYSTEM:
 *   angle = 0             → rocket is perfectly vertical (straight up)
 *   angle = +π/6 (30°)   → rocket tilted 30° to the right (nose upper-right)
 *   angle = -π/6 (−30°)  → rocket tilted 30° to the left (nose upper-left)
 *   Maximum tilt is clamped to ±MAX_TILT_ANGLE (60°) from vertical.
 *
 * THRUST VECTOR:
 *   thrustX = sin(angle) * totalThrust   — horizontal component (0 when vertical)
 *   thrustY = cos(angle) * totalThrust   — vertical component  (max when vertical)
 */
export interface MultiStageRocketState {
  // ── POSITION & MOTION ──
  position: Vector2D;     // Where the rocket is (meters: x=horizontal, y=altitude)
  velocity: Vector2D;     // How fast it's moving (m/s: vx=sideways, vy=up/down)
  acceleration: Vector2D; // Current net acceleration (m/s²) — updated each frame

  // ── ROTATION ──
  /**
   * Current tilt angle in radians measured from vertical.
   *   0   = straight up
   *   +   = tilted right (D key / right arrow)
   *   -   = tilted left  (A key / left arrow)
   * Clamped to [-MAX_TILT_ANGLE, +MAX_TILT_ANGLE].
   */
  angle: number;

  /**
   * Current angular velocity in radians per second.
   * Positive = rotating clockwise (tilting right).
   * Negative = rotating counter-clockwise (tilting left).
   * Subject to ANGULAR_DAMPING each frame so it doesn't spin forever.
   */
  angularVelocity: number;

  // ── FLIGHT STATUS ──
  isFlying: boolean;      // True once rocket rises above MIN_FLYING_ALTITUDE
  hasLanded: boolean;     // True once rocket returns to ground after flying
  landingVelocity: number;// Vertical speed at ground impact (m/s, negative = downward)

  // ── METRICS ──
  maxAltitudeReached: number;    // Peak altitude recorded (meters)
  timeElapsed: number;           // Total simulation time since launch (seconds)
  activeStageNumber: number;     // Index (0-based) of the currently burning stage
  stageSeparationCount: number;  // Total number of stage separations performed
  didStageSeperateThisFrame: boolean; // True only during the frame a separation occurs
}

// ─── FRAME RESULT ─────────────────────────────────────────────────────────────

/**
 * What the physics engine returns after processing one time step.
 * The caller uses groundImpact to trigger landing effects/sounds.
 */
export interface MultiStagePhysicsFrame {
  state: MultiStageRocketState; // Updated flight state after this time step
  deltaTime: number;            // The Δt that was used for this integration step (seconds)
  groundImpact: boolean;        // True if the rocket hit the ground THIS frame (edge-trigger)
}

// ─── FACTORY ──────────────────────────────────────────────────────────────────

/**
 * Build the initial flight state for a brand-new launch.
 * Everything starts at rest on the ground (position y=0, velocity=0, no rotation).
 *
 * @param _config — The rocket config (not used yet but kept for future per-rocket state init).
 * @returns        Fresh MultiStageRocketState ready for the first physics frame.
 */
export function createMultiStageRocket(
  _config: MultiStageRocketConfig
): MultiStageRocketState {
  return {
    // ── POSITION & MOTION — all zero: rocket sits still on the pad ──
    position: { x: 0, y: 0 },      // Ground level, centered horizontally
    velocity: { x: 0, y: 0 },      // Stationary
    acceleration: { x: 0, y: 0 },  // No forces until engine fires

    // ── ROTATION — starts perfectly vertical ──
    angle: 0,           // 0 radians = straight up
    angularVelocity: 0, // Not rotating

    // ── FLIGHT STATUS ──
    isFlying: false,       // Hasn't launched yet
    hasLanded: false,      // Has not landed (hasn't even launched)
    landingVelocity: 0,    // No landing velocity yet

    // ── METRICS ──
    maxAltitudeReached: 0,         // Ground is zero
    timeElapsed: 0,                // Clock starts at zero
    activeStageNumber: 0,          // First stage (bottom) is active at launch
    stageSeparationCount: 0,       // No separations yet
    didStageSeperateThisFrame: false, // No separation on first frame
  };
}

// ─── CONTROLS ─────────────────────────────────────────────────────────────────

/**
 * Apply player input to the rocket for this frame.
 * Handles both throttle changes (thrust) and angular steering (tilt).
 *
 * Called ONCE per physics sub-step, before updatePhysics().
 *
 * @param config          Rocket configuration (stages with throttle state).
 * @param state           Current flight state (we modify angularVelocity directly).
 * @param holdingThrottle True while SPACEBAR is held — ramps throttle up.
 * @param clickThrottle   True for ONE frame when player clicked — pulse burst.
 * @param tiltLeft        True while A / ArrowLeft is held — rotates rocket left.
 * @param tiltRight       True while D / ArrowRight is held — rotates rocket right.
 * @param deltaTime       Seconds since last physics tick — for frame-rate independence.
 */
export function applyControls(
  config: MultiStageRocketConfig,
  state: MultiStageRocketState,
  holdingThrottle: boolean,
  clickThrottle: boolean,
  tiltLeft: boolean,
  tiltRight: boolean,
  deltaTime: number
): void {
  // ── THROTTLE ──
  // Delegate to the multi-stage throttle function which ramps up/down over time.
  // This is the key fix for "thrust too sensitive": throttle now takes 2s to reach 100%.
  applyMultiStageThrottle(config, holdingThrottle, clickThrottle, deltaTime);

  // ── STEERING — only allow steering while the rocket is in flight ──
  // Steering on the ground would just spin the rocket on its launchpad, which looks odd.
  if (!state.isFlying) return; // Skip angular controls before liftoff

  if (tiltLeft) {
    // Pressing A / Left Arrow: reduce angular velocity (rotate counter-clockwise = tilt left).
    // ANGULAR_THRUST_RATE is in rad/s², multiplied by deltaTime gives rad/s change.
    state.angularVelocity -= ANGULAR_THRUST_RATE * deltaTime;
  }

  if (tiltRight) {
    // Pressing D / Right Arrow: increase angular velocity (rotate clockwise = tilt right).
    state.angularVelocity += ANGULAR_THRUST_RATE * deltaTime;
  }
}

// ─── PHYSICS UPDATE ───────────────────────────────────────────────────────────

/**
 * Advance the rocket simulation by one time step (Δt = deltaTime seconds).
 *
 * INTEGRATION METHOD: Explicit Euler (simple, good enough at small Δt)
 *   v_new = v_old + a * Δt
 *   x_new = x_old + v_new * Δt
 *
 * FORCE BUDGET (what accelerates the rocket):
 *   1. Gravity        — constant −9.81 m/s² downward (always present)
 *   2. Thrust         — along rocket's angle (sin/cos decomposition)
 *   3. Aerodynamic drag — opposes velocity direction, proportional to speed
 *   4. Wind           — constant lateral push from world config
 *
 * ANGULAR BUDGET:
 *   1. Player input   — handled in applyControls() before this function
 *   2. Damping        — reduces angularVelocity each frame
 *   3. Restoring force— gentle spring back to vertical when no input
 *
 * @param state       Current flight state (MUTATED in place).
 * @param config      Rocket configuration (stages, fuel, thrust).
 * @param simConfig   World settings (gravity, wind, drag).
 * @param deltaTime   Time step in seconds for this integration tick.
 * @returns           PhysicsFrame: updated state + event flags.
 */
export function updatePhysics(
  state: MultiStageRocketState,
  config: MultiStageRocketConfig,
  simConfig: SimulationConfig,
  deltaTime: number
): MultiStagePhysicsFrame {
  // Track whether ground contact occurred this frame (one-shot event trigger).
  let groundImpact = false;

  // ── STAGING CHECK ──
  // Automatic staging: when a stage empties its fuel tank, it separates and the
  // next stage ignites at full throttle. Real rockets stage in milliseconds.
  const stagingSeparated = checkAndPerformStaging(config);
  // Record whether a stage separated THIS frame — used for visual burst effect.
  state.didStageSeperateThisFrame = stagingSeparated;

  if (stagingSeparated) {
    // Increment the separation counter (displayed in telemetry).
    state.stageSeparationCount++;
    // Find which stage is now active and update the active stage index.
    for (let i = 0; i < config.stages.length; i++) {
      if (config.stages[i].isActive) {
        // The first active (non-separated) stage is the one now in control.
        state.activeStageNumber = i;
        break; // Only one stage is active at a time — stop searching after finding it.
      }
    }
  }

  // ── INITIALIZE ACCELERATION ──
  // Start with zero acceleration; forces are added below.
  let accelerationX = 0;
  let accelerationY = 0;

  // ── TOTAL MASS ──
  // Sum of all non-separated stage masses (dry + fuel) plus payload.
  // Mass decreases as fuel burns and stages separate.
  // This is critical: lighter rocket → same thrust → higher acceleration (a = F/m).
  const totalMass = calculateTotalMass(config);

  // ── TOTAL THRUST ──
  // Sum of thrust (N) from all stages currently firing (active, not separated, has fuel, throttle > 0).
  const totalThrust = calculateTotalThrust(config);

  // ── GRAVITY ──
  // Always acts downward: −g in the Y direction.
  // Negative because our Y axis is positive-up and gravity pulls down.
  accelerationY -= simConfig.gravity;

  // ── THRUST ──
  // Thrust acts along the rocket's pointing direction, decomposed into X and Y components.
  //   thrustX = sin(angle) * totalThrust / totalMass
  //     — At angle=0 (vertical): sin(0)=0, so no horizontal thrust component.
  //     — At angle=+π/6 (30° right): sin(π/6)=0.5, so 50% of thrust pushes right.
  //   thrustY = cos(angle) * totalThrust / totalMass
  //     — At angle=0: cos(0)=1, so 100% of thrust pushes up.
  //     — At angle=+π/6: cos(π/6)≈0.866, so 86.6% of thrust still pushes up.
  // This is the rocket steering mechanic: tilting sacrifices some vertical thrust
  // for horizontal velocity, which is exactly how real gravity-turn launches work.
  if (totalThrust > 0) {
    // Horizontal acceleration from thrust (positive angle = thrust pushes right).
    accelerationX += Math.sin(state.angle) * totalThrust / totalMass;
    // Vertical acceleration from thrust (always positive at angle < 90°).
    accelerationY += Math.cos(state.angle) * totalThrust / totalMass;
  }

  // ── AERODYNAMIC DRAG (physically accurate) ───────────────────────────────
  // Real aerodynamic drag formula: F_drag = 0.5 × ρ × v² × Cd × A
  //
  //   ρ   = air density at current altitude (kg/m³) — from ISA atmosphere model.
  //         Decreases exponentially with altitude: ρ ≈ 1.225 × e^(-h/8500).
  //         At sea level: 1.225 kg/m³. At 10 km: ~0.414. Above 100 km: ~0.
  //
  //   v²  = square of the TOTAL speed (not per axis), because drag depends on
  //         the magnitude of the velocity vector hitting the nose cone.
  //
  //   Cd  = drag coefficient — varies with Mach number (NOT constant!).
  //         Subsonic (M < 0.8):    Cd = 0.3 (clean attached flow)
  //         Transonic (M 0.8–1.2): Cd up to 0.6 (shock waves form — "sound barrier")
  //         Supersonic (M > 1.2):  Cd = 0.2 (stable oblique shock)
  //         Hypersonic (M > 5):    Cd = 0.15 (thin shock layer)
  //
  //   A   = cross-sectional area of the rocket (m²) = π × radius²
  //         Uses simConfig.rocketRadius — the radius of the rocket body.
  //         A = π × (0.5 m)² ≈ 0.785 m² for a 1-meter-diameter vehicle.
  //
  // This model correctly captures:
  //   • Max-Q around 11–14 km (where ρ is still high and v is large)
  //   • Transonic drag rise near Mach 1 (highest structural loading)
  //   • Falling drag at high altitude (thin air, even at hypersonic speed)

  // Compute total velocity magnitude (speed) in m/s.
  // Speed = √(vx² + vy²) — the actual length of the velocity vector.
  const velocityMagnitude = Math.sqrt(
    state.velocity.x * state.velocity.x + // Horizontal component squared
    state.velocity.y * state.velocity.y   // Vertical component squared
  ); // m/s — total speed

  if (velocityMagnitude > 0) {
    // Compute atmospheric air density at the rocket's current altitude.
    // Density decreases with altitude so drag is much higher at low altitude.
    const airDensity = getAirDensity(state.position.y); // kg/m³

    // Compute Mach number to look up the correct drag coefficient.
    // Mach = speed / local_speed_of_sound — the speed of sound decreases with temperature.
    const mach = getMachNumber(velocityMagnitude, state.position.y); // dimensionless

    // Mach-dependent drag coefficient — peaks at transonic, lower supersonic/hypersonic.
    const cd = getDragCoefficient(mach); // dimensionless Cd

    // Cross-sectional area of the rocket nose cone facing the airstream.
    // A = π × r² where r = simConfig.rocketRadius (meters).
    const crossSectionArea = Math.PI * simConfig.rocketRadius * simConfig.rocketRadius; // m²

    // Total drag force magnitude: F_drag = 0.5 × ρ × v² × Cd × A (Newton)
    // This is the force the airstream exerts on the rocket opposing its motion.
    const dragForceMagnitude =
      0.5 * airDensity * velocityMagnitude * velocityMagnitude * cd * crossSectionArea; // N

    // Convert force to acceleration: a = F/m (Newton's 2nd law).
    const dragAccelMagnitude = dragForceMagnitude / totalMass; // m/s²

    // Decompose drag acceleration into X and Y components along the velocity direction.
    // Drag always opposes the velocity vector: direction = -(velocity / speed).
    // vx/speed = unit vector component in X, so drag_x = −(drag_accel × vx/speed).
    accelerationX -= dragAccelMagnitude * (state.velocity.x / velocityMagnitude); // m/s²
    accelerationY -= dragAccelMagnitude * (state.velocity.y / velocityMagnitude); // m/s²
  }

  // ── WIND ──
  // Lateral wind push. Treated as a constant horizontal force (not velocity-dependent).
  // The wind force is scaled so larger rockets are pushed less (because F/m is smaller).
  if (simConfig.windSpeed.x !== 0) {
    // Wind "force" = windSpeed * 1000 N — a 3 m/s breeze applies 3000 N of force.
    // Dividing by totalMass converts force to acceleration (a = F/m).
    const windForce = simConfig.windSpeed.x * 1000;
    accelerationX += windForce / totalMass;
  }

  // Store the net acceleration in state for UI display in the telemetry panel.
  state.acceleration.x = accelerationX;
  state.acceleration.y = accelerationY;

  // ── VELOCITY INTEGRATION ──
  // Euler integration: v_new = v_old + a * Δt
  // This is an approximation but accurate enough at small Δt (≤ 0.016s at 60fps).
  state.velocity.x += accelerationX * deltaTime;
  state.velocity.y += accelerationY * deltaTime;

  // ── POSITION INTEGRATION ──
  // x_new = x_old + v_new * Δt
  // Using v_new (semi-implicit Euler) is slightly more stable than using v_old.
  state.position.x += state.velocity.x * deltaTime;
  state.position.y += state.velocity.y * deltaTime;

  // ── FUEL CONSUMPTION ──
  // Burn fuel from all active stages proportional to throttle% and burn rate (kg/s).
  consumeFuel(config, deltaTime);

  // ── FLIGHT STATUS ──
  // Mark as flying once the rocket clears ground level (>1 m).
  if (state.position.y > 1 && !state.isFlying) {
    state.isFlying = true;
  }

  // ── ANGULAR PHYSICS ──
  // Update rotation from angular velocity, apply damping, and restore toward vertical.

  // Angular damping: multiply angularVelocity by a decay factor each frame.
  // The factor is (1 - ANGULAR_DAMPING * Δt), approaching zero exponentially.
  // This simulates aerodynamic fins and atmospheric drag slowing the spin.
  state.angularVelocity *= Math.max(0, 1 - ANGULAR_DAMPING * deltaTime);

  // Restoring force: a gentle spring pulling the rocket back toward angle=0 (vertical).
  // When no steering input and the rocket is flying, this gradually straightens the rocket.
  // Force is proportional to how far off-vertical it is: further tilted = stronger pull.
  // Only applied when not on the ground (we don't wobble on the launchpad).
  if (state.isFlying) {
    // -state.angle * rate: if tilted right (+angle), force is negative (pulls left).
    // Multiplied by deltaTime so it's frame-rate independent (rad/s per radian of tilt).
    state.angularVelocity -= state.angle * ANGULAR_RESTORE_RATE * deltaTime;
  }

  // Integrate angle from angular velocity (angle_new = angle_old + ω * Δt).
  state.angle += state.angularVelocity * deltaTime;

  // Clamp angle to the maximum tilt limit to keep the rocket somewhat vertical.
  // Beyond 60° the physics becomes unrealistic (nearly horizontal rocket).
  state.angle = Math.max(-MAX_TILT_ANGLE, Math.min(MAX_TILT_ANGLE, state.angle));

  // Force the rocket to stand upright when on the ground (before and after flight).
  if (!state.isFlying) {
    state.angle = 0;           // Always vertical on the launchpad
    state.angularVelocity = 0; // No spin when on the ground
  }

  // ── MAX ALTITUDE TRACKING ──
  if (state.position.y > state.maxAltitudeReached) {
    // New peak altitude — update the record.
    state.maxAltitudeReached = state.position.y;
  }

  // ── GROUND COLLISION ──
  // Detect when the rocket falls back to y ≤ 0 (ground level).
  if (state.position.y <= 0 && state.isFlying) {
    // Snap exactly to ground to prevent the rocket from going underground.
    state.position.y = 0;

    // Record the velocity at impact (negative = coming down, as expected).
    state.landingVelocity = state.velocity.y;

    // Stop all motion — the rocket has landed/crashed.
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.angularVelocity = 0; // Also stop spinning on impact

    // Clear flight flags.
    state.isFlying = false;
    state.hasLanded = true;

    // Signal that ground impact happened this frame.
    groundImpact = true;
  }

  // Also clamp if below ground when NOT flying (e.g., on initial placement).
  if (state.position.y < 0 && !state.isFlying) {
    state.position.y = 0;
  }

  // ── TIME TRACKING ──
  // Accumulate elapsed simulation time (seconds).
  state.timeElapsed += deltaTime;

  // Return the updated state and event flags.
  return {
    state,
    deltaTime,
    groundImpact,
  };
}

// ─── RESET ────────────────────────────────────────────────────────────────────

/**
 * Reset the rocket to launch-ready state.
 * Refills all fuel tanks, zeros position/velocity/rotation, resets all metrics.
 *
 * @param state  The flight state object to reset (mutated in place).
 * @param config The rocket configuration to reset (stages refilled via resetAllStages).
 */
export function resetRocket(
  state: MultiStageRocketState,
  config: MultiStageRocketConfig
): void {
  // ── RESET POSITION — back on the pad at origin ──
  state.position.x = 0;
  state.position.y = 0;

  // ── RESET MOTION — stationary ──
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.acceleration.x = 0;
  state.acceleration.y = 0;

  // ── RESET ROTATION — perfectly vertical ──
  state.angle = 0;           // Back to straight-up orientation
  state.angularVelocity = 0; // No spin

  // ── RESET FLIGHT STATUS ──
  state.isFlying = false;
  state.hasLanded = false;
  state.landingVelocity = 0;

  // ── RESET METRICS ──
  state.maxAltitudeReached = 0;
  state.timeElapsed = 0;
  state.activeStageNumber = 0;      // First stage is active again
  state.stageSeparationCount = 0;   // No separations
  state.didStageSeperateThisFrame = false;

  // ── RESET STAGES — refill tanks, reattach stages, shut off engines ──
  resetAllStages(config);
}

// ─── LANDING SCORE ────────────────────────────────────────────────────────────

/**
 * Score the quality of a landing on a 0–100 scale.
 * Based purely on impact speed: slower = better.
 *
 * @param landingVelocity Speed at ground impact (m/s, sign doesn't matter).
 * @returns               Integer score 0 (crash) to 100 (perfect soft landing).
 */
export function calculateLandingScore(landingVelocity: number): number {
  // Use absolute speed — we don't care whether it was falling or somehow rising.
  const speed = Math.abs(landingVelocity);

  if (speed < 5)  return 100; // Near-perfect: < 5 m/s, like setting a glass down gently
  if (speed < 10) return 80;  // Very good: 5–10 m/s, light bounce
  if (speed < 20) return 60;  // Acceptable: 10–20 m/s, survivable impact
  if (speed < 40) return 30;  // Hard: 20–40 m/s, significant structural damage
  return 0;                    // Crash: > 40 m/s, total loss
}

// ─── FUEL STATUS QUERY ────────────────────────────────────────────────────────

/**
 * Return per-stage fuel status for display in the telemetry UI.
 *
 * @param config The rocket configuration.
 * @returns      Array with one entry per stage (fuel%, separated, active).
 */
export function getStageFuelStatus(config: MultiStageRocketConfig): Array<{
  stageNumber: number;
  name: string;
  fuelPercent: number;
  isSeparated: boolean;
  isActive: boolean;
}> {
  return config.stages.map((stage) => ({
    stageNumber: stage.stageNumber,
    name: stage.name,
    // Express fuel as a 0–100% fraction of initial capacity.
    fuelPercent: (stage.fuelMass / stage.fuelCapacity) * 100,
    isSeparated: stage.isSeparated,
    isActive: stage.isActive,
  }));
}
