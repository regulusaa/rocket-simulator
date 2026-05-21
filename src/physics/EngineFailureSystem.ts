/**
 * ROCKET SIMULATOR - ENGINE FAILURE SYSTEM
 * ==========================================
 * Models realistic random engine failures that can occur during flight.
 * Based on real-world failure modes and historical failure rates.
 *
 * WHY ENGINES FAIL IN REAL ROCKETS:
 *   - Turbopump failures: the high-speed pumps that force propellant into the engine
 *     combustion chamber run at extreme RPM and temperatures. Bearing failures,
 *     cavitation, and fatigue cause ~60% of engine incidents.
 *   - Combustion instability (flameout): the flame in the combustion chamber can
 *     extinguish if the mixture ratio drifts. RD-170 (Soviet/Russian) was notorious
 *     for this in development. Modern engines use injector plates to prevent it.
 *   - Stuck throttle: hydraulic/pneumatic actuators that control propellant flow
 *     can jam. Throttle-lock at full or partial power changes the trajectory.
 *   - Premature stage separation: pyrotechnic charges (explosive bolts) are used
 *     to separate stages. A premature detonation wastes remaining fuel in that stage.
 *
 * REAL-WORLD MULTI-ENGINE RESILIENCE:
 *   SpaceX Falcon 9 has 9 Merlin engines (first stage). It's designed to complete
 *   the mission after losing ANY ONE engine. This has been demonstrated in real
 *   flights (CRS-1 in 2012, Starlink-15 in 2020). The remaining 8 engines burn
 *   slightly longer to compensate. This is called "engine-out capability."
 *
 * DIFFICULTY LEVELS:
 *   Safe:     No failures (for learning the controls)
 *   Normal:   30% of historical base rates (slightly challenging)
 *   Realistic: 100% of base rates (historically accurate)
 *   Chaos:    1000% of base rates (educational mayhem — learn what can go wrong)
 */

import type { MultiStageRocketConfig } from "./MultiStageSystem"; // Rocket configuration type

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * Difficulty setting controlling the probability of engine failures.
 * Affects ALL failure types proportionally.
 */
export type DifficultyLevel = "safe" | "normal" | "realistic" | "chaos";

/**
 * A single engine failure event — what happened, to which stage, and whether
 * the mission can continue.
 */
export interface EngineFailureEvent {
  /** Type of failure — determines how it's handled by the physics. */
  type: "flameout" | "pump-failure" | "stuck-throttle" | "premature-separation";

  /** Index of the affected stage (0 = first stage/booster, 1 = second, etc.). */
  stageIndex: number;

  /** Warning message shown to the player on the HUD. */
  message: string;

  /** Flight time when the failure occurred (seconds). */
  timestamp: number; // s

  /** True if this failure ends the mission (no remaining engines or stages). */
  isFatal: boolean;
}

/**
 * Current state of the engine failure tracking system.
 * Tracks which stages are stuck-throttle, recent failure events, and warnings.
 */
export interface EngineFailureState {
  /** Current difficulty level. Controls all failure probabilities. */
  difficulty: DifficultyLevel;

  /** History of failures this flight (capped at last 10 to prevent memory growth). */
  recentFailures: EngineFailureEvent[];

  /**
   * Set of stage indices with stuck throttle failures.
   * Once a stage is in this set, its throttle cannot change.
   * The RocketSimulator game loop enforces this by overriding throttle changes.
   */
  stuckThrottleStages: Set<number>;

  /**
   * Set of stage indices with pump failures (50% thrust cap).
   * Once a stage is in this set, its throttle is capped at 50%.
   */
  pumpFailedStages: Set<number>;

  /** Accumulated time the active stage has been thrusting (for probability calc). */
  totalBurnTime: number; // s
}

// ─── FAILURE PROBABILITY CONSTANTS ────────────────────────────────────────────
// These are BASE probabilities per second of burn time.
// Historical data: Merlin engine MTBF (mean time between failures) is ~100,000 s,
// so P(failure/second) ≈ 0.00001. We scale up significantly for gameplay interest.

/**
 * Base probability of engine flameout per second of burn time.
 * 0.5% per second = ~50% chance of one flameout in a 150-second first-stage burn
 * for a single engine. With 9 engines: P(at least one flameout) ≈ 1-(0.995)^(9×150) ≈ 1.
 * In "realistic" difficulty this is therefore tuned DOWN by the 1.0× multiplier —
 * for a SINGLE-engine stage, a 150s burn at 0.5%/s → ~53% cumulative chance.
 * That's dramatic but not unrealistic for early rocket development (1950s–1960s).
 */
