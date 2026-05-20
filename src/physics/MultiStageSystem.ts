/**
 * ROCKET SIMULATOR - MULTI-STAGE SYSTEM
 * =====================================
 * This file implements the multi-stage rocket system. Real rockets use multiple stages
 * because as fuel burns, the empty fuel tank becomes dead weight. By jettisoning
 * (separating) empty stages, the remaining rocket is much lighter and can accelerate faster.
 * 
 * How it works:
 * - A rocket is made of multiple stages stacked on top of each other
 * - Each stage has its own engine, fuel tank, and dry mass
 * - When a stage runs out of fuel, it can separate (detach from the rest)
 * - The next stage ignites, and the rocket continues accelerating with less mass
 * 
 * This is why the SpaceX Falcon 9 is so impressive: it uses 9 engines in the first stage,
 * then a single engine in the second stage. That 9-to-1 ratio is because the second stage
 * has much less mass to push (no first stage engines, no first stage structure).
 */

/**
 * Represents a single stage of a multi-stage rocket.
 * Each stage is independent: it has its own engine, fuel, and structural mass.
 * 
 * Stages are ordered from bottom (Stage 0 = first stage) to top (Stage N = final stage).
 * The first stage does most of the work getting off the ground.
 * Later stages are lighter but more efficient (higher specific impulse).
 */
export interface RocketStage {
  // === IDENTIFICATION ===
  // Which stage number this is (0 = first/bottom stage, increases upward)
  stageNumber: number;

  // Human-readable name (e.g., "First Stage", "Second Stage", "Payload Stage")
  name: string;

  // === MASS PROPERTIES ===
  // Dry mass of this stage's structure (engines, tanks, avionics, etc.)
  // This is the mass when the stage has NO fuel
  dryMass: number; // kg

  // How much fuel this stage can hold in its tank
  fuelCapacity: number; // kg

  // Current fuel remaining in this stage
  fuelMass: number; // kg

  // === ENGINE PROPERTIES ===
  // The thrust this stage's engine produces (at sea level for first stage)
  // Higher stages often have lower thrust but higher specific impulse
  engineThrust: number; // Newtons

  // Engine efficiency (specific impulse in seconds)
  // How long 1 kg of fuel can produce 1 Newton of thrust
  // Higher Isp = fuel lasts longer = more efficient
  // First stages: ~280-300s, Second stages: ~350-420s (vacuum)
  specificImpulse: number; // seconds

  // === STATE ===
  // Is this stage currently active (producing thrust)?
  // False if separated or if later stage is active
  isActive: boolean;

  // Has this stage separated from the rocket?
  // Once separated, it's gone and can't produce thrust
  isSeparated: boolean;

  // Is this stage currently thrusting (engine is firing)?
  // Only true if: isActive AND NOT isSeparated AND throttle > 0
  isThrusting: boolean;

  // Current throttle level (0-100%) for this stage
  // Controlled by player or automatic staging logic
  thrustPercentage: number;

  // Burn rate of fuel (kg/s consumed when thrusting)
  // Calculated from thrust and specific impulse
  burnRate: number;
}

/**
 * A multi-stage rocket configuration.
 * Defines the structure of the entire rocket (all its stages).
 */
export interface MultiStageRocketConfig {
  // Name of the rocket (e.g., "Falcon 9", "Saturn V", "Starship")
  name: string;

  // All stages that make up this rocket, ordered from bottom to top
  // stages[0] = first stage (bottom), stages[N] = final stage (top)
  stages: RocketStage[];

  // Total payload mass at the top (non-propellant, e.g., satellite, crew capsule)
  // This mass doesn't produce thrust but needs to be accelerated
  payloadMass: number; // kg
}

/**
 * Create a RocketStage with calculated burn rate.
 * Helper function to simplify stage creation.
 * 
 * @param options - Stage configuration
 * @returns A fully initialized RocketStage
 */
