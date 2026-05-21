/**
 * ROCKET SIMULATOR — LANDING MECHANICS
 * ======================================
 * Simulates the final phase of flight: deployment of drag devices, energy
 * absorption at touchdown, structural damage assessment, and landing quality scoring.
 *
 * WHY LANDING IS THE HARDEST PART OF ROCKETRY:
 *   The rocket has gathered enormous kinetic energy during powered ascent.
 *   Getting that energy back out safely — without destroying the vehicle —
 *   is an engineering challenge that stumped the industry for decades.
 *   SpaceX's first successful Falcon 9 propulsive landing (December 2015) was
 *   considered a watershed moment: prior to that, every orbital launch vehicle
 *   was single-use, abandoned in the ocean after each flight.
 *
 *   The physics are unforgiving: kinetic energy grows with the SQUARE of velocity.
 *   A rocket hitting the ground at 10 m/s has 4× less energy than at 20 m/s —
 *   the relationship is not linear, it's quadratic:
 *     KE = ½ × m × v²
 *   This means slowing from 30 m/s to 3 m/s (10× velocity reduction) reduces
 *   impact energy by 100× (10² = 100). Every m/s matters enormously.
 *
 * REAL-WORLD LANDING TECHNIQUES:
 *   1. PARACHUTES — SpaceX Dragon capsule, Soyuz, Apollo, and most capsules.
 *      Parachutes provide aerodynamic drag: force ∝ ½ρv²CdA.
 *      A 21-metre-wide parachute can slow 3,000 kg to safe landing speeds.
 *      Limitation: only works in atmosphere (useless on the Moon or Mars).
 *
 *   2. AIRBAGS — used by Mars Pathfinder and MER rovers.
 *      Inflate just before contact and allow bouncing. Very robust.
 *
 *   3. PROPULSIVE LANDING — SpaceX Falcon 9, Starship.
 *      Re-ignite the main engine at precisely the right altitude and throttle
 *      to null out velocity exactly at ground level. Requires remaining fuel.
 *      The "suicide burn" (Hoverslam) waits as long as possible before burning
 *      to maximise efficiency, then burns at 100% throttle to decelerate from
 *      ~200 m/s to 0 m/s over the last few hundred metres.
 *
 *   4. LANDING LEGS — absorb remaining impact energy after propulsive slow-down.
 *      Falcon 9 legs deploy in ~6 seconds and absorb ~20 kJ of residual energy.
 *      They're made of carbon fibre/aluminium honeycomb for lightweight strength.
 *
 * MODULE OVERVIEW:
 *   Parachute   — drag device state and inflation physics
 *   LandingGear — shock-absorbing legs state
 *   LandingState — touchdown record: velocity, damage, quality
 *
 *   createParachute()         — initialize a parachute system
 *   deployParachute()         — start the inflation sequence
 *   updateParachute()         — compute current drag force during inflation
 *   createLandingGear()       — initialize landing legs
 *   deployLandingGear()       — extend legs to absorb impact
 *   createLandingState()      — initialize per-flight landing tracking
 *   calculateLandingDamage()  — compute structural damage from impact energy
 *   getLandingQuality()       — categorise landing from "PERFECT" to "CRASH"
 *   processLanding()          — main entry point: update state on touchdown
 *   resetLanding()            — reset all landing state for a new flight
 *   getLandingQualityDescription() — human-readable landing result text
 */

// ─── PARACHUTE INTERFACE ─────────────────────────────────────────────────────

/**
 * Represents a single parachute system attached to a rocket stage.
 *
 * HOW A PARACHUTE WORKS (PHYSICS):
 *   A parachute increases the cross-sectional area A presented to the airstream.
 *   Aerodynamic drag force is:
 *     F_drag = ½ × ρ × v² × Cd × A
 *   where:
 *     ρ = air density (kg/m³) — halves roughly every 5.5 km altitude
 *     v = airspeed (m/s)
 *     Cd = drag coefficient (parachutes ≈ 1.75; blunt shapes ≈ 1.0)
 *     A = reference area (m²) — the parachute's canopy area
 *
 *   A 10-metre-diameter parachute has area π × 5² ≈ 78 m².
 *   At sea level (ρ = 1.225 kg/m³), falling at 10 m/s with Cd=1.75:
 *     F = ½ × 1.225 × 100 × 1.75 × 78 ≈ 8,347 N (about 850 kg-force).
 *   That's enough to decelerate a 3,000 kg capsule at ~2.8 m/s² — gentle enough.
 *
 * INFLATION SEQUENCE:
 *   Real parachutes don't snap open instantly. The sequence is:
 *   1. Pilot chute (small, spring-loaded) extracts the main canopy from its bag
 *   2. Risers (suspension lines) extend — up to 20 metres for large chutes
 *   3. Main canopy inflates against airflow — takes 0.5-3 seconds depending on altitude
 *   4. At full inflation, drag reaches designed maximum
 *
 *   This module simulates the inflation as a quadratic progression:
 *     currentDrag = maxDrag × progress²
 *   The squared curve means inflation starts slowly (stretching risers)
 *   then accelerates as the canopy catches more air.
 */
