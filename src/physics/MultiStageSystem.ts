/**
 * ROCKET SIMULATOR - MULTI-STAGE SYSTEM
 * =====================================
 * Implements the multi-stage rocket model: separate stages, fuel consumption, staging.
 *
 * WHAT IS STAGING?
 * Real rockets discard empty fuel tanks (stages) so the remaining vehicle is lighter.
 * A lighter vehicle needs less thrust for the same acceleration (F = ma → a = F/m).
 * Saturn V (Moon rocket) had 3 stages; Falcon 9 has 2.
 *
 * CHANGES IN THIS VERSION:
 *   - applyMultiStageThrottle() now takes deltaTime for time-based throttle ramping
 *   - Throttle ramps UP at  50 %/s  → full throttle takes 2 seconds (was instant)
 *   - Throttle ramps DOWN at 100 %/s → idle in 1 second (faster for player control)
 *   - Click burst adds only 30% throttle (not 10% — was an immediate tiny pulse)
 *   - Rocket configs rebalanced for realistic TWR (1.3 – 1.5 at launch)
 *
 * WHY THROTTLE RAMPING MATTERS:
 *   The original code used +2% per frame (≈120%/s). At TWR≈1.9 and immediate
 *   full throttle, the rocket reached max speed so quickly it flew off the 600 px
 *   canvas in under 3 seconds. With 50%/s ramp the player has time to orient the
 *   camera (now automatic via Camera.ts) and understand what is happening.
 */

import {
  THROTTLE_INCREASE_RATE,
  THROTTLE_DECREASE_RATE,
  THROTTLE_BURST_AMOUNT,
} from "../utils/constants";
// Import throttle rate constants so tuning them in constants.ts instantly affects
// all rocket types without needing to touch this file.

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * A single stage of a multi-stage rocket.
 * Stages are stacked bottom-to-top: stages[0] = first stage (booster, bottom).
 *
 * Each stage carries its own engine, fuel tank, and structural mass.
 * When its fuel runs out, it separates and the next stage ignites.
 */
export interface RocketStage {
  // ── IDENTIFICATION ──
  stageNumber: number; // 0 = first (bottom), 1 = second, etc.
  name: string;        // Human-readable label shown in telemetry ("Booster", "Upper Stage")

  // ── MASS ──
  dryMass: number;       // kg — structural mass with NO fuel (engines, tanks, avionics)
  fuelCapacity: number;  // kg — maximum fuel this stage's tank can hold
  fuelMass: number;      // kg — current fuel remaining (decreases as engines burn)

  // ── ENGINE ──
  engineThrust: number;    // N — maximum thrust at 100% throttle
  specificImpulse: number; // s — engine efficiency (how long 1 kg of fuel produces 1 N)
  burnRate: number;        // kg/s — fuel consumed per second at 100% throttle

  // ── STATE ──
  isActive: boolean;       // True if this stage is the one currently in control
  isSeparated: boolean;    // True once this stage has been jettisoned (can't thrust)
  isThrusting: boolean;    // True if: isActive AND NOT isSeparated AND throttle > 0 AND fuel > 0
  thrustPercentage: number; // 0–100%: current throttle level
}

/**
 * A complete multi-stage rocket definition.
 * Passed to the physics engine to calculate mass, thrust, and staging.
 */
export interface MultiStageRocketConfig {
  name: string;         // Display name (e.g., "Falcon 9 Inspired")
  stages: RocketStage[]; // All stages bottom-to-top (stages[0] fires first)
  payloadMass: number;  // kg — non-propellant mass at the top (satellite, capsule)
}

// ─── FACTORY ──────────────────────────────────────────────────────────────────

/**
 * Create a RocketStage with the burn rate auto-calculated from thrust and Isp.
 *
 * BURN RATE FORMULA:
 *   burnRate = thrust / (g₀ × Isp)
 *   where g₀ = 9.81 m/s² (standard gravity, used even in vacuum for Isp convention).
 *
 * This tells us: how many kg of propellant per second at 100% throttle?
 * A high Isp engine burns LESS fuel per second for the same thrust — more efficient.
 *   Example: Merlin at sea level: 7682 kN / (9.81 × 282) = 2778 kg/s burn rate.
 *
 * @param options  Stage configuration options.
 * @returns        Fully initialized RocketStage ready for physics simulation.
 */