export function createRocketStage(options: {
  stageNumber: number;
  name: string;
  dryMass: number;
  fuelCapacity: number;
  engineThrust: number;
  specificImpulse: number;
}): RocketStage {
  // Calculate burn rate from thrust and specific impulse
  // Formula: burnRate = thrust / (g0 * Isp)
  // where g0 = 9.81 m/s² (standard gravity at Earth surface)
  // This tells us: how much fuel (kg) is consumed per second at full throttle
  // Higher Isp = lower burn rate = fuel lasts longer
  const burnRate = options.engineThrust / (9.81 * options.specificImpulse);

  return {
    stageNumber: options.stageNumber,
    name: options.name,
    dryMass: options.dryMass,
    fuelCapacity: options.fuelCapacity,
    fuelMass: options.fuelCapacity, // Start with full fuel tank
    engineThrust: options.engineThrust,
    specificImpulse: options.specificImpulse,
    isActive: options.stageNumber === 0, // Only first stage starts active
    isSeparated: false, // No stages separated at start
    isThrusting: false, // Engines off at start
    thrustPercentage: 0, // Throttle starts at 0%
    burnRate, // Pre-calculated burn rate
  };
}

/**
 * Calculate the total mass of all active (not separated) stages plus payload.
 * This is used in physics calculations: F = m * a, so we need total mass.
 * 
 * @param config - The multi-stage rocket config
 * @returns Total mass in kg of all active stages and payload
 */
export function calculateTotalMass(config: MultiStageRocketConfig): number {
  // Start with payload mass (constant, never changes)
  let total = config.payloadMass;

  // Add the mass of each stage (if not separated)
  for (const stage of config.stages) {
    // Only count stages that haven't separated
    if (!stage.isSeparated) {
      // Each stage's mass = dry mass (structure + engines) + fuel mass
      total += stage.dryMass + stage.fuelMass;
    }
  }

  return total;
}

/**
 * Calculate total available thrust from all active stages.
 * This is the sum of all stages that are:
 * - Not separated
 * - Currently thrusting (engine on, fuel available)
 * 
 * @param config - The multi-stage rocket config
 * @returns Total thrust in Newtons
 */
export function calculateTotalThrust(config: MultiStageRocketConfig): number {
  // Start at zero thrust
  let totalThrust = 0;

  // Sum thrust from all active stages
  for (const stage of config.stages) {
    // Only count stages that are: not separated AND currently thrusting
    if (!stage.isSeparated && stage.isThrusting && stage.fuelMass > 0) {
      // Calculate actual thrust based on throttle percentage
      // If throttle is 50%, only use 50% of max thrust
      const actualThrust = stage.engineThrust * (stage.thrustPercentage / 100);
      totalThrust += actualThrust;
    }
  }

  return totalThrust;
}

/**
 * Set the throttle for a specific stage.
 * Only works if the stage is active and not separated.
 * 
 * @param stage - The stage to set throttle for
 * @param throttlePercent - Desired throttle 0-100%
 */
export function setStageLevelThrottle(
  stage: RocketStage,
  throttlePercent: number
): void {
  // Clamp throttle to valid range [0, 100]
  stage.thrustPercentage = Math.max(0, Math.min(100, throttlePercent));

  // Set isThrusting flag: true if throttle > 0 AND we have fuel AND stage is active
  stage.isThrusting = stage.thrustPercentage > 0 && stage.fuelMass > 0 && stage.isActive;
}

/**
 * Apply throttle commands to all stages uniformly (like in real rockets).
 * This simulates the player holding spacebar or clicking — it affects all active stages equally.
 * 
 * In reality, rocket engines are more complex (some stages can throttle, some can't),
 * but for this simulator we keep it simple.
 * 
 * @param config - The rocket config
 * @param isHoldingThrottle - Is the player holding the throttle key?
 * @param clickThrottle - Did the player just click (burst)?
 * @param throttleMultiplier - Control responsiveness (0-1)
 */