export interface Parachute {
  /**
   * Whether the deployment command has been issued.
   * true = deployment has started (or completed); false = packed, not yet deployed.
   * Once set to true by deployParachute(), it remains true — you can't "un-deploy".
   */
  isDeployed: boolean;

  /**
   * The maximum aerodynamic braking force this parachute can produce (Newtons).
   * Reached at deploymentProgress = 1.0 (fully inflated).
   *
   * REAL-WORLD REFERENCE:
   *   Apollo CM main parachutes: 3 × 25-metre chutes → ~300,000 N combined at 8 km/h
   *   SpaceX Dragon 2 main chutes: 4 × 116 m² chutes → ~450,000 N total
   *   Default 100,000 N here is roughly one Dragon-scale drogue chute.
   */
  dragForce: number;

  /**
   * Fractional inflation progress: 0.0 = just deployed (flat canvas), 1.0 = fully open.
   * Advances at a rate of deltaTime / deploymentTime per update() call.
   * We square this value to get the actual drag fraction (quadratic inflation curve).
   */
  deploymentProgress: number;

  /**
   * Time (in seconds) to go from 0% to 100% inflation.
   * Short deployment times (0.5s) model small drogue chutes or high dynamic pressure.
   * Longer times (2-3s) model large main canopies that must fight through dense air.
   */
  deploymentTime: number;

  /**
   * One-shot marker: set to true once the parachute reaches full inflation.
   * Prevents a parachute from being "re-deployed" after it's already been used
   * (real parachutes are single-use — you can't pack them back mid-flight).
   * Also used by the reset system to know which parachutes need replacing.
   */
  hasBeenUsed: boolean;

  /**
   * Minimum altitude at which this parachute can effectively operate (metres).
   * Below this altitude, air density is high enough for reasonable drag;
   * above it (e.g., at apogee in the upper stratosphere), deploying too early
   * wastes the parachute in thin air and costs delta-v unnecessarily.
   *
   * In reality this is more about WHEN to deploy than a hard minimum —
   * but as a simulation constraint, deploying in space (altitude > 100 km)
   * would produce zero drag, so we treat it as a deployment guard.
   *
   * Default: 1,000 m (1 km) — ensures we're in meaningful atmosphere.
   */
  minAltitudeForDeployment: number;
}

// ─── LANDING GEAR INTERFACE ───────────────────────────────────────────────────

/**
 * Represents the deployable leg assembly on the rocket's first stage.
 *
 * WHAT LANDING LEGS DO:
 *   Even after propulsive braking has slowed the rocket to ~2-5 m/s,
 *   the remaining kinetic energy must still be absorbed without transmitting
 *   destructive forces to the propellant tanks and engine bells above.
 *
 *   Falcon 9's landing legs work as follows:
 *   - 4 legs, each ~25 metres long when extended, made of carbon fibre
 *   - Each contains an aluminium honeycomb crush core that absorbs ~5 kJ per leg
 *   - Total absorption: 4 × 5 kJ = 20 kJ — enough for a 2 m/s residual velocity
 *     on a ~10,000 kg stage (KE = ½ × 10000 × 2² = 20,000 J = 20 kJ ✓)
 *   - Legs deploy 6 seconds before landing to minimise aerodynamic drag during descent
 *
 * SHOCK ABSORPTION PHYSICS:
 *   The leg structure deforms (elastically then plastically) to absorb kinetic energy.
 *   Absorbed energy = force × compression distance.
 *   A stiffer leg (less compression) transmits more force to the vehicle — painful for tanks.
 *   A softer leg (more compression) spreads the deceleration over more time — gentler.
 *   This is the same principle as crumple zones in cars, or bicycle helmets.
 */
export interface LandingGear {
  /**
   * Whether the legs are currently extended (deployed for landing).
   * Retracted during ascent to reduce drag; extended only for the final landing phase.
   * Starts as false (retracted); set to true by deployLandingGear().
   */
  isExtended: boolean;

  /**
   * Maximum kinetic energy this gear assembly can absorb without permanent damage (Joules).
   * Energy absorbed = force × leg compression distance.
   *
   * The landing gear absorbs energy equal to shockAbsorption from the impact energy.
   * Any remaining energy beyond this capacity transmits to the vehicle as structural damage.
   *
   * DEFAULT: 500,000 J = 500 kJ.
   * Reference: at 3 m/s with 50,000 kg vehicle: KE = ½ × 50000 × 9 = 225 kJ < 500 kJ → safe.
   * At 5 m/s: KE = ½ × 50000 × 25 = 625 kJ > 500 kJ → some damage.
   */
  shockAbsorption: number;