export function createRocketStage(options: {
  stageNumber: number;
  name: string;
  dryMass: number;
  fuelCapacity: number;
  engineThrust: number;
  specificImpulse: number;
}): RocketStage {
  // Rocket equation burn rate: how many kg of fuel are burned per second at full throttle.
  // This is derived from the Tsiolkovsky rocket equation efficiency parameter.
  const burnRate = options.engineThrust / (9.81 * options.specificImpulse);

  return {
    stageNumber: options.stageNumber,
    name: options.name,
    dryMass: options.dryMass,
    fuelCapacity: options.fuelCapacity,
    fuelMass: options.fuelCapacity,  // Start with a FULL fuel tank
    engineThrust: options.engineThrust,
    specificImpulse: options.specificImpulse,
    isActive: options.stageNumber === 0, // Only the first stage (bottom) starts active
    isSeparated: false,   // No stage starts separated
    isThrusting: false,   // Engine is off at start (throttle = 0)
    thrustPercentage: 0,  // Throttle starts at zero (player must hold SPACEBAR)
    burnRate,             // Pre-calculated from thrust and Isp
  };
}

// ─── MASS & THRUST CALCULATIONS ───────────────────────────────────────────────

/**
 * Sum the masses of all stages that have NOT been separated, plus payload.
 * This is the total mass the engines must accelerate (used in a = F/m).
 *
 * Mass decreases during flight as:
 *   1. Fuel burns (fuelMass decreases each frame in consumeFuel())
 *   2. Stages separate (their mass is no longer counted)
 * Both effects increase acceleration for the same thrust (lighter → faster).
 *
 * @param config The rocket configuration.
 * @returns      Total mass in kg of all attached stages + payload.
 */
export function calculateTotalMass(config: MultiStageRocketConfig): number {
  let total = config.payloadMass; // Payload is always present (never jettisoned here)

  for (const stage of config.stages) {
    if (!stage.isSeparated) {
      // Count this stage: dry structure + remaining fuel.
      total += stage.dryMass + stage.fuelMass;
    }
    // Separated stages have fallen away — they contribute zero mass.
  }

  return total;
}

/**
 * Sum thrust from all stages that are currently firing.
 * A stage contributes thrust only if: not separated, is thrusting, and has fuel.
 * Actual thrust = max thrust × (throttle% / 100).
 *
 * @param config The rocket configuration.
 * @returns      Total thrust in Newtons being produced right now.
 */
export function calculateTotalThrust(config: MultiStageRocketConfig): number {
  let totalThrust = 0;

  for (const stage of config.stages) {
    // Skip stages that have separated (gone) or aren't burning.
    if (!stage.isSeparated && stage.isThrusting && stage.fuelMass > 0) {
      // Scale thrust by throttle percentage: 50% throttle = 50% of max thrust.
      totalThrust += stage.engineThrust * (stage.thrustPercentage / 100);
    }
  }

  return totalThrust;
}

// ─── THROTTLE CONTROL ─────────────────────────────────────────────────────────

/**
 * Set the throttle level for a single stage, and update its thrusting flag.
 *
 * @param stage           The stage to update.
 * @param throttlePercent Desired throttle 0–100%.
 */
export function setStageLevelThrottle(
  stage: RocketStage,
  throttlePercent: number
): void {
  // Clamp to the valid 0–100% range.
  stage.thrustPercentage = Math.max(0, Math.min(100, throttlePercent));

  // isThrusting is true only if ALL of: throttle > 0, has fuel, is active.
  // This means the engine light goes out the moment any condition is false.
  stage.isThrusting =
    stage.thrustPercentage > 0 && stage.fuelMass > 0 && stage.isActive;
}

/**
 * Apply the player's throttle input to all active (non-separated) stages.
 * This is called every physics tick from engine.ts → applyControls().
 *
 * THROTTLE RAMPING (the key fix for "too sensitive thrust"):
 *   - Holding SPACEBAR: throttle increases at THROTTLE_INCREASE_RATE (%/s).
 *     Default 50 %/s → takes 2 full seconds to go 0% → 100%.
 *   - Releasing SPACEBAR: throttle decreases at THROTTLE_DECREASE_RATE (%/s).
 *     Default 100 %/s → takes 1 second to spool down to 0%.
 *   - Single click: adds THROTTLE_BURST_AMOUNT (30%) as a short pulse.
 *
 * WHY TIME-BASED RATES?
 *   The original code used "+2% per call" which ran at 60fps = +120%/s.
 *   That's instant full throttle in 0.83s. With 50%/s, the player has 2 seconds
 *   to watch the rocket start slowly and decide how long to hold the key.
 *
 * @param config            The rocket configuration.
 * @param isHoldingThrottle True while SPACEBAR is held down.
 * @param clickThrottle     True for ONE frame when the player clicks the canvas.
 * @param deltaTime         Seconds elapsed this physics tick (for frame-rate independence).
 */