export function applyMultiStageThrottle(
  config: MultiStageRocketConfig,
  isHoldingThrottle: boolean,
  clickThrottle: boolean,
  throttleMultiplier: number = 1
): void {
  // Loop through all active stages and apply throttle changes
  for (const stage of config.stages) {
    // Skip if stage is separated (can't thrust anymore)
    if (stage.isSeparated) continue;

    // Start with current throttle
    let desiredThrottle = stage.thrustPercentage;

    // Holding the key increases throttle gradually
    if (isHoldingThrottle) {
      // Increase by 2% per frame, multiplied by responsiveness factor
      desiredThrottle = Math.min(100, desiredThrottle + 2 * throttleMultiplier);
    } else {
      // Not holding key: throttle decreases (engines spool down)
      desiredThrottle = Math.max(0, desiredThrottle - 2 * throttleMultiplier);
    }

    // Click adds a burst of thrust
    if (clickThrottle) {
      desiredThrottle = Math.min(100, desiredThrottle + 10);
    }

    // Apply the calculated throttle to this stage
    setStageLevelThrottle(stage, desiredThrottle);
  }
}

/**
 * Check if any stage should separate based on fuel status.
 * Staging logic: when a stage runs out of fuel (fuelMass <= 0), it should separate
 * and the next stage should activate.
 * 
 * This is automatic in real rockets — the stage controller detects empty fuel tank
 * and triggers separation + ignition of next stage.
 * 
 * @param config - The rocket config
 * @returns true if a stage separated during this check, false otherwise
 */
export function checkAndPerformStaging(config: MultiStageRocketConfig): boolean {
  // Track if we performed any separations
  let stagingOccurred = false;

  // Loop through all stages looking for empty ones
  for (let i = 0; i < config.stages.length; i++) {
    const currentStage = config.stages[i];

    // Check if this stage is out of fuel and hasn't already separated
    if (currentStage.fuelMass <= 0 && !currentStage.isSeparated && currentStage.isActive) {
      // === SEPARATE THIS STAGE ===
      // Mark it as separated (it's now jettisoned, falls away)
      currentStage.isSeparated = true;
      currentStage.isActive = false;
      currentStage.isThrusting = false;
      currentStage.thrustPercentage = 0;

      // === IGNITE NEXT STAGE ===
      // Is there a next stage above this one?
      if (i + 1 < config.stages.length) {
        const nextStage = config.stages[i + 1];

        // Activate the next stage
        nextStage.isActive = true;

        // Set it to 100% throttle (full power for new stage)
        // This matches real rocket behavior: staging = full throttle of next engine
        setStageLevelThrottle(nextStage, 100);
      }

      // Record that staging occurred
      stagingOccurred = true;

      // Note: We break here so only one stage stages per frame
      // In reality, this is basically instant, but for simulation stability
      // we do one separation per physics update
      break;
    }
  }

  return stagingOccurred;
}

/**
 * Update the fuel mass of all active stages.
 * Called every physics frame to consume fuel based on throttle and burn rate.
 * 
 * @param config - The rocket config
 * @param deltaTime - Time since last frame (seconds)
 */
export function consumeFuel(
  config: MultiStageRocketConfig,
  deltaTime: number
): void {
  // Loop through all stages
  for (const stage of config.stages) {
    // Skip if separated or not thrusting
    if (stage.isSeparated || !stage.isThrusting) continue;

    // Calculate fuel burned this frame
    // fuelBurned = burnRate (kg/s) * throttle% * deltaTime (s)
    // Higher throttle = more fuel burned per second
    const fuelBurnedThisFrame =
      stage.burnRate * (stage.thrustPercentage / 100) * deltaTime;

    // Subtract from fuel tank
    stage.fuelMass -= fuelBurnedThisFrame;

    // Clamp to zero (can't have negative fuel)
    if (stage.fuelMass < 0) {
      stage.fuelMass = 0;
    }

    // If fuel is empty and engine is on, turn it off
    // This prevents thrusting on empty tank
    if (stage.fuelMass <= 0) {
      stage.isThrusting = false;
      stage.thrustPercentage = 0;
    }
  }
}