const BASE_FLAMEOUT_PROB = 0.005; // probability/second — engine suddenly stops

/**
 * Base probability of fuel pump failure per second of burn time.
 * Same as flameout — turbopump failures are the most common engine incident.
 * Unlike flameout, the engine continues at reduced thrust (50% cap).
 */
const BASE_PUMP_FAILURE_PROB = 0.005; // probability/second — throttle limited to 50%

/**
 * Base probability of stuck throttle per second of burn time.
 * Lower than pump failure — throttle actuators are less complex than turbopumps.
 * Stuck at current position means if it happens at 80%, the player can't reduce
 * throttle to avoid overheat or G-limit violations.
 */
const BASE_STUCK_THROTTLE_PROB = 0.001; // probability/second — throttle locks in place

/**
 * Base probability of premature stage separation per second of burn time.
 * Very rare — explosive bolt systems are extremely reliable in modern rockets.
 * In "realistic" mode, a 150-second burn has ~1.5% chance of premature separation.
 */
const BASE_PREMATURE_SEP_PROB = 0.0001; // probability/second — stage separates early

/**
 * Multipliers applied to ALL base probabilities based on difficulty setting.
 * "safe": 0× = no failures at all (for learning the controls)
 * "normal": 0.3× = reduced probability for casual play
 * "realistic": 1.0× = historically-based probability
 * "chaos": 10× = extreme failures for educational "what-can-go-wrong" mode
 */
const DIFFICULTY_MULTIPLIERS: Record<DifficultyLevel, number> = {
  safe: 0, // No failures whatsoever — training mode
  normal: 0.3, // 30% of base rate — occasional challenge
  realistic: 1.0, // Full historical probability — true-to-life
  chaos: 10.0, // 10× base rate — educational chaos mode for maximum drama
};

// ─── FACTORY ──────────────────────────────────────────────────────────────────

/**
 * Create a fresh EngineFailureState for a new flight.
 *
 * @param difficulty  Starting difficulty level (defaults to "normal").
 * @returns           Initialized failure state with no active failures.
 */
export function createEngineFailureState(
  difficulty: DifficultyLevel = "normal"
): EngineFailureState {
  return {
    difficulty, // Difficulty level set at creation
    recentFailures: [], // No failures yet
    stuckThrottleStages: new Set(), // No stuck stages
    pumpFailedStages: new Set(), // No pump failures yet
    totalBurnTime: 0, // No burn time accumulated
  };
}

// ─── FAILURE UPDATE ────────────────────────────────────────────────────────────

/**
 * Process one physics frame of engine failure checks.
 * For each active, thrusting stage, rolls random dice against failure probabilities.
 * Applies the failure to the rocket configuration and records the event.
 *
 * HOW THE PROBABILITY WORKS:
 *   P(failure this frame) ≈ baseProbability × difficultyMultiplier × deltaTime
 *   For small deltaTime (1/60 s ≈ 0.0167 s), this is accurate enough.
 *   Example: at base 0.5%/s, realistic, 1/60 s frame:
 *     P = 0.005 × 1.0 × 0.0167 ≈ 0.000083 per frame ≈ 0.5% per second ✓
 *
 * @param failureState  Current failure state — MUTATED in place.
 * @param config        Rocket configuration — MUTATED to apply failures.
 * @param deltaTime     Physics time step in seconds.
 * @param timeElapsed   Total flight time in seconds.
 * @returns             Array of new failure events that occurred this frame.
 */