export function applyMultiStageThrottle(
  config: MultiStageRocketConfig,
  isHoldingThrottle: boolean,
  clickThrottle: boolean,
  deltaTime: number
): void {
  for (const stage of config.stages) {
    // Separated stages are gone — can't throttle them.
    if (stage.isSeparated) continue;

    // Start from the current throttle level.
    let desiredThrottle = stage.thrustPercentage;

    if (isHoldingThrottle) {
      // Gradually ramp UP. THROTTLE_INCREASE_RATE * deltaTime converts %/s to %/frame.
      // At 50 %/s and 60fps (Δt ≈ 0.016s): Δthrottle = 50 * 0.016 = 0.83% per frame.
      // That means 100/0.83 ≈ 120 frames = 2.0 seconds to go 0→100%. Controllable!
      desiredThrottle += THROTTLE_INCREASE_RATE * deltaTime;
    } else {
      // Gradually ramp DOWN when key released.
      // At 100 %/s and 60fps: Δthrottle = -100 * 0.016 = -1.67% per frame.
      // That means 60 frames = 1.0 second to go 100→0%. Fast enough to stop burning.
      desiredThrottle -= THROTTLE_DECREASE_RATE * deltaTime;
    }

    // A single click adds a fixed throttle pulse on top of the current level.
    // 30% is enough to feel responsive without launching the rocket instantly.
    if (clickThrottle) {
      desiredThrottle += THROTTLE_BURST_AMOUNT;
    }

    // Apply the clamped throttle to this stage.
    setStageLevelThrottle(stage, desiredThrottle);
  }
}

// ─── STAGING LOGIC ────────────────────────────────────────────────────────────

/**
 * Check every stage for fuel exhaustion; if found, separate it and ignite the next.
 * This is "automatic staging" — the controller detects an empty tank and triggers it.
 *
 * Called once per physics tick before force calculations.
 *
 * @param config The rocket configuration.
 * @returns      true if any stage separated this tick, false otherwise.
 */
export function checkAndPerformStaging(config: MultiStageRocketConfig): boolean {
  let stagingOccurred = false;

  for (let i = 0; i < config.stages.length; i++) {
    const current = config.stages[i];

    // Condition: this stage is active, has no fuel left, and hasn't already separated.
    if (current.fuelMass <= 0 && !current.isSeparated && current.isActive) {
      // ── JETTISON THIS STAGE ──
      current.isSeparated = true;   // It falls away (no longer part of rocket)
      current.isActive = false;     // No longer in control
      current.isThrusting = false;  // Engine is dead
      current.thrustPercentage = 0; // Throttle zeroed out

      // ── IGNITE NEXT STAGE ──
      if (i + 1 < config.stages.length) {
        const next = config.stages[i + 1];
        next.isActive = true; // This stage takes over
        // Fire at 100% immediately — in real rockets next-stage ignition is full throttle.
        setStageLevelThrottle(next, 100);
      }

      stagingOccurred = true;
      // Only stage once per tick for simulation stability (avoid multi-stage cascade).
      break;
    }
  }

  return stagingOccurred;
}

// ─── FUEL CONSUMPTION ─────────────────────────────────────────────────────────

/**
 * Burn fuel from every stage currently thrusting, proportional to throttle and burn rate.
 * Called every physics tick AFTER force calculations so burned mass affects NEXT frame.
 *
 * FORMULA: fuelBurned = burnRate (kg/s) × (throttle / 100) × Δt (s)
 *   - At 100% throttle and burnRate=278 kg/s: 278 × 1.0 × 0.016 = 4.45 kg per frame.
 *   - At  50% throttle: 278 × 0.5 × 0.016 = 2.22 kg per frame.
 *
 * @param config    The rocket configuration.
 * @param deltaTime Seconds elapsed this physics tick.
 */
