/**
 * ROCKET SIMULATOR - STRUCTURAL LIMITS SYSTEM
 * ============================================
 * Tracks how much aerodynamic and inertial stress the rocket's structure is under.
 * When stress limits are exceeded for too long, structural integrity degrades and
 * eventually the rocket breaks apart.
 *
 * WHAT CAUSES STRUCTURAL FAILURE IN REAL ROCKETS?
 *
 *   1. MAX-Q OVERPRESSURE — Dynamic pressure Q = 0.5×ρ×v²
 *      The kinetic pressure of the airstream loads the rocket skin and inter-stage
 *      connections. Space Shuttle's Max-Q was ~34 kPa at 11.3 km altitude.
 *      Exceeding the structure's design limit by a significant margin causes
 *      panels to buckle, interstage rings to fail, or the nose cone to separate.
 *
 *   2. HIGH G-FORCES — Acceleration measured in multiples of Earth gravity
 *      The rocket's own thrust accelerates it; the airframe must survive this
 *      force. Cargo rockets: up to 6–8 G. Crewed: typically < 4 G.
 *      Extreme G-forces crush propellant feed lines and crack engine mounts.
 *
 *   3. ANGLE OF ATTACK AT SUPERSONIC SPEED
 *      "Angle of attack" (AoA) = the angle between the rocket's nose and its
 *      flight direction (velocity vector). At supersonic speeds, even a few
 *      degrees of AoA generates enormous aerodynamic side loads.
 *      This is why rockets must fly "prograde" — nose pointing into the airstream.
 *      The Challenger disaster involved aerodynamic loads after an SRB O-ring failure
 *      caused an off-axis thrust vector, leading to structural breakup at Max-Q.
 *
 * TYPICAL ROCKET LIMITS:
 *   Max Q limit: 33,000–40,000 Pa (Falcon 9: ~33 kPa, Saturn V: ~35 kPa)
 *   Max G limit: 6–8 G for cargo, 3–4 G for crewed flights
 *   Max AoA:     < 5° in practice, 15°+ at supersonic causes rapid degradation
 */

import { getDynamicPressure } from "./AtmosphereModel"; // Q = 0.5 × ρ × v²

// ─── STRUCTURAL DESIGN LIMITS ─────────────────────────────────────────────────

/**
 * Maximum dynamic pressure the rocket structure can sustain before degrading.
 * Real Falcon 9: Max-Q is ~33 kPa; the structural limit is slightly higher.
 * We set the failure threshold at 33 kPa so a rocket that doesn't throttle back
 * at Max-Q will eventually experience structural degradation.
 */
export const MAX_DYNAMIC_PRESSURE_LIMIT = 33000; // Pa (33 kPa) — structural pressure limit

/**
 * Maximum G-force the rocket structure can sustain.
 * 7.0 G is typical for an uncrewed cargo rocket.
 * At 7 G, a 100 kg structural component effectively weighs 700 kg — stress concentrates
 * at welds, bolts, and interstage connections.
 */
export const MAX_ACCELERATION_G = 7.0; // G — maximum sustained G-force before damage

/**
 * Grace period before pressure damage begins.
 * Real rockets can briefly exceed Max-Q during staging or gust encounters
 * without immediate failure. After 2 continuous seconds above limit, damage starts.
 */
const PRESSURE_DAMAGE_GRACE_SECONDS = 2.0; // s — grace period before integrity loss

/**
 * Rate of structural integrity loss when dynamic pressure exceeds the limit.
 * 10% per second means the rocket breaks apart in ~10 seconds of continuous overload.
 * This gives the player time to react (throttle down, adjust trajectory).
 */
const PRESSURE_DAMAGE_RATE = 10.0; // % per second — integrity loss when Q exceeds limit

/**
 * Rate of structural integrity loss when G-force exceeds the limit.
 * Slower than pressure damage because high-G is slightly more survivable.
 */
const G_DAMAGE_RATE = 5.0; // % per second — integrity loss when G exceeds limit

/**
 * Rate of structural integrity loss due to angle-of-attack stress at supersonic speeds.
 * Higher Mach = worse: multiplied by (Mach/2) so the damage accelerates supersonically.
 * At Mach 2 with AoA > 15°: 15 × (2/2) = 15% per second — very dangerous.
 * At Mach 4 with AoA > 15°: 15 × (4/2) = 30% per second — nearly instant failure.
 */
const AOA_DAMAGE_RATE = 15.0; // % per second base rate — scaled by Mach/2

/**
 * Minimum angle (degrees from vertical) that counts as a dangerous angle of attack
 * when flying supersonically. Above this threshold, the rocket's side panels
 * experience unacceptable aerodynamic loads.
 */