export function updateEngineFailures(
  failureState: EngineFailureState,
  config: MultiStageRocketConfig,
  deltaTime: number,
  timeElapsed: number
): EngineFailureEvent[] {
  // Array to collect new failures that happen this frame (returned to caller for sound/UI).
  const newFailures: EngineFailureEvent[] = [];

  // Look up the probability multiplier for the current difficulty.
  const mult = DIFFICULTY_MULTIPLIERS[failureState.difficulty]; // 0, 0.3, 1.0, or 10.0

  // In "safe" mode (mult=0), no failures can occur — skip all checks entirely.
  if (mult === 0) {
    return newFailures; // Empty array — no events
  }

  // ── PER-STAGE FAILURE CHECKS ────────────────────────────────────────────────
  // Iterate all stages and check only those that are actively burning.
  for (let i = 0; i < config.stages.length; i++) {
    const stage = config.stages[i]; // Current stage being checked

    // Only check stages that are: active (not jettisoned), not separated,
    // currently thrusting, and have remaining fuel to burn.
    if (
      !stage.isActive ||       // Skip inactive stages (not yet ignited)
      stage.isSeparated ||     // Skip separated stages (already jettisoned)
      !stage.isThrusting ||    // Skip stages not currently firing
      stage.fuelMass <= 0      // Skip stages that have run out of fuel
    ) {
      continue; // Next stage
    }

    // Accumulate total burn time across all active engine-seconds.
    failureState.totalBurnTime += deltaTime; // s — for statistics/telemetry

    // ── CHECK: ENGINE FLAMEOUT ──────────────────────────────────────────────
    // Flameout probability: baseProbability × difficulty × deltaTime.
    // Only fire this check if the stage hasn't already had a flameout this flight.
    // (A stage that already flamed out has isThrusting=false, so won't be checked again.)
    if (Math.random() < BASE_FLAMEOUT_PROB * mult * deltaTime) {
      // Count how many stages are CURRENTLY active/thrusting (including this one).
      const activeEngineCount = config.stages.filter(
        (s) => s.isActive && !s.isSeparated && s.fuelMass > 0 // Count viable engines
      ).length;

      // Immediately shut down this stage's engine.
      stage.isThrusting = false; // Engine stops producing thrust
      stage.thrustPercentage = 0; // Throttle drops to zero

      // Mission-fatal if this was the only engine left with fuel.
      // Multi-engine clusters (like Falcon 9's 9 Merlins) can survive one flameout.
      const isFatal = activeEngineCount <= 1; // Only fatal if no other engines remain

      const event: EngineFailureEvent = {
        type: "flameout", // Engine flame-out failure mode
        stageIndex: i, // Which stage failed
        message: isFatal
          ? `⚠ ENGINE ${i + 1} FLAMEOUT — THRUST LOST — NO REDUNDANCY` // Fatal: only engine
          : `⚠ ENGINE ${i + 1} FLAMEOUT — THRUST REDUCED (${activeEngineCount - 1} REMAINING)`, // Survivable: other engines
        timestamp: timeElapsed, // When it happened
        isFatal, // Whether the mission can continue
      };

      newFailures.push(event); // Report to caller for sound/banner
      failureState.recentFailures.push(event); // Add to history
    }

    // ── CHECK: FUEL PUMP FAILURE ────────────────────────────────────────────
    // Engine continues but at capped 50% thrust — simulates partial pump failure.
    // Only check if this stage doesn't already have a pump failure.
    if (
      !failureState.pumpFailedStages.has(i) && // Not already failed
      Math.random() < BASE_PUMP_FAILURE_PROB * mult * deltaTime // Probability check
    ) {
      // Mark this stage as having a pump failure — throttle will be capped.
      failureState.pumpFailedStages.add(i); // Permanently cap this stage at 50%

      // Immediately reduce throttle to 50% (engine is still running, just weakened).
      stage.thrustPercentage = Math.min(stage.thrustPercentage, 50); // Cap to 50%

      const event: EngineFailureEvent = {
        type: "pump-failure", // Turbopump partial failure
        stageIndex: i, // Which stage
        message: `⚠ STAGE ${i + 1} FUEL PUMP FAILURE — THRUST LIMITED TO 50%`, // Warning text
        timestamp: timeElapsed, // When
        isFatal: false, // Survivable — mission can continue at reduced performance
      };

      newFailures.push(event); // Report to caller
      failureState.recentFailures.push(event); // History
    }

    // ── CHECK: STUCK THROTTLE ────────────────────────────────────────────────
    // Throttle actuator locks at current position — player can't change it.
    // Only check if this stage doesn't already have a stuck throttle.
    if (
      !failureState.stuckThrottleStages.has(i) && // Not already stuck
      Math.random() < BASE_STUCK_THROTTLE_PROB * mult * deltaTime // Probability check
    ) {
      // Mark this stage as stuck at its current throttle position.
      failureState.stuckThrottleStages.add(i); // Lock throttle for this stage

      const stuckAt = stage.thrustPercentage.toFixed(0); // Record the stuck value

      const event: EngineFailureEvent = {
        type: "stuck-throttle", // Throttle actuator failure
        stageIndex: i, // Which stage
        message: `⚠ STAGE ${i + 1} STUCK THROTTLE AT ${stuckAt}% — THROTTLE LOCKED`, // Warning text
        timestamp: timeElapsed, // When
        isFatal: false, // Usually survivable (mission can often continue with fixed throttle)
      };

      newFailures.push(event); // Report to caller
      failureState.recentFailures.push(event); // History
    }
  }

  // ── CHECK: PREMATURE STAGE SEPARATION ──────────────────────────────────────
  // Affects the currently active stage (not all stages in the loop above,
  // because separation ends that stage and ignites the next one).
  const activeStageIdx = config.stages.findIndex(
    (s) => s.isActive && !s.isSeparated && s.fuelMass > 0 // Find the burning stage
  );

  if (
    activeStageIdx >= 0 && // There is an active stage
    Math.random() < BASE_PREMATURE_SEP_PROB * mult * deltaTime // Very rare event
  ) {
    const stage = config.stages[activeStageIdx]; // The stage that will separate early

    // Calculate how much fuel is being wasted by this premature separation.
    const remainingFuelPct = ((stage.fuelMass / stage.fuelCapacity) * 100).toFixed(0); // %

    // Perform the separation: mark as separated, deactivate, stop thrusting.
    stage.isSeparated = true; // Mark as jettisoned
    stage.isActive = false; // No longer in control
    stage.isThrusting = false; // Engine off

    // Activate the next stage if it exists (even though the current stage had fuel).
    const hasNextStage = activeStageIdx + 1 < config.stages.length; // Is there a next stage?
    if (hasNextStage) {
      config.stages[activeStageIdx + 1].isActive = true; // Ignite next stage prematurely
    }

    const event: EngineFailureEvent = {
      type: "premature-separation", // Explosive bolt failure
      stageIndex: activeStageIdx, // Which stage separated
      message: `⚠ PREMATURE STAGE ${activeStageIdx + 1} SEPARATION — ${remainingFuelPct}% FUEL WASTED`, // Warning text
      timestamp: timeElapsed, // When
      isFatal: !hasNextStage, // Fatal if no next stage exists (upper stage had no ignition)
    };

    newFailures.push(event); // Report to caller
    failureState.recentFailures.push(event); // History
  }

  // ── ENFORCE ONGOING PUMP FAILURE THROTTLE CAPS ──────────────────────────────
  // Stages with pump failures must not exceed 50% throttle.
  // The applyControls() function may have raised throttle above 50% via player input.
  // We override it here every frame to enforce the hardware limitation.
  for (const stageIdx of failureState.pumpFailedStages) {
    if (stageIdx < config.stages.length) {
      const s = config.stages[stageIdx]; // The pump-failed stage
      if (!s.isSeparated && s.isActive) {
        // Cap throttle at 50% — pump cannot deliver more fuel than half capacity.
        s.thrustPercentage = Math.min(s.thrustPercentage, 50); // %
      }
    }
  }

  // ── TRIM FAILURE HISTORY ─────────────────────────────────────────────────────
  // Keep only the last 10 failures to prevent unbounded memory growth.
  if (failureState.recentFailures.length > 10) {
    failureState.recentFailures = failureState.recentFailures.slice(-10); // Keep last 10
  }

  return newFailures; // Caller uses this to play sounds and show warning banners
}