  /**
   * Normalised damage state of the gear (0.0 = pristine, 1.0 = completely destroyed).
   * Gear accumulates damage proportionally to how much excess energy was transmitted.
   * At damageState > 0.75, isBroken is set to true.
   * Broken gear provides zero shock absorption on subsequent landings.
   */
  damageState: number;

  /**
   * True when the gear has been damaged beyond operational limits.
   * A broken leg won't extend on the next launch — structural replacement needed.
   * Once broken, attempting to land again risks catastrophic collapse.
   */
  isBroken: boolean;
}

// ─── LANDING STATE INTERFACE ──────────────────────────────────────────────────

/**
 * Complete record of touchdown conditions and post-landing assessment.
 * Tracked from T=0 (launch) through landing; read by the UI to show the landing summary.
 *
 * REAL-WORLD ANALOGY:
 *   This is like the "flight data recorder" (black box) read-out for the landing event.
 *   Actual rockets record accelerometer data, engine chamber pressure, and leg force
 *   sensors to assess post-landing reusability. This interface captures the key metrics.
 */
export interface LandingState {
  /**
   * Whether the rocket has touched the ground this flight.
   * Set to true by processLanding() on the first ground contact event.
   * Remains true until resetLanding() is called for a new flight.
   */
  hasTouchedDown: boolean;

  /**
   * Velocity at the moment of first ground contact (m/s).
   * Negative = downward velocity (since our Y-axis is up).
   * This is the raw pre-impact speed — before gear or parachute effect are accounted for.
   *
   * REFERENCE VELOCITIES:
   *   Perfect: < 3 m/s  — softer than stepping off a kerb
   *   Good:    3-8 m/s  — comparable to a firm car bump
   *   Marginal: 8-20 m/s — like a hard car crash
   *   Hard:   20-50 m/s — survivable structure, badly damaged
   *   Crash:  > 50 m/s  — total loss; ~150 m/s ≈ terminal velocity for streamlined vehicle
   */
  landingVelocity: number;

  /**
   * Altitude at which landing state was recorded (metres).
   * Usually 0 (ground level) but could be non-zero if landing on an elevated surface.
   * Also used to determine whether parachutes were eligible for deployment
   * (parachutes only work above minAltitudeForDeployment).
   */
  landingAltitude: number;

  /**
   * Cumulative structural damage sustained during landing (0–100%).
   *   0% = pristine, flight-ready after standard inspection
   *   25% = minor damage, repairs needed before next flight
   *   50% = threshold for reusability (above this, vehicle is not worth repairing)
   *   75% = severe damage, partial breakup
   *   100% = total loss / destroyed
   *
   * Calculated from impact kinetic energy minus gear absorption capacity,
   * normalised against a "reference crash" at 150 m/s (total destruction velocity).
   */
  structuralDamage: number;

  /**
   * Whether this rocket is economically worth reflying after this landing.
   * True if structuralDamage < 50% (the marginal repair-vs-replace crossover).
   *
   * BUSINESS CONTEXT:
   *   SpaceX's reusability business case breaks even only if refurbishment costs
   *   are less than ~40% of a new vehicle cost. High landing damage means high
   *   refurbishment cost, negating the reuse advantage. A 100% reusable vehicle
   *   needs extremely gentle landings every time.
   */
  isReusable: boolean;

  /**
   * Categorical landing quality assessment.
   * Used to display feedback to the player and colour the landing summary.
   * Computed by getLandingQuality() from velocity and damage percentage.
   */
  landingQuality: "PERFECT" | "GOOD" | "ACCEPTABLE" | "HARD" | "CRASH";

  /**
   * How many parachutes were deployed during this descent.
   * Displayed in the landing summary; also influences the reusability assessment
   * (a parachute-assisted landing is gentler and more likely to be reusable).
   */
  parachutesDeployed: number;
}

// ─── FACTORY FUNCTIONS ────────────────────────────────────────────────────────

/**
 * Create a fresh, undeployed parachute system.
 *
 * DESIGN NOTES:
 *   We use factory functions (instead of `new Parachute()`) because TypeScript
 *   interfaces don't have constructors — they're pure type definitions.
 *   Factory functions also make it easy to set defaults in one place:
 *   if the default dragForce ever changes, you edit this one function rather
 *   than every `{ isDeployed: false, dragForce: X, ... }` literal across the codebase.
 *
 * @param dragForce       Maximum braking force when fully deployed (Newtons).
 *                        Default 100,000 N ≈ one Dragon-scale drogue chute.
 * @param deploymentTime  Seconds to go from ejected to fully inflated.
 *                        Default 1.0 s — reasonable for a medium-sized chute at subsonic speed.
 * @returns               A Parachute object ready to be attached to a rocket stage.
 */
export function createParachute(
  dragForce: number = 100000,
  deploymentTime: number = 1
): Parachute {
  return {
    isDeployed: false,            // Not deployed: packed in its canister at launch
    dragForce,                    // Store the maximum braking capability
    deploymentProgress: 0,        // Fully packed: 0% inflated
    deploymentTime,               // Seconds to reach full inflation
    hasBeenUsed: false,           // Not yet deployed this flight
    minAltitudeForDeployment: 1000, // Only deploy above 1 km (ensures meaningful air density)
  };
}