export function consumeFuel(
  config: MultiStageRocketConfig,
  deltaTime: number
): void {
  for (const stage of config.stages) {
    // Only burn fuel if this stage is actively thrusting.
    if (stage.isSeparated || !stage.isThrusting) continue;

    // Fuel burned this tick scales with throttle (partial throttle = partial burn rate).
    const burned = stage.burnRate * (stage.thrustPercentage / 100) * deltaTime;
    stage.fuelMass -= burned;

    // Clamp to zero — we can't have negative fuel.
    if (stage.fuelMass < 0) stage.fuelMass = 0;

    // If the tank just ran dry, kill the engine immediately.
    // (checkAndPerformStaging() will then separate it on the next tick.)
    if (stage.fuelMass <= 0) {
      stage.isThrusting = false;
      stage.thrustPercentage = 0;
    }
  }
}

// ─── RESET ────────────────────────────────────────────────────────────────────

/**
 * Restore all stages to their initial launch-ready configuration.
 * Refills fuel tanks, reattaches jettisoned stages, shuts off all engines.
 *
 * @param config The rocket config to reset.
 */
export function resetAllStages(config: MultiStageRocketConfig): void {
  for (const stage of config.stages) {
    stage.fuelMass = stage.fuelCapacity;  // Refill tank to maximum capacity
    stage.isSeparated = false;            // Reattach: no stages jettisoned
    stage.isActive = stage.stageNumber === 0; // Only first stage starts active
    stage.isThrusting = false;            // Engines off
    stage.thrustPercentage = 0;           // Throttle at zero
  }
}

// ─── PRE-CONFIGURED ROCKETS ───────────────────────────────────────────────────
//
// TWO-STAGE-TO-ORBIT (TWR) DESIGN NOTES:
//
// TWR = totalThrust / (totalMass × 9.81)
// Good range: 1.2–2.0 at liftoff.
//   < 1.0 = rocket can't lift off at all
//   1.0–1.2 = barely lifts off, very slow ascent
//   1.2–1.5 = realistic (most orbital launchers)
//   1.5–2.0 = sporty / responsive (sounding rockets)
//   > 3.0   = extreme (used to cause "fly off screen in 2 seconds")
//
// The previous configs had TWR up to 1.89 but with INSTANT throttle (120%/s ramp)
// which caused the rocket to reach max speed immediately.
// Now with 50%/s ramp rate, even TWR=1.9 feels gradual and controllable.

/**
 * SIMPLE TWO-STAGE — Small educational rocket.
 *
 * Based on a scaled-down orbital launcher concept.
 * Designed to be:
 *   - Easy to fly (moderate TWR, gentle acceleration)
 *   - Fast enough to reach the Kármán line (100 km) in ~3 minutes
 *   - Not so fast that it flies off screen before the camera catches up
 *
 * STATS:
 *   Launch mass: 400 + 2000 + 200 + 800 + 200 = 3600 kg
 *   First stage thrust: 50,000 N
 *   Launch TWR: 50000 / (3600 × 9.81) = 50000 / 35316 ≈ 1.42 ✓
 */
export const ROCKET_SIMPLE_TWO_STAGE: MultiStageRocketConfig = {
  name: "Simple Two-Stage",
  payloadMass: 200, // 200 kg small satellite

  stages: [
    createRocketStage({
      stageNumber: 0,
      name: "Booster",
      dryMass: 400,          // kg — lightweight structure for a small rocket
      fuelCapacity: 2000,    // kg — enough propellant for a 1–2 minute first-stage burn
      engineThrust: 50000,   // N — 50 kN, TWR at launch ≈ 1.42 (comfortable)
      specificImpulse: 250,  // s — moderate efficiency (solid/simple liquid propellant)
    }),

    createRocketStage({
      stageNumber: 1,
      name: "Upper Stage",
      dryMass: 200,          // kg — even lighter upper stage structure
      fuelCapacity: 800,     // kg — less fuel needed since it's already fast at separation
      engineThrust: 15000,   // N — 15 kN upper stage engine
      // Upper stage TWR at separation (only upper stage + payload):
      //   mass = 200 + 800 + 200 = 1200 kg
      //   TWR = 15000 / (1200 × 9.81) = 15000 / 11772 ≈ 1.27 ✓
      specificImpulse: 320,  // s — more efficient vacuum engine (upper stages are optimized for vacuum)
    }),
  ],
};

