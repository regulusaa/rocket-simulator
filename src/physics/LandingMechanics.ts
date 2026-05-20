/**
 * ROCKET SIMULATOR - LANDING MECHANICS
 * ====================================
 * Advanced landing system with parachutes, landing damage, and gear deployment.
 * 
 * Real rockets use parachutes to slow descent during reentry or soft landing.
 * This system simulates:
 * - Parachute deployment (reduces falling speed)
 * - Landing damage calculation (based on impact velocity)
 * - Landing gear state (extended vs retracted)
 * - Structural integrity tracking (how damaged is the rocket)
 * 
 * When a rocket lands hard enough, it takes damage and may not be reusable.
 * Parachutes help reduce landing velocity for safer touchdowns.
 */

/**
 * Represents a parachute system for a rocket stage.
 * Parachutes are deployed during descent to slow the rocket down.
 * 
 * Real parachutes:
 * - Take time to deploy (inflation time)
 * - Have a maximum drag force (limited by parachute size)
 * - Can only be used once (single use)
 * - Only work in atmosphere (not in vacuum)
 */
export interface Parachute {
  // Is this parachute deployed (opened)?
  isDeployed: boolean;

  // How much drag force this parachute produces when open (Newtons)
  // Larger parachutes = more drag = slower descent
  dragForce: number; // Newtons

  // Current deployment progress (0-1, where 1 = fully deployed)
  // Parachutes don't deploy instantly; they inflate over time
  deploymentProgress: number;

  // How long it takes to fully deploy (seconds)
  // Real parachutes take ~0.5-2 seconds to fully inflate
  deploymentTime: number;

  // Has this parachute been used/deployed already?
  // Once deployed, it can't be redeployed (single use)
  hasBeenUsed: boolean;

  // Altitude threshold: parachute only works above this altitude
  // Prevents accidental deployment in space (no air for drag)
  minAltitudeForDeployment: number; // meters
}

/**
 * Represents landing gear for a rocket stage.
 * Landing gear absorbs impact and helps with stability during landing.
 */
export interface LandingGear {
  // Is the gear currently extended (deployed)?
  isExtended: boolean;

  // Shock absorption capacity (how much impact it can handle)
  // Higher = absorbs more energy without breaking
  shockAbsorption: number; // Energy absorption in Joules

  // Current damage state (0-1, where 1 = completely destroyed)
  damageState: number;

  // Is the gear broken/unusable?
  isBroken: boolean;
}

/**
 * Landing state for the rocket (tracked during and after landing)
 */
export interface LandingState {
  // Has the rocket touched down (made contact with ground)?
  hasTouchedDown: boolean;

  // Landing velocity when impact occurred (m/s, negative = downward)
  landingVelocity: number;

  // Landing altitude (for determining parachute deployment eligibility)
  landingAltitude: number;

  // Total structural damage sustained (0-100%)
  // 0% = pristine, 100% = total loss
  structuralDamage: number;

  // Is the rocket reusable after this landing?
  // True if damage is low, false if too damaged
  isReusable: boolean;

  // Landing quality description (for UI display)
  landingQuality: "PERFECT" | "GOOD" | "ACCEPTABLE" | "HARD" | "CRASH";

  // Number of parachutes deployed during this descent
  parachutesDeployed: number;
}

/**
 * Create a parachute system for a stage.
 * Used when building a rocket with parachute recovery capability.
 * 
 * @param dragForce - How much drag this parachute produces (Newtons)
 * @param deploymentTime - How long to fully deploy (seconds)
 * @returns Initialized Parachute object
 */
export function createParachute(
  dragForce: number = 100000, // Default: large parachute (~100kN drag)
  deploymentTime: number = 1 // Default: 1 second to deploy
): Parachute {
  return {
    isDeployed: false, // Not deployed initially
    dragForce, // Store the drag force capability
    deploymentProgress: 0, // No progress yet
    deploymentTime, // Time to reach full deployment
    hasBeenUsed: false, // Not yet used
    minAltitudeForDeployment: 1000, // Deploy only above 1km altitude (atmospheric)
  };
}

/**
 * Create landing gear for a stage.
 * Absorbs impact energy during landing.
 * 
 * @param shockAbsorption - How much energy it can absorb (Joules)
 * @returns Initialized LandingGear object
 */
export function createLandingGear(shockAbsorption: number = 500000): LandingGear {
  return {
    isExtended: false, // Gear starts retracted (for aerodynamics during flight)
    shockAbsorption, // How much impact energy it can handle
    damageState: 0, // No damage initially
    isBroken: false, // Gear works fine at start
  };
}