/**
 * Create a fresh set of landing legs.
 *
 * ENGINEERING NOTE on `shockAbsorption` default:
 *   500,000 J = 500 kJ is the default.
 *   Let's check: Falcon 9 first stage mass ≈ 22,000 kg (post-burn).
 *   At 2 m/s landing speed: KE = ½ × 22000 × 4 = 44,000 J = 44 kJ.
 *   At 5 m/s: KE = ½ × 22000 × 25 = 275 kJ — still under 500 kJ.
 *   So our default safely handles any reasonable slow landing up to ~6.7 m/s
 *   for a 22-tonne stage:  v = √(2 × 500000 / 22000) ≈ 6.7 m/s.
 *
 * @param shockAbsorption   Maximum impact energy to absorb before damage (Joules).
 *                          Default 500 kJ — designed for powered-landing residuals.
 * @returns                 A LandingGear object in retracted, undamaged state.
 */
export function createLandingGear(shockAbsorption: number = 500000): LandingGear {
  return {
    isExtended: false,    // Retracted: aerodynamic during ascent and descent
    shockAbsorption,      // Energy absorption capacity
    damageState: 0,       // Pristine: 0% damage at construction
    isBroken: false,      // Structurally sound, ready to deploy
  };
}

/**
 * Create a blank landing state for the start of a new flight.
 *
 * Called at mission start (T=0) to reset all landing tracking.
 * The default landingQuality of "PERFECT" is a placeholder — it will be
 * overwritten by processLanding() when the rocket actually touches down.
 * It should never appear in the UI before landing occurs.
 *
 * @returns  A LandingState with all fields at their initial "not yet landed" values.
 */
export function createLandingState(): LandingState {
  return {
    hasTouchedDown: false,    // Not landed yet
    landingVelocity: 0,       // No impact recorded
    landingAltitude: 0,       // Initialised to ground level
    structuralDamage: 0,      // No damage before landing
    isReusable: true,         // Assume reusable until proven otherwise
    landingQuality: "PERFECT", // Placeholder — overwritten on touchdown
    parachutesDeployed: 0,    // No parachutes used yet this flight
  };
}

// ─── PARACHUTE CONTROL ────────────────────────────────────────────────────────

/**
 * Issue the deployment command for a parachute — start its inflation sequence.
 *
 * WHY A TWO-PHASE APPROACH (deploy then update)?
 *   Real parachutes aren't instantaneous. The pyrotechnic ejector fires, the pilot
 *   chute is pulled out, the canopy bag is extracted, lines stretch, then the
 *   canopy billows open over ~0.5-3 seconds. We model this with:
 *     1. deployParachute(): issues the "eject canister" command — sets isDeployed=true
 *     2. updateParachute(): called every frame, advances deploymentProgress and
 *        returns the current drag force (proportional to inflation percentage)
 *
 *   This separation means the UI can show "Parachute Deploying..." during the
 *   inflation phase before switching to "Parachute Deployed" at full inflation.
 *
 * @param parachute  The parachute system to deploy.
 * @returns          true if deployment started successfully;
 *                   false if the parachute was already used (hasBeenUsed = true) and cannot
 *                   be deployed again — real parachutes are single-use disposables.
 */
export function deployParachute(parachute: Parachute): boolean {
  // Guard: a used parachute cannot be redeployed.
  // In real operations, once a parachute has inflated and caught air, it is
  // structurally compromised and cannot be reliably repacked for reuse in-flight.
  if (parachute.hasBeenUsed) return false;

  // Guard: if not yet deployed, start the sequence.
  // If already deploying (isDeployed=true but hasBeenUsed=false = still inflating),
  // calling deploy again has no effect — the inflation is already in progress.
  if (!parachute.isDeployed) {
    parachute.isDeployed = true;       // Mark deployment as initiated
    parachute.deploymentProgress = 0;  // Start from 0% inflation
    return true;                       // Deployment started successfully
  }

  return false; // Already deploying or fully deployed — nothing to do
}

/**
 * Advance the parachute's inflation each physics frame and return current drag force.
 *
 * CALL THIS ONCE PER PHYSICS FRAME while the parachute is deployed.
 * The caller (physics engine) should add the returned force to the rocket's drag
 * calculation to simulate the braking effect.
 *
 * QUADRATIC INFLATION CURVE:
 *   We return `dragForce × progress²` rather than a linear ramp (`dragForce × progress`).
 *   Why quadratic?
 *   - The canopy starts as a limp bag with almost no drag (progress near 0 → drag near 0)
 *   - As lines tauten and the bag opens, air starts to fill the canopy rapidly
 *   - Near full inflation, the canopy catches almost all the air and drag jumps sharply
 *   Plotting progress² vs progress: (0.1)²=0.01 (slow start), (0.5)²=0.25 (still small),
 *   (0.9)²=0.81 (most of drag kicks in near the end) — this matches real chute inflation.
 *
 * WHEN FULLY INFLATED:
 *   We set hasBeenUsed=true to mark the parachute as a single-use item.
 *   The full dragForce is returned every frame until the rocket lands.
 *
 * @param parachute  The parachute to update.
 * @param deltaTime  Time since last frame in seconds (real time, not game-speed adjusted).
 * @returns          Current drag force in Newtons (0 N if not deployed, full dragForce if open).
 */
