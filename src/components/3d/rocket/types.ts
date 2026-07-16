/**
 * 3D ROCKET VISUAL TYPES
 * ======================
 * Shared types for the procedural 3D rocket generator.
 *
 * DATA FLOW:
 *   MultiStageRocketConfig (+ optional stageParts manifest)
 *     → resolveStageParts()   (presetManifests.ts — manifest / preset / inference)
 *     → generateRocketSpec()  (generateRocketSpec.ts — pure layout math)
 *     → RocketVisualSpec      (this file — consumed by RocketAssembly + parts/*)
 *
 * COORDINATE CONVENTION (matches the physics engine):
 *   Y-up, units = meters. y = 0 in "stack space" is the NOZZLE EXIT PLANE of
 *   stage 0, because the physics engine's position.y is the vehicle's bottom
 *   (the old RocketMesh added +6 for a 12 m rocket, and ExhaustParticles emits
 *   exactly at position.y). Every part's y positions are in stack space.
 */

import type {
  Engine,
  FuelTank,
  NoseCone,
  Fin,
  InterstageAdapter,
  LandingLeg,
  RCSThruster,
} from "../../../data/RocketPartsCatalog";

/** How the exhaust plume should look — derived from the active engine's propellant. */
export interface PlumeStyle {
  /** HDR core color (components may exceed 1.0 so Bloom picks them up). */
  coreColor: [number, number, number];
  /** Mid-flame color. */
  flameColor: [number, number, number];
  /** Trailing smoke color. */
  smokeColor: [number, number, number];
  /** 0–1: how much sooty smoke trails the flame (kerolox ≈ 1, hydrolox ≈ 0). */
  smokeAmount: number;
  /** Relative plume width multiplier (hydrolox plumes are thin and faint). */
  widthScale: number;
  /** Overall opacity multiplier (hydrolox burns nearly transparent). */
  opacity: number;
}

/** One tank's placement inside a stage. */
export interface TankPlacement {
  part: FuelTank;
  /** Stack-space y of the tank's bottom. */
  bottomY: number;
  /** Visual height of this tank section (m). */
  height: number;
}

/** Everything needed to render one stage of the rocket. */
export interface StageVisualSpec {
  stageIndex: number;
  /** Stack-space y where this stage begins (nozzle exits for stage 0). */
  bottomY: number;
  /** Stack-space y where this stage ends (top of nose cone for the last stage). */
  topY: number;
  /** Radius of the stage body (m) — max tank diameter / 2. */
  bodyRadius: number;

  /** Engine model + XZ cluster offsets (m). Empty positions = no engines. */
  engine: Engine | null;
  enginePositions: Array<[number, number]>;
  /** Visual scale applied to each engine bell so the cluster fits the body. */
  engineScale: number;
  /** Stack-space y of the top of the engine section (bottom of first tank). */
  engineTopY: number;

  tanks: TankPlacement[];

  noseCone: NoseCone | null;
  /** Stack-space y where the nose cone starts. */
  noseConeBottomY: number;
  /** Visual height of the nose cone (m). */
  noseConeHeight: number;

  fins: Fin | null;
  landingLegs: LandingLeg | null;
  rcs: RCSThruster | null;

  adapter: InterstageAdapter | null;
  /** Stack-space y where the adapter/transition section starts. */
  adapterBottomY: number;
  /** Height of the adapter/transition section (m). 0 = none. */
  adapterHeight: number;
  /** Body radius of the stage ABOVE (adapter transitions to it). */
  adapterTopRadius: number;

  /** Stack-space y of the nozzle exit plane for THIS stage's engines. */
  nozzleExitY: number;
  /** Exhaust look when this stage is the one burning. */
  plumeStyle: PlumeStyle;
}

/** The full computed layout for one rocket configuration. */
export interface RocketVisualSpec {
  stages: StageVisualSpec[]; // bottom-to-top, index-aligned with config.stages
  totalHeight: number;       // m — nozzle exit of stage 0 to tip of nose cone
  maxDiameter: number;       // m — widest body diameter in the stack
  /** Deterministic seed (FNV-1a of name + part IDs) for greeble placement. */
  seed: number;
}

/**
 * Per-frame info the assembly publishes for other scene components
 * (camera framing, exhaust origin, smoke) — written in RocketAssembly's
 * useFrame, read by CameraRig / ExhaustParticles / LaunchSmoke via ref.
 */
export interface RocketVisualInfo {
  /** Total height (m) of the REMAINING stack (separated stages excluded). */
  totalHeight: number;
  /** World-space y of the visual center of the remaining stack. */
  centerY: number;
  /** World-space position of the active stage's nozzle exit plane. */
  nozzleX: number;
  nozzleY: number;
  /** Plume styling for the currently active stage. */
  plumeStyle: PlumeStyle;
  /** Body radius (m) of the currently active stage. */
  bodyRadius: number;
  /** Exit radius (m) of one engine bell on the active stage (plume width). */
  nozzleRadius: number;
}

/** Neutral defaults used before the first frame writes real values. */
export const DEFAULT_PLUME_STYLE: PlumeStyle = {
  coreColor: [2.3, 1.5, 0.55],
  flameColor: [1.0, 0.45, 0.08],
  smokeColor: [0.25, 0.22, 0.2],
  smokeAmount: 0.8,
  widthScale: 1,
  opacity: 1,
};

export const DEFAULT_VISUAL_INFO: RocketVisualInfo = {
  totalHeight: 12,
  centerY: 6,
  nozzleX: 0,
  nozzleY: 0,
  plumeStyle: DEFAULT_PLUME_STYLE,
  bodyRadius: 1.5,
  nozzleRadius: 0.6,
};
