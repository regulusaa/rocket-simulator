/**
 * PRESET PART MANIFESTS + INFERENCE
 * =================================
 * The 3D flight view needs to know WHICH catalog parts a rocket is built from.
 * Custom builds carry a `stageParts` manifest on their config (set by
 * RocketBuilder.convertToConfig). The three built-in presets and any legacy
 * localStorage configs don't — this module fills the gap:
 *
 *   resolveStageParts(config)
 *     1. config.stageParts        — the real manifest (custom builds)
 *     2. PRESET_STAGE_PARTS[name] — hand-tuned manifests for the presets
 *     3. inferStageParts(config)  — deterministic guess from physics numbers
 *
 * Everything here is pure and deterministic: the same config always resolves
 * to the same part list, so a rocket never changes its look between flights.
 */

import type { MultiStageRocketConfig, StagePartIds } from "../../../physics/MultiStageSystem";
import { ENGINES, FUEL_TANKS, type Engine, type FuelTank } from "../../../data/RocketPartsCatalog";

/** Hand-tuned part manifests for the built-in preset rockets (keyed by config.name). */
export const PRESET_STAGE_PARTS: Record<string, StagePartIds[]> = {
  // Small educational two-stage: Electron-like, twin Rutherfords under a 2 m body.
  "Simple Two-Stage": [
    {
      engineIds: ["rutherford", "rutherford"],
      tankIds: ["small-lox-rp1-tank"],
      rcsThrusterIds: [],
      finId: "cf-fins",
      landingLegId: null,
      interstageAdapterId: "small-interstage",
      noseConeId: null,
    },
    {
      engineIds: ["rutherford"],
      tankIds: ["small-lox-rp1-tank"],
      rcsThrusterIds: ["cold-gas-n2"],
      finId: null,
      landingLegId: null,
      interstageAdapterId: null,
      noseConeId: "small-ogive-nose",
    },
  ],

  // Falcon 9: 9-Merlin octaweb, grid fins, landing legs, 5.2 m fairing over a 3.7 m body.
  "Falcon 9 Inspired": [
    {
      engineIds: Array(9).fill("merlin-1d"),
      tankIds: ["medium-lox-rp1-tank", "medium-lox-rp1-tank"],
      rcsThrusterIds: [],
      finId: "ti-grid-fins",
      landingLegId: "falcon9-legs",
      interstageAdapterId: "medium-interstage",
      noseConeId: null,
    },
    {
      engineIds: ["merlin-1d"],
      tankIds: ["medium-lox-rp1-tank"],
      rcsThrusterIds: ["draco"],
      finId: null,
      landingLegId: null,
      interstageAdapterId: null,
      noseConeId: "medium-fairing",
    },
  ],

  // Three-stage heavy: chunky RD-180 booster tapering to a small third stage.
  "Three-Stage Heavy": [
    {
      engineIds: ["rd-180"],
      tankIds: ["medium-lox-rp1-tank"],
      rcsThrusterIds: [],
      finId: "aluminum-fins",
      landingLegId: null,
      interstageAdapterId: "medium-interstage",
      noseConeId: null,
    },
    {
      engineIds: ["merlin-1d"],
      tankIds: ["small-lox-rp1-tank"],
      rcsThrusterIds: [],
      finId: null,
      landingLegId: null,
      interstageAdapterId: "small-interstage",
      noseConeId: null,
    },
    {
      engineIds: ["rutherford"],
      tankIds: ["small-lox-rp1-tank"],
      rcsThrusterIds: ["r-4d"],
      finId: null,
      landingLegId: null,
      interstageAdapterId: null,
      noseConeId: "small-ogive-nose",
    },
  ],
};

/** Tank catalog IDs per propellant family, largest first (for greedy capacity fill). */
const TANKS_BY_PROPELLANT: Record<string, string[]> = {
  "LOX/RP-1": ["medium-lox-rp1-tank", "small-lox-rp1-tank"],
  "LOX/CH4": ["medium-lox-ch4-tank", "small-lox-ch4-tank"],
  "LOX/LNG": ["small-lox-lng-tank"],
  "LOX/LH2": ["large-lox-lh2-tank"],
};