export function updateParachute(
  parachute: Parachute,
  deltaTime: number
): number {
  // If not deployed at all, produce zero drag — parachute is still packed in its canister.
  if (!parachute.isDeployed) return 0;

  // If fully inflated (progress = 1.0), produce maximum drag and mark as consumed.
  // We mark hasBeenUsed here (at full inflation) rather than at deployment,
  // so a parachute that partially deployed still "counts" as used on the next call.
  if (parachute.deploymentProgress >= 1) {
    parachute.hasBeenUsed = true;    // Cannot redeploy — canopy is fully open and stressed
    return parachute.dragForce;      // Full braking force
  }

  // Still inflating: advance progress by the fraction of deployment time elapsed this frame.
  // At deploymentTime=1s and deltaTime=0.0167s (60Hz): progress increases by 1.67% per frame.
  // Full inflation takes 1.0 / 0.0167 ≈ 60 frames — 1 second at 60 FPS.
  parachute.deploymentProgress += deltaTime / parachute.deploymentTime;

  // Clamp to 1.0 — don't overshoot full inflation.
  parachute.deploymentProgress = Math.min(1, parachute.deploymentProgress);

  // Quadratic drag: at 50% progress, only 25% of drag. At 90% progress, 81% of drag.
  // This creates the characteristic "slow start, rapid finish" inflation feel.
  return parachute.dragForce * (parachute.deploymentProgress ** 2);
}

// ─── LANDING GEAR CONTROL ─────────────────────────────────────────────────────

/**
 * Extend the landing legs in preparation for touchdown.
 *
 * WHEN TO CALL THIS:
 *   Deploy gear with enough time for full extension before ground contact.
 *   Falcon 9 deploys ~6 seconds before touchdown at ~200 m altitude.
 *   Deploying too late (< 1-2 seconds) risks the legs not being locked when the
 *   vehicle makes contact — the legs could collapse under load.
 *
 *   In simulation, we call this from the auto-fly system when altitude < 1,000 m
 *   during the landing burn phase.
 *
 * IDEMPOTENT (safe to call multiple times):
 *   If the gear is already extended, calling this again is a no-op.
 *   If the gear is broken, the function intentionally refuses to extend it —
 *   deploying a broken leg is worse than no leg (it could jam or fail mid-deployment).
 *
 * @param gear  The landing gear assembly to deploy.
 */
export function deployLandingGear(gear: LandingGear): void {
  // Only extend if the gear is intact — broken gear cannot be safely deployed.
  // A broken leg (isBroken=true) might get stuck partway or snap under load.
  if (!gear.isBroken) {
    gear.isExtended = true; // Legs extended and locked — ready to absorb impact
  }
}

// ─── DAMAGE CALCULATION ───────────────────────────────────────────────────────

/**
 * Calculate the percentage of structural damage from a landing impact.
 *
 * PHYSICS — KINETIC ENERGY AT IMPACT:
 *   The rocket arrives at the ground with kinetic energy:
 *     KE_impact = ½ × m × v²
 *
 *   Landing gear absorbs up to `gearAbsorption` joules of this energy.
 *   The remaining energy after gear absorption must be absorbed by the structure:
 *     KE_structural = max(0, KE_impact - gearAbsorption)
 *
 *   We normalise against a "total destruction" reference:
 *     KE_max = ½ × m × (150 m/s)²
 *   150 m/s is approximately the terminal velocity of a streamlined rocket in free-fall.
 *   An impact at 150 m/s is certain destruction — 100% damage.
 *
 *   Damage fraction = KE_structural / KE_max (clamped to [0, 1]).
 *
 * EXAMPLE CALCULATION (Falcon 9 first stage):
 *   Mass ≈ 22,000 kg post-burn. Landing at v = 2 m/s with gear (500 kJ absorption):
 *     KE_impact = ½ × 22000 × 4 = 44,000 J = 44 kJ
 *     KE_structural = max(0, 44 kJ - 500 kJ) = 0 J  (gear absorbs all)
 *     Damage = 0% → PERFECT landing ✓
 *
 *   If no gear and v = 20 m/s:
 *     KE_impact = ½ × 22000 × 400 = 4,400,000 J = 4.4 MJ
 *     KE_max = ½ × 22000 × 22500 = 247,500,000 J = 247.5 MJ
 *     Damage = 4.4 / 247.5 = 1.78% → almost no damage at 20 m/s for a heavy stage!
 *   But at 20 m/s with a small capsule (500 kg):
 *     KE_impact = ½ × 500 × 400 = 100,000 J = 100 kJ
 *     KE_max = ½ × 500 × 22500 = 5,625,000 J = 5.625 MJ
 *     Damage = 100 / 5625 = 1.78% → same fraction!
 *   This makes sense: the normalisation is mass-independent. Damage is purely about
 *   how fast you hit (v²) relative to the maximum survivable speed (150²).
 *
 * @param impactVelocity  Velocity at ground contact (m/s). Sign is ignored (absolute speed).
 * @param rocketMass      Total vehicle mass at touchdown (kg). Used to compute KE.
 * @param gearAbsorption  Joules of energy the deployed landing gear can absorb.
 *                        Pass 0 if gear is not deployed or is broken.
 * @returns               Damage as a percentage 0–100.
 *                        0 = no damage; 100 = total destruction.
 */