// ─── QUERY HELPERS ────────────────────────────────────────────────────────────

/**
 * Check whether a specific stage has a stuck throttle.
 * Used by the game loop to prevent player input from changing stuck-throttle stages.
 *
 * @param failureState  Current failure state.
 * @param stageIndex    Index of the stage to check.
 * @returns             True if the stage's throttle is stuck.
 */
export function isThrottleStuck(
  failureState: EngineFailureState,
  stageIndex: number
): boolean {
  return failureState.stuckThrottleStages.has(stageIndex); // True if in the stuck set
}

// ─── RESET ────────────────────────────────────────────────────────────────────

/**
 * Reset the failure state for a new flight.
 * Clears all failure history, stuck throttles, and pump failures.
 * Preserves the difficulty setting (player chose it deliberately).
 *
 * @param failureState  The failure state to reset — MUTATED in place.
 */
export function resetEngineFailures(failureState: EngineFailureState): void {
  failureState.recentFailures = []; // Clear failure history
  failureState.stuckThrottleStages.clear(); // Unlock all throttles
  failureState.pumpFailedStages.clear(); // Clear pump failure flags
  failureState.totalBurnTime = 0; // Reset burn time counter
  // Note: difficulty is intentionally preserved — the player chose it and
  // would have to manually reset it if they wanted to change difficulty.
}