/**
 * Pick the catalog engine + cluster count that best matches a stage's
 * aggregate thrust and Isp. Error metric: log-thrust distance of the whole
 * cluster plus a scaled Isp distance, so a 9× small-engine cluster can beat
 * a single mismatched big engine.
 */
function inferEngine(stageThrust: number, stageIsp: number): { engine: Engine; count: number } {
  let best: { engine: Engine; count: number; error: number } | null = null;

  for (const engine of ENGINES) {
    const count = Math.max(1, Math.min(9, Math.round(stageThrust / engine.thrustSeaLevel)));
    const clusterThrust = engine.thrustSeaLevel * count;
    const error =
      Math.abs(Math.log(Math.max(stageThrust, 1)) - Math.log(clusterThrust)) +
      Math.abs(stageIsp - engine.specificImpulseSeaLevel) / 100;
    if (!best || error < best.error) best = { engine, count, error };
  }

  return { engine: best!.engine, count: best!.count };
}

/** Greedily pick tanks of the engine's propellant family to cover the stage's fuel load. */
function inferTanks(propellant: string, fuelCapacity: number): FuelTank[] {
  const ids = TANKS_BY_PROPELLANT[propellant] ?? TANKS_BY_PROPELLANT["LOX/RP-1"];
  const options = ids
    .map((id) => FUEL_TANKS.find((t) => t.id === id))
    .filter((t): t is FuelTank => t !== undefined);

  const picked: FuelTank[] = [];
  let remaining = fuelCapacity;
  // Max 3 tank sections per stage — beyond that the stack gets absurdly tall.
  while (remaining > 0 && picked.length < 3) {
    // Smallest tank that covers the remainder, else the largest available.
    const fit = [...options].reverse().find((t) => t.capacityKg >= remaining) ?? options[0];
    picked.push(fit);
    remaining -= fit.capacityKg;
  }
  if (picked.length === 0) picked.push(options[options.length - 1]);
  return picked;
}

/**
 * Deterministically guess a part manifest for a config that has none
 * (legacy localStorage builds, hand-written configs). Never random.
 */
export function inferStageParts(config: MultiStageRocketConfig): StagePartIds[] {
  const lastIndex = config.stages.length - 1;

  return config.stages.map((stage, i) => {
    const { engine, count } = inferEngine(stage.engineThrust, stage.specificImpulse);
    const tanks = inferTanks(engine.propellant, stage.fuelCapacity);
    const bodyDiameter = Math.max(...tanks.map((t) => t.diameterM));
    const isBottom = i === 0;
    const isTop = i === lastIndex;

    // Landing-capable engines (restartable + throttleable) get legs on the booster.
    const canLand = isBottom && engine.restartable && engine.throttleable;

    return {
      engineIds: Array(count).fill(engine.id),
      tankIds: tanks.map((t) => t.id),
      rcsThrusterIds: isTop && !isBottom ? ["draco"] : [],
      finId: isBottom ? (canLand ? "ti-grid-fins" : "aluminum-fins") : null,
      landingLegId: canLand ? "falcon9-legs" : null,
      interstageAdapterId: isTop
        ? null
        : bodyDiameter <= 2.5
          ? "small-interstage"
          : bodyDiameter <= 4.5
            ? "medium-interstage"
            : "large-interstage",
      noseConeId: isTop
        ? bodyDiameter <= 2.5
          ? "small-ogive-nose"
          : bodyDiameter <= 6
            ? "medium-fairing"
            : "large-fairing"
        : null,
    };
  });
}

/**
 * Resolve the part manifest for any config: real manifest → preset table → inference.
 * Guards against a stale manifest whose stage count no longer matches the config.
 */
export function resolveStageParts(config: MultiStageRocketConfig): StagePartIds[] {
  if (config.stageParts && config.stageParts.length === config.stages.length) {
    return config.stageParts;
  }
  const preset = PRESET_STAGE_PARTS[config.name];
  if (preset && preset.length === config.stages.length) {
    return preset;
  }
  return inferStageParts(config);
}