export function calculateLandingDamage(
  impactVelocity: number,
  rocketMass: number,
  gearAbsorption: number = 0
): number {
  // Use absolute speed — direction doesn't matter for energy, only magnitude does.
  const speed = Math.abs(impactVelocity);

  // KINETIC ENERGY AT IMPACT: ½mv² in Joules.
  // A 10,000 kg rocket at 5 m/s has ½ × 10000 × 25 = 125,000 J = 125 kJ.
  const impactEnergy = 0.5 * rocketMass * (speed ** 2);

  // ENERGY ABSORBED BY GEAR: subtract gear capacity from impact energy.
  // Math.max(0, ...) prevents negative remaining energy (gear can only absorb, not "give").
  const remainingEnergy = Math.max(0, impactEnergy - gearAbsorption);

  // REFERENCE "TOTAL DESTRUCTION" ENERGY: impact at 150 m/s.
  // This normalises the damage fraction against the worst possible survivable impact.
  // Above 150 m/s the rocket would be vaporised — instant 100% damage.
  const maxExpectedEnergy = 0.5 * rocketMass * (150 ** 2);

  // DAMAGE FRACTION: remaining structural energy divided by the total-loss reference.
  // Capped at 100% — we can't be "more than destroyed".
  const damagePercent = Math.min(100, (remainingEnergy / maxExpectedEnergy) * 100);

  return damagePercent;
}

// ─── LANDING QUALITY ASSESSMENT ───────────────────────────────────────────────

/**
 * Categorise a landing from perfect to catastrophic based on speed and damage.
 *
 * QUALITY THRESHOLDS (inspired by real aerospace acceptance criteria):
 *
 *   PERFECT   — v < 3 m/s AND damage < 5%
 *     Comparable to the softest Falcon 9 drone-ship landings.
 *     The vehicle can be reflown with minimal inspection.
 *     3 m/s is approximately walking speed — very gentle for thousands of tonnes.
 *
 *   GOOD      — v < 8 m/s AND damage < 15%
 *     Acceptable for a reusable vehicle. Some wear but within margins.
 *     Apollo lunar module landed at ~1.5 m/s; Dragon capsule at ~7.6 m/s (airbag deploy).
 *
 *   ACCEPTABLE — v < 20 m/s AND damage < 40%
 *     Survivable but significant. Needs thorough post-flight inspection.
 *     Soyuz capsule lands at ~6-7 m/s (soft-landing rockets fire at the last moment),
 *     but without those retros it would hit at ~12 m/s under parachute only.
 *
 *   HARD      — v < 50 m/s AND damage < 75%
 *     Structural damage is severe. The vehicle would be a write-off in reality.
 *     50 m/s ≈ 180 km/h (motorway speed). Survivable only with extreme protection.
 *
 *   CRASH     — everything else
 *     Catastrophic. Vehicle is destroyed on impact.
 *     "High-speed lithobraking" is the sardonic aerospace term for uncontrolled impact.
 *     The Beagle 2 Mars lander (2003) is believed to have crashed at ~75 m/s.
 *
 * NOTE: The checks are ordered from best to worst, so `return "PERFECT"` only fires
 * when BOTH speed AND damage are below their respective thresholds.
 * If either threshold is exceeded, we fall through to the next category.
 *
 * @param impactVelocity  Speed at touchdown (m/s). Sign ignored (absolute value taken).
 * @param damagePercent   Structural damage from calculateLandingDamage() (0–100).
 * @returns               One of the five quality categories as a literal string type.
 */