/**
 * FALCON 9 INSPIRED — Realistic heavy-lift orbital rocket.
 *
 * Based on real Falcon 9 FT specifications:
 *   - 9 Merlin 1D engines in first stage (sea-level)
 *   - 1 Merlin Vacuum engine in second stage
 *   - Designed for low Earth orbit delivery
 *
 * REAL FALCON 9 STATS (approximate):
 *   Total launch mass: ~549,054 kg
 *   First stage thrust: ~7,607 kN (9 × 845 kN)
 *   Launch TWR: 7,607,000 / (549,054 × 9.81) ≈ 1.41
 *
 * STATS USED HERE:
 *   Launch mass: 30000 + 419054 + 4000 + 86000 + 10000 = 549,054 kg
 *   First stage thrust: 7,607,000 N
 *   Launch TWR: 7607000 / (549054 × 9.81) ≈ 1.41 ✓
 */
export const ROCKET_FALCON_9_INSPIRED: MultiStageRocketConfig = {
  name: "Falcon 9 Inspired",
  payloadMass: 10000, // 10,000 kg payload (typical GTO mission)

  stages: [
    createRocketStage({
      stageNumber: 0,
      name: "First Stage",
      dryMass: 30000,          // kg — first stage dry mass (9 engines, landing legs, grid fins)
      fuelCapacity: 419054,    // kg — RP-1 + LOX propellant
      engineThrust: 7607000,   // N — 9 × 845 kN Merlin 1D sea-level thrust
      specificImpulse: 282,    // s — Merlin sea-level Isp
    }),

    createRocketStage({
      stageNumber: 1,
      name: "Second Stage",
      dryMass: 4000,           // kg — upper stage structure (1 engine, no landing hardware)
      fuelCapacity: 86000,     // kg — upper stage propellant
      engineThrust: 934000,    // N — 934 kN Merlin Vacuum (optimized nozzle for vacuum)
      // Upper stage TWR at separation:
      //   mass = 4000 + 86000 + 10000 = 100000 kg
      //   TWR = 934000 / (100000 × 9.81) ≈ 0.95 — upper stage doesn't need TWR > 1
      //   because it's already at high velocity and just needs to accelerate to orbit
      specificImpulse: 348,    // s — Merlin Vacuum Isp (excellent vacuum efficiency)
    }),
  ],
};

/**
 * THREE-STAGE HEAVY — Ambitious multi-stage launcher inspired by Saturn V / N1.
 *
 * Three stages allow:
 *   - Stage 1: Max thrust to get off the ground through thick atmosphere
 *   - Stage 2: Continue acceleration in thinner air (better efficiency)
 *   - Stage 3: Final orbital insertion burn in near-vacuum
 *
 * STATS:
 *   Launch mass: 8000 + 40000 + 2000 + 12000 + 500 + 3000 + 5000 = 70,500 kg
 *   First stage thrust: 1,000,000 N
 *   Launch TWR: 1,000,000 / (70500 × 9.81) ≈ 1.45 ✓
 */
export const ROCKET_THREE_STAGE: MultiStageRocketConfig = {
  name: "Three-Stage Heavy",
  payloadMass: 5000, // 5,000 kg heavy satellite / small space station module

  stages: [
    createRocketStage({
      stageNumber: 0,
      name: "First Stage",
      dryMass: 8000,         // kg — heavy structure for large engines and fuel tanks
      fuelCapacity: 40000,   // kg — substantial propellant for the initial climb
      engineThrust: 1000000, // N — 1 MN sea-level thrust
      specificImpulse: 260,  // s — lower Isp because sea-level engines are less efficient
    }),

    createRocketStage({
      stageNumber: 1,
      name: "Second Stage",
      dryMass: 2000,         // kg — lighter mid-stage
      fuelCapacity: 12000,   // kg — less propellant needed at altitude
      engineThrust: 250000,  // N — 250 kN, smaller engine optimized for thinning atmosphere
      // Second stage TWR at separation:
      //   mass = 2000 + 12000 + 500 + 3000 + 5000 = 22500 kg
      //   TWR = 250000 / (22500 × 9.81) ≈ 1.13 — barely > 1, still climbs
      specificImpulse: 310,  // s — better efficiency at altitude
    }),

    createRocketStage({
      stageNumber: 2,
      name: "Third Stage",
      dryMass: 500,          // kg — very light final stage
      fuelCapacity: 3000,    // kg — precise orbital insertion fuel
      engineThrust: 70000,   // N — 70 kN, small but efficient upper stage engine
      // Third stage TWR at separation:
      //   mass = 500 + 3000 + 5000 = 8500 kg
      //   TWR = 70000 / (8500 × 9.81) ≈ 0.84 — less than 1 but already near orbital speed
      specificImpulse: 350,  // s — high vacuum Isp for maximum efficiency
    }),
  ],
};