/**
 * Reset all stages to their initial state for a new launch.
 * Called when player clicks "Reset" button.
 * 
 * @param config - The rocket config to reset
 */
export function resetAllStages(config: MultiStageRocketConfig): void {
  // Reset each stage
  for (const stage of config.stages) {
    // Refill fuel tank to capacity
    stage.fuelMass = stage.fuelCapacity;

    // Mark as not separated (re-attach to rocket)
    stage.isSeparated = false;

    // Only first stage (stageNumber=0) should be active at start
    stage.isActive = stage.stageNumber === 0;

    // Turn off engines
    stage.isThrusting = false;
    stage.thrustPercentage = 0;
  }
}

/**
 * Create a pre-configured multi-stage rocket (like Falcon 9).
 * Real-world inspired rocket with realistic numbers.
 * 
 * Falcon 9-inspired specs:
 * - First stage: 9 Merlin engines, ~770 tons at launch
 * - Second stage: 1 Merlin vacuum engine, ~110 tons
 */
export const ROCKET_FALCON_9_INSPIRED: MultiStageRocketConfig = {
  name: "Falcon 9 Inspired",
  payloadMass: 10000, // 10 tons payload (satellite)

  stages: [
    // First stage (booster)
    // Does most of the work getting off the ground
    // Lots of thrust but lower specific impulse (air has drag at sea level)
    createRocketStage({
      stageNumber: 0,
      name: "First Stage",
      dryMass: 40000, // ~40 tons of structure (9 engines, avionics, etc.)
      fuelCapacity: 380000, // ~380 tons of fuel (RP-1 and LOX)
      engineThrust: 7682000, // ~7.7 MN total (9 × ~850 kN)
      specificImpulse: 282, // 282 seconds at sea level
    }),

    // Second stage (upper stage)
    // Lighter, more efficient, continues until orbit
    // Lower thrust but higher specific impulse (operates in vacuum)
    createRocketStage({
      stageNumber: 1,
      name: "Second Stage",
      dryMass: 4000, // ~4 tons structure (1 engine, smaller avionics)
      fuelCapacity: 100000, // ~100 tons of fuel
      engineThrust: 934000, // ~934 kN (1 Merlin vacuum)
      specificImpulse: 348, // 348 seconds in vacuum (very efficient!)
    }),
  ],
};

/**
 * Create a simple two-stage rocket for learning (not realistic, but good for testing)
 */
export const ROCKET_SIMPLE_TWO_STAGE: MultiStageRocketConfig = {
  name: "Simple Two-Stage",
  payloadMass: 1000,

  stages: [
    createRocketStage({
      stageNumber: 0,
      name: "Booster",
      dryMass: 5000,
      fuelCapacity: 15000,
      engineThrust: 500000,
      specificImpulse: 250,
    }),

    createRocketStage({
      stageNumber: 1,
      name: "Upper Stage",
      dryMass: 1000,
      fuelCapacity: 5000,
      engineThrust: 150000,
      specificImpulse: 320,
    }),
  ],
};

/**
 * Create a three-stage rocket (very ambitious, like Saturn V)
 */
export const ROCKET_THREE_STAGE: MultiStageRocketConfig = {
  name: "Three-Stage Heavy",
  payloadMass: 5000,

  stages: [
    createRocketStage({
      stageNumber: 0,
      name: "First Stage",
      dryMass: 8000,
      fuelCapacity: 40000,
      engineThrust: 1000000,
      specificImpulse: 260,
    }),

    createRocketStage({
      stageNumber: 1,
      name: "Second Stage",
      dryMass: 2000,
      fuelCapacity: 12000,
      engineThrust: 250000,
      specificImpulse: 310,
    }),

    createRocketStage({
      stageNumber: 2,
      name: "Third Stage",
      dryMass: 500,
      fuelCapacity: 3000,
      engineThrust: 70000,
      specificImpulse: 350,
    }),
  ],
};