export function getLandingQuality(
  impactVelocity: number,
  damagePercent: number
): "PERFECT" | "GOOD" | "ACCEPTABLE" | "HARD" | "CRASH" {
  const speed = Math.abs(impactVelocity); // Direction doesn't matter for landing quality

  // PERFECT: extremely soft, walking-speed impact, essentially zero damage.
  // SpaceX targets < 2 m/s; we allow up to 3 m/s for "perfect" grade.
  if (speed < 3 && damagePercent < 5) return "PERFECT";

  // GOOD: brisk but controlled. Comparable to a firm car door slam in impulse terms.
  // Dragon capsule touchdowns on water (splashdown) qualify as "good" at 7-8 m/s.
  if (speed < 8 && damagePercent < 15) return "GOOD";

  // ACCEPTABLE: moderate impact, some damage. Needs inspection before next flight.
  // Soyuz capsules routinely land in this range without parachute retro-rockets.
  if (speed < 20 && damagePercent < 40) return "ACCEPTABLE";

  // HARD: severe. Vehicle is likely not economically reusable but occupants might survive.
  // Early rocket tests (1960s Redstone) occasionally experienced these hard landings.
  if (speed < 50 && damagePercent < 75) return "HARD";

  // CRASH: catastrophic. Total structural failure. No reuse possible.
  // This is the default if none of the gentler categories applied.
  return "CRASH";
}

// ─── MAIN LANDING PROCESSOR ───────────────────────────────────────────────────

/**
 * Process a landing impact event — the main entry point when the rocket hits the ground.
 *
 * Called ONCE by the physics engine when it detects position.y ≤ 0 with downward velocity.
 * This function:
 *   1. Records the touchdown velocity and altitude
 *   2. Determines gear absorption capacity (zero if not deployed or broken)
 *   3. Calls calculateLandingDamage() to compute structural damage
 *   4. Updates gear damage state proportionally
 *   5. Sets isReusable based on damage threshold
 *   6. Calls getLandingQuality() for the categorical result
 *   7. Returns the fully-updated LandingState
 *
 * MUTATION WARNING:
 *   This function mutates BOTH `landingState` AND `gear` in place.
 *   Callers should not cache their own copies of these objects if they
 *   want to observe the post-landing values.
 *
 * @param landingState       The state object to update (mutated in place).
 * @param impactVelocity     Speed at ground contact (m/s; negative = downward).
 * @param rocketMass         Total mass of vehicle at touchdown (kg).
 * @param gear               Optional: the landing gear assembly (may be undefined if no legs).
 * @param parachutesDeployed How many parachutes were active during this descent.
 * @returns                  The same landingState object, now updated with touchdown data.
 */
export function processLanding(
  landingState: LandingState,
  impactVelocity: number,
  rocketMass: number,
  gear?: LandingGear,
  parachutesDeployed: number = 0
): LandingState {
  // ── RECORD TOUCHDOWN FACTS ─────────────────────────────────────────────────
  landingState.hasTouchedDown = true;              // The rocket is now on the ground
  landingState.landingVelocity = impactVelocity;   // Raw impact speed (for HUD and scoring)
  landingState.parachutesDeployed = parachutesDeployed; // How many chutes helped slow it down

  // ── GEAR ENERGY ABSORPTION ─────────────────────────────────────────────────
  // If the gear was deployed (extended) and not broken, it can absorb energy.
  // An undeployed or broken gear provides zero protection.
  const gearAbsorption = gear && gear.isExtended ? gear.shockAbsorption : 0;

  // ── STRUCTURAL DAMAGE ──────────────────────────────────────────────────────
  // Compute percentage of structural damage from the impact + gear capacity.
  landingState.structuralDamage = calculateLandingDamage(
    impactVelocity,
    rocketMass,
    gearAbsorption
  );

  // ── REUSABILITY ASSESSMENT ─────────────────────────────────────────────────
  // The vehicle is considered reusable if structural damage is below 50%.
  // Above 50%, the cost of repair exceeds the cost of a new vehicle (engineering estimate).
  // This mirrors SpaceX's real-world go/no-go criteria for reflying boosters.
  landingState.isReusable = landingState.structuralDamage < 50;

  // ── CATEGORICAL QUALITY RATING ─────────────────────────────────────────────
  landingState.landingQuality = getLandingQuality(
    impactVelocity,
    landingState.structuralDamage
  );

  // ── GEAR DAMAGE FEEDBACK ───────────────────────────────────────────────────
  // If the gear was used, apply proportional damage to its damage state.
  // Even a successful landing stresses the gear (crush cores compress, seals degrade).
  // Gear that absorbed more than its capacity breaks permanently.
  if (gear && gear.isExtended) {
    // Normalise structural damage to gear damage state: 100% vehicle damage → 1.0 gear damage.
    // Math.min(1, ...) ensures damage state never exceeds 1.0 (fully broken).
    gear.damageState = Math.min(1, landingState.structuralDamage / 100);

    // STRUCTURAL THRESHOLD: if vehicle damage exceeds 75%, the gear is completely broken.
    // A 75%-damaged impact means the gear absorbed far beyond its designed capacity —
    // the crush core is compacted, the latch pins are bent, and the struts have deformed.
    if (landingState.structuralDamage > 75) {
      gear.isBroken = true; // Gear cannot be used again without factory replacement
    }
  }

  return landingState; // Return the same (mutated) object for convenient chaining
}