const AOA_SUPERSONIC_THRESHOLD_DEG = 15.0; // degrees — AoA above this causes damage at M>1

// ─── STATE TYPE ───────────────────────────────────────────────────────────────

/**
 * Complete structural health state for the rocket.
 * Updated every physics frame. Carries both current readings and history.
 */
export interface StructuralState {
  /** Structural integrity percentage (0–100%). Starts at 100%. Degrades under stress.
   *  When this reaches 0%, the rocket breaks apart (simulation ends). */
  structuralIntegrity: number; // %

  /** Current dynamic pressure Q = 0.5 × ρ × v² in Pascals.
   *  Updated every frame. Used for telemetry display and limit checking. */
  currentDynamicPressure: number; // Pa

  /** Highest dynamic pressure reached so far in this flight (Max-Q value).
   *  Recorded for telemetry and flight summary. Typical: 20–40 kPa. */
  maxDynamicPressure: number; // Pa

  /** Altitude where Max-Q occurred (meters). Shown in the Max-Q callout. */
  maxQAltitude: number; // m

  /** Flight time when Max-Q occurred (seconds). */
  maxQTime: number; // s

  /** Current G-force: total acceleration / 9.81. Shown in telemetry. */
  currentAccelerationG: number; // G

  /** True when current Q > MAX_DYNAMIC_PRESSURE_LIMIT. Triggers red HUD highlight. */
  isExceedingPressureLimit: boolean;

  /** True when current Gs > MAX_ACCELERATION_G. Triggers red HUD highlight. */
  isExceedingGLimit: boolean;

  /** Accumulated seconds spent above the pressure limit this flight.
   *  Damage only starts after PRESSURE_DAMAGE_GRACE_SECONDS seconds over limit. */
  timeExceedingPressure: number; // s

  /** True once structural integrity reaches 0% — the rocket has broken apart.
   *  This is a terminal state: the simulation should end when this is set. */
  didBreakApart: boolean;
}

// ─── FACTORY ──────────────────────────────────────────────────────────────────

/**
 * Create a fresh StructuralState for a new flight.
 * Starts with 100% structural integrity and all readings at zero.
 *
 * @returns  Initialized StructuralState with full integrity.
 */
export function createStructuralState(): StructuralState {
  return {
    structuralIntegrity: 100, // % — full integrity at launch
    currentDynamicPressure: 0, // Pa — no Q on the pad
    maxDynamicPressure: 0, // Pa — no Max-Q yet
    maxQAltitude: 0, // m — not reached yet
    maxQTime: 0, // s — not reached yet
    currentAccelerationG: 0, // G — at rest
    isExceedingPressureLimit: false, // Not over the limit yet
    isExceedingGLimit: false, // Not over the G limit yet
    timeExceedingPressure: 0, // s — no accumulated overload time
    didBreakApart: false, // Rocket is intact
  };
}

// ─── UPDATE FUNCTION ──────────────────────────────────────────────────────────

/**
 * Update structural state based on current flight conditions.
 * Called every physics sub-step to accumulate stress and check failure.
 *
 * STRESS SOURCES CHECKED THIS FRAME:
 *   1. Dynamic pressure Q vs MAX_DYNAMIC_PRESSURE_LIMIT
 *   2. G-force vs MAX_ACCELERATION_G
 *   3. Angle of attack (rocket tilt angle) at supersonic speeds
 *
 * @param structuralState       Current structural state — MUTATED in place.
 * @param velocityMagnitude     Total speed in m/s (√(vx²+vy²)).
 * @param altitude              Current altitude in meters.
 * @param accelerationMagnitude Total acceleration magnitude in m/s² (√(ax²+ay²)).
 * @param angle                 Current tilt angle in radians (0 = vertical).
 * @param mach                  Current Mach number.
 * @param timeElapsed           Total flight time in seconds.
 * @param deltaTime             Physics time step in seconds.
 * @returns                     True if the rocket just broke apart this frame.
 */
export function updateStructuralLimits(
  structuralState: StructuralState,
  velocityMagnitude: number,
  altitude: number,
  accelerationMagnitude: number,
  angle: number,
  mach: number,
  timeElapsed: number,
  deltaTime: number
): boolean {
  // If the rocket already broke apart, no further updates needed.
  if (structuralState.didBreakApart) {
    return false; // Not a new breakup event — it already happened
  }

  // ── DYNAMIC PRESSURE ──────────────────────────────────────────────────────
  // Compute Q = 0.5 × ρ × v² for this altitude and speed.
  // This is the primary aerodynamic load on the structure.
  const Q = getDynamicPressure(velocityMagnitude, altitude); // Pa
  structuralState.currentDynamicPressure = Q; // Store current Q for telemetry display

  // Track peak Q (Max-Q event) — record when a new maximum is reached.
  if (Q > structuralState.maxDynamicPressure) {
    structuralState.maxDynamicPressure = Q; // New Max-Q record in Pa
    structuralState.maxQAltitude = altitude; // Altitude at this peak
    structuralState.maxQTime = timeElapsed; // Time at this peak
  }

  // ── G-FORCE ───────────────────────────────────────────────────────────────
  // G-force = total acceleration / standard gravity.
  // 1 G = standing still on Earth. 3 G = sitting in a fighter jet turn.
  // Rockets typically pull 1.2 G at launch rising to 3–5 G at staging.
  const G = accelerationMagnitude / 9.81; // G — dimensionless
  structuralState.currentAccelerationG = G; // Store for telemetry

  // ── LIMIT CHECKS ──────────────────────────────────────────────────────────
  // Set boolean flags used for red HUD highlighting when limits are exceeded.
  structuralState.isExceedingPressureLimit = Q > MAX_DYNAMIC_PRESSURE_LIMIT; // Over 33 kPa?
  structuralState.isExceedingGLimit = G > MAX_ACCELERATION_G; // Over 7 G?

  // ── STRUCTURAL DAMAGE FROM PRESSURE ───────────────────────────────────────
  if (structuralState.isExceedingPressureLimit) {
    // Accumulate time spent above the pressure limit.
    // Real rockets can handle brief transient overloads (gusts, stage sep pulses).
    structuralState.timeExceedingPressure += deltaTime; // Accumulate overload seconds

    if (structuralState.timeExceedingPressure > PRESSURE_DAMAGE_GRACE_SECONDS) {
      // Grace period expired — sustained overload is now causing structural damage.
      // Damage rate: 10% per second of sustained overload.
      // At Q = 2× limit: still 10%/s (limit exceeded for 2+ seconds).
      structuralState.structuralIntegrity -= PRESSURE_DAMAGE_RATE * deltaTime; // %
    }
  } else {
    // Below the limit — slowly recover the accumulated overload timer.
    // Recovery rate equals damage rate: symmetrical accumulation/recovery.
    structuralState.timeExceedingPressure = Math.max(
      0, // Never go negative
      structuralState.timeExceedingPressure - deltaTime // Reduce over time
    );
  }

  // ── STRUCTURAL DAMAGE FROM HIGH G-FORCE ───────────────────────────────────
  if (structuralState.isExceedingGLimit) {
    // High G-force continuously stresses airframe joints and propellant feed lines.
    // Damage is immediate (no grace period) but slower than pressure damage.
    structuralState.structuralIntegrity -= G_DAMAGE_RATE * deltaTime; // 5%/s
  }

  // ── STRUCTURAL DAMAGE FROM ANGLE OF ATTACK AT SUPERSONIC SPEED ────────────
  // Convert tilt angle (radians) to angle of attack in degrees.
  // Angle = 0 means rocket nose is pointing straight up (prograde).
  // Any tilt while moving creates an angle of attack (AoA).
  // At supersonic speeds, even small AoA creates massive aerodynamic side loads.
  const aoaDegrees = Math.abs(angle) * (180 / Math.PI); // Convert rad → degrees

  if (aoaDegrees > AOA_SUPERSONIC_THRESHOLD_DEG && mach > 1.0) {
    // Supersonic flight with significant angle of attack.
    // Damage rate scales with Mach number: faster = more aerodynamic side load.
    // At Mach 2: rate = 15 × (2/2) = 15% per second
    // At Mach 4: rate = 15 × (4/2) = 30% per second
    const machFactor = mach / 2.0; // Scale damage by how supersonic we are
    structuralState.structuralIntegrity -= AOA_DAMAGE_RATE * machFactor * deltaTime; // %
  }

  // ── CLAMP INTEGRITY ───────────────────────────────────────────────────────
  // Structural integrity cannot exceed 100% (no spontaneous self-repair).
  // Minimum of 0% (already broken apart).
  structuralState.structuralIntegrity = Math.max(
    0, // Floor at 0%
    Math.min(100, structuralState.structuralIntegrity) // Cap at 100%
  );

  // ── CATASTROPHIC FAILURE CHECK ────────────────────────────────────────────
  // When structural integrity hits 0%, the rocket cannot hold together any longer.
  if (structuralState.structuralIntegrity <= 0) {
    structuralState.didBreakApart = true; // Mark as catastrophically failed
    return true; // Signal this frame: the rocket just broke apart
  }

  return false; // No catastrophic failure this frame
}