/**
 * Initialize landing state for a new flight.
 * Called at launch to reset landing tracking.
 * 
 * @returns Fresh LandingState for new flight
 */
export function createLandingState(): LandingState {
  return {
    hasTouchedDown: false,
    landingVelocity: 0,
    landingAltitude: 0,
    structuralDamage: 0,
    isReusable: true,
    landingQuality: "PERFECT",
    parachutesDeployed: 0,
  };
}

/**
 * Deploy a parachute, starting its inflation sequence.
 * Called when conditions are right (altitude, speed, etc.).
 * 
 * In real rockets:
 * - Parachutes are deployed when rocket is high enough (air density sufficient)
 * - Often deployed during descent after reaching apogee
 * - Can be deployed automatically or manually
 * 
 * @param parachute - The parachute to deploy
 * @returns true if deployment started, false if already deployed or can't deploy
 */
export function deployParachute(parachute: Parachute): boolean {
  // Can't redeploy if already used
  if (parachute.hasBeenUsed) return false;

  // If not yet deployed, start the deployment sequence
  if (!parachute.isDeployed) {
    parachute.isDeployed = true;
    parachute.deploymentProgress = 0; // Start inflation from 0%
    return true;
  }

  return false;
}

/**
 * Update parachute state during descent.
 * Gradually inflates the parachute over deployment time.
 * 
 * @param parachute - The parachute to update
 * @param deltaTime - Time since last update (seconds)
 * @returns Current drag force being produced (0 if not deployed)
 */
export function updateParachute(
  parachute: Parachute,
  deltaTime: number
): number {
  // If not deployed, produces no drag
  if (!parachute.isDeployed) return 0;

  // If fully deployed, produce full drag
  if (parachute.deploymentProgress >= 1) {
    parachute.hasBeenUsed = true; // Mark as used
    return parachute.dragForce;
  }

  // Parachute is inflating: gradually increase deployment progress
  // Progress += (time passed / total deployment time)
  parachute.deploymentProgress += deltaTime / parachute.deploymentTime;

  // Cap at 100% deployed
  parachute.deploymentProgress = Math.min(1, parachute.deploymentProgress);

  // Return partial drag while inflating (drag increases as parachute inflates)
  // Quadratic curve: drag = fullDrag * progress²
  // This gives more realistic inflation (slow start, quick finish)
  return parachute.dragForce * (parachute.deploymentProgress ** 2);
}

/**
 * Calculate damage taken during landing impact.
 * Based on impact velocity and landing gear capability.
 * 
 * Physics:
 * - Impact energy = 0.5 * mass * velocity²
 * - Gear absorbs some energy
 * - Remaining energy = structural damage
 * 
 * @param impactVelocity - Speed at impact (m/s, should be negative for downward)
 * @param rocketMass - Total mass of rocket (kg)
 * @param gearAbsorption - How much energy gear absorbs (Joules)
 * @returns Damage percentage (0-100%)
 */
export function calculateLandingDamage(
  impactVelocity: number,
  rocketMass: number,
  gearAbsorption: number = 0
): number {
  // Convert to absolute speed (we don't care about direction)
  const speed = Math.abs(impactVelocity);

  // Calculate impact energy using kinetic energy formula: KE = 0.5 * m * v²
  // This is the total energy that must be dissipated during landing
  const impactEnergy = 0.5 * rocketMass * (speed ** 2);

  // Landing gear absorbs some of this energy
  // Remaining energy causes damage
  const remainingEnergy = Math.max(0, impactEnergy - gearAbsorption);

  // Convert remaining energy to damage percentage
  // Normalize by expected max energy (150 m/s crash = max damage reference)
  const maxExpectedEnergy = 0.5 * rocketMass * (150 ** 2);

  // Damage = remaining energy / max expected energy, capped at 100%
  const damagePercent = Math.min(100, (remainingEnergy / maxExpectedEnergy) * 100);

  return damagePercent;
}

/**
 * Determine landing quality based on impact velocity and damage.
 * Used to categorize the landing for UI and scoring.
 * 
 * @param impactVelocity - Speed at impact (m/s)
 * @param damagePercent - Structural damage (0-100%)
 * @returns Landing quality category
 */
export function getLandingQuality(
  impactVelocity: number,
  damagePercent: number
): "PERFECT" | "GOOD" | "ACCEPTABLE" | "HARD" | "CRASH" {
  const speed = Math.abs(impactVelocity);

  // Perfect landing: very soft, no damage
  if (speed < 3 && damagePercent < 5) return "PERFECT";

  // Good landing: soft, minimal damage
  if (speed < 8 && damagePercent < 15) return "GOOD";

  // Acceptable landing: moderate impact, some damage but reusable
  if (speed < 20 && damagePercent < 40) return "ACCEPTABLE";

  // Hard landing: significant impact, heavy damage but not destroyed
  if (speed < 50 && damagePercent < 75) return "HARD";

  // Crash: violent impact, severe or total damage
  return "CRASH";
}

/**
 * Deploy landing gear in preparation for touchdown.
 * Gear extends to absorb shock during landing.
 * 
 * @param gear - The landing gear to deploy
 */
export function deployLandingGear(gear: LandingGear): void {
  // Extend the gear (if not already broken)
  if (!gear.isBroken) {
    gear.isExtended = true;
  }
}

/**
 * Process a landing impact, calculating damage and updating landing state.
 * Called when rocket touches ground.
 * 
 * @param landingState - The landing state to update
 * @param impactVelocity - Speed at impact (m/s)
 * @param rocketMass - Total mass (kg)
 * @param gear - Landing gear (if any)
 * @param parachutesDeployed - How many parachutes were used
 * @returns Updated landing state
 */
export function processLanding(
  landingState: LandingState,
  impactVelocity: number,
  rocketMass: number,
  gear?: LandingGear,
  parachutesDeployed: number = 0
): LandingState {
  // Record impact details
  landingState.hasTouchedDown = true;
  landingState.landingVelocity = impactVelocity;
  landingState.parachutesDeployed = parachutesDeployed;

  // Calculate damage from impact
  const gearAbsorption = gear && gear.isExtended ? gear.shockAbsorption : 0;
  landingState.structuralDamage = calculateLandingDamage(
    impactVelocity,
    rocketMass,
    gearAbsorption
  );

  // Determine if rocket is still reusable
  // Reusable if damage is below critical threshold (usually 50%)
  landingState.isReusable = landingState.structuralDamage < 50;

  // Determine landing quality
  landingState.landingQuality = getLandingQuality(
    impactVelocity,
    landingState.structuralDamage
  );

  // If gear was used, it may have taken damage
  if (gear && gear.isExtended) {
    // Gear absorbs impact damage
    // Damage to gear = how much its absorption capacity was exceeded
    if (landingState.structuralDamage > 0) {
      gear.damageState = Math.min(1, landingState.structuralDamage / 100);

      // If damage exceeds absorption capacity, gear breaks
      if (landingState.structuralDamage > 75) {
        gear.isBroken = true;
      }
    }
  }

  return landingState;
}

/**
 * Reset landing state for a new flight.
 * Restores gear (unless broken) and clears parachute deployment.
 * 
 * @param landingState - The state to reset
 * @param gear - The gear to restore
 * @param parachutes - Any parachutes to reset
 */
export function resetLanding(
  landingState: LandingState,
  gear?: LandingGear,
  parachutes?: Parachute[]
): void {
  // Reset landing tracking
  landingState.hasTouchedDown = false;
  landingState.landingVelocity = 0;
  landingState.structuralDamage = 0;
  landingState.isReusable = true;
  landingState.landingQuality = "PERFECT";
  landingState.parachutesDeployed = 0;

  // Reset gear (retract and restore if not broken)
  if (gear && !gear.isBroken) {
    gear.isExtended = false;
    gear.damageState = 0;
  }

  // Reset parachutes (mark as not deployed, but remember if used up)
  if (parachutes) {
    for (const parachute of parachutes) {
      parachute.isDeployed = false;
      parachute.deploymentProgress = 0;
      // Note: hasBeenUsed stays true if parachute was already used
    }
  }
}

/**
 * Get human-readable description of landing quality.
 * Used for UI display and feedback.
 * 
 * @param quality - Landing quality category
 * @returns Descriptive text
 */
export function getLandingQualityDescription(
  quality: "PERFECT" | "GOOD" | "ACCEPTABLE" | "HARD" | "CRASH"
): string {
  switch (quality) {
    case "PERFECT":
      return "Textbook landing! Perfect touch-down.";
    case "GOOD":
      return "Excellent landing. Minimal damage.";
    case "ACCEPTABLE":
      return "Good landing. Some damage sustained.";
    case "HARD":
      return "Hard landing. Significant damage.";
    case "CRASH":
      return "Catastrophic crash! Rocket destroyed.";
    default:
      return "Unknown landing state.";
  }
}