// ─── RESET ────────────────────────────────────────────────────────────────────

/**
 * Reset all landing state for a fresh flight.
 *
 * Called when the player resets the simulation or launches a new rocket.
 * Clears touchdown records, retracts gear (if not broken), and resets parachutes
 * to undeployed state (but preserves hasBeenUsed for parachutes that are truly gone).
 *
 * NOTE ON PARACHUTE hasBeenUsed:
 *   We intentionally DON'T reset hasBeenUsed here.
 *   A parachute that was fully deployed in a previous flight is a spent unit.
 *   Resetting isDeployed and deploymentProgress (so the UI doesn't show it deploying)
 *   but leaving hasBeenUsed=true means deployParachute() will correctly refuse to
 *   re-deploy it in the next flight.
 *   To get a fresh parachute for a new flight, call createParachute() again and
 *   replace the spent unit with a new one — which is what resetRocket() does in engine.ts.
 *
 * @param landingState  The landing state to clear back to "not yet landed" values.
 * @param gear          Optional: the landing gear to retract and partially restore.
 * @param parachutes    Optional: array of parachutes to reset to undeployed state.
 */
export function resetLanding(
  landingState: LandingState,
  gear?: LandingGear,
  parachutes?: Parachute[]
): void {
  // ── RESET LANDING RECORD ───────────────────────────────────────────────────
  landingState.hasTouchedDown = false;    // Not yet landed on this new flight
  landingState.landingVelocity = 0;       // Clear impact velocity record
  landingState.structuralDamage = 0;      // Damage starts at zero for each new flight
  landingState.isReusable = true;         // Assume reusable until proven otherwise
  landingState.landingQuality = "PERFECT"; // Placeholder — overwritten at actual touchdown
  landingState.parachutesDeployed = 0;    // No parachutes deployed yet on this flight

  // ── RETRACT GEAR ──────────────────────────────────────────────────────────
  // Retract the legs and clear their damage state IF they're not permanently broken.
  // A broken gear assembly can't be retracted — it's jammed in place.
  // On a real rocket, a broken landing gear would prevent the next launch entirely
  // (it would need replacement before the next pad rollout).
  if (gear && !gear.isBroken) {
    gear.isExtended = false; // Legs retracted for aerodynamic ascent
    gear.damageState = 0;    // Reset to undamaged state (notional refurbishment)
  }

  // ── RESET PARACHUTES ──────────────────────────────────────────────────────
  // For each parachute: clear the deployed/progress state but preserve hasBeenUsed.
  // This represents the canopy collapsing after landing — but the canopy is still
  // a spent unit if it was previously fully deployed (hasBeenUsed=true).
  if (parachutes) {
    for (const parachute of parachutes) {
      parachute.isDeployed = false;         // Canopy is no longer active
      parachute.deploymentProgress = 0;    // Reset inflation progress display
      // NOTE: hasBeenUsed is intentionally NOT cleared.
      // If hasBeenUsed is true, deployParachute() will refuse to deploy it again.
      // Only createParachute() produces a genuinely fresh (reusable) unit.
    }
  }
}

// ─── DISPLAY HELPERS ─────────────────────────────────────────────────────────

/**
 * Map a landing quality category to a human-readable feedback message.
 *
 * These messages appear in the landing summary overlay (the modal shown after touchdown).
 * They're kept brief and conversational — the goal is to communicate success/failure
 * at a glance without requiring aerospace knowledge.
 *
 * GAME DESIGN NOTE:
 *   Good feedback loops require immediate, clear feedback. The quality description
 *   appears in large text right after landing so the player immediately knows
 *   how they did. Compare to SpaceX's own landing live-streams where the control
 *   room cheers at "OCISLY has the ship" (drone ship landing confirmation).
 *
 * @param quality  The categorical landing result from getLandingQuality().
 * @returns        A short human-readable description of the landing outcome.
 */
export function getLandingQualityDescription(
  quality: "PERFECT" | "GOOD" | "ACCEPTABLE" | "HARD" | "CRASH"
): string {
  switch (quality) {
    case "PERFECT":
      // Soft as a feather — the gold standard of controlled landing
      return "Textbook landing! Perfect touch-down.";

    case "GOOD":
      // Slight bump, minimal wear — vehicle is flight-ready after inspection
      return "Excellent landing. Minimal damage.";

    case "ACCEPTABLE":
      // Noticeable impact, parts will need attention before next launch
      return "Good landing. Some damage sustained.";

    case "HARD":
      // Significant structural stress — vehicle is probably not reusable
      return "Hard landing. Significant damage.";

    case "CRASH":
      // Total loss — rocket is a pile of debris
      return "Catastrophic crash! Rocket destroyed.";

    default:
      // TypeScript's exhaustive check ensures this is unreachable;
      // the `never` type would catch any missing cases at compile time.
      return "Unknown landing state.";
  }
}
