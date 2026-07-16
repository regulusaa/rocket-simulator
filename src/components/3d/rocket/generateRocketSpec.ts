/**
 * ROCKET VISUAL SPEC GENERATOR
 * ============================
 * Pure layout math: turns a MultiStageRocketConfig (+ resolved part manifest)
 * into a RocketVisualSpec that the 3D components render. No Three.js here —
 * just meters and positions, so it's trivially unit-testable.
 *
 * Layout rules (mirrors RocketAssemblyPreview's 2D stacking):
 *   - Each stage: engine bells at the bottom, tanks stacked above,
 *     interstage adapter (or auto transition cone) on top.
 *   - The top stage gets the nose cone instead of an adapter.
 *   - Upper-stage nozzles are recessed into the interstage below them,
 *     like Falcon 9's MVac living inside the interstage.
 *   - Stack space y=0 = stage 0's nozzle exit plane (physics position.y).
 */

import type { MultiStageRocketConfig } from "../../../physics/MultiStageSystem";
import {
  findPartById,
  type Engine,
  type FuelTank,
  type NoseCone,
  type Fin,
  type InterstageAdapter,
  type LandingLeg,
  type RCSThruster,
} from "../../../data/RocketPartsCatalog";
import { resolveStageParts } from "./presetManifests";
import type { PlumeStyle, RocketVisualSpec, StageVisualSpec, TankPlacement } from "./types";
import { DEFAULT_PLUME_STYLE } from "./types";

/** Vertical gap between stacked tanks (intertank ring section), meters. */
const INTERTANK_GAP = 0.3;

/** FNV-1a string hash → deterministic 32-bit seed for greeble placement. */
export function hashString(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Exhaust styling per propellant family. */
const PLUME_STYLES: Record<string, PlumeStyle> = {
  // Kerolox: bright orange flame, heavy soot trail (F-1 / Merlin look).
  "LOX/RP-1": DEFAULT_PLUME_STYLE,
  // Methalox: tight blue-white plume, almost no smoke (Raptor look).
  "LOX/CH4": {
    coreColor: [1.5, 1.9, 3.0],
    flameColor: [0.35, 0.55, 1.0],
    smokeColor: [0.5, 0.55, 0.65],
    smokeAmount: 0.2,
    widthScale: 0.8,
    opacity: 0.9,
  },
  // LNG burns nearly identically to methane.
  "LOX/LNG": {
    coreColor: [1.5, 1.8, 2.8],
    flameColor: [0.4, 0.55, 0.95],
    smokeColor: [0.5, 0.55, 0.65],
    smokeAmount: 0.25,
    widthScale: 0.8,
    opacity: 0.9,
  },
  // Hydrolox: faint near-transparent blue (RS-25's almost invisible plume).
  "LOX/LH2": {
    coreColor: [1.6, 1.8, 2.6],
    flameColor: [0.55, 0.65, 1.0],
    smokeColor: [0.7, 0.72, 0.78],
    smokeAmount: 0.05,
    widthScale: 0.65,
    opacity: 0.55,
  },
};

/**
 * Cluster layout: XZ offsets for `count` engines inside a body of `bodyRadius`,
 * plus the uniform visual scale applied to each bell so the cluster fits.
 *
 *   1 engine   → center
 *   2–4        → ring (no center)
 *   5–9        → 1 center + ring of count−1 (9 = classic octaweb)
 *
 * Bells are only ever scaled DOWN to fit — a tiny Rutherford under a fat tank
 * stays tiny (that's what Electron really looks like).
 */
export function computeEngineCluster(
  engine: Engine,
  count: number,
  bodyRadius: number,
): { positions: Array<[number, number]>; scale: number } {
  const exitR = engine.diameterM / 2;

  if (count <= 1) {
    return { positions: [[0, 0]], scale: Math.min(1, (bodyRadius * 0.9) / exitR) };
  }

  const hasCenter = count >= 5;
  const ringCount = hasCenter ? count - 1 : count;
  const ringRadius = bodyRadius * (hasCenter ? 0.62 : 0.55);

  // Fit constraints, all solved for the bell scale s:
  //   outer edge:      ringRadius + exitR·s ≤ bodyRadius · 1.02
  //   ring neighbors:  2·ringRadius·sin(π/ringCount) ≥ 2·exitR·s · 1.05
  //   center clearance: ringRadius ≥ 2·exitR·s (center bell + ring bell touching)
  let scale = Math.min(
    1,
    (bodyRadius * 1.02 - ringRadius) / exitR,
    (ringRadius * Math.sin(Math.PI / ringCount)) / (exitR * 1.05),
  );
  if (hasCenter) scale = Math.min(scale, ringRadius / (2 * exitR));
  scale = Math.max(scale, 0.15); // never fully degenerate

  const positions: Array<[number, number]> = [];
  if (hasCenter) positions.push([0, 0]);
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2;
    positions.push([Math.cos(a) * ringRadius, Math.sin(a) * ringRadius]);
  }
  return { positions, scale };
}

/**
 * Build the full visual layout for a rocket config.
 * Deterministic: identical configs (name + parts) produce identical specs.
 */
export function generateRocketSpec(config: MultiStageRocketConfig): RocketVisualSpec {
  const manifests = resolveStageParts(config);
  const lastIndex = config.stages.length - 1;

  // ── Pass 1: resolve parts and body radii (adapters need the NEXT stage's radius) ──
  const resolved = manifests.map((manifest) => {
    const engine = (manifest.engineIds[0] ? findPartById(manifest.engineIds[0]) : undefined) as
      | Engine
      | undefined;
    const tanks = manifest.tankIds
      .map((id) => findPartById(id))
      .filter((t): t is FuelTank => t !== undefined && t.category === "fuelTank");
    const bodyRadius =
      tanks.length > 0
        ? Math.max(...tanks.map((t) => t.diameterM)) / 2
        : Math.max(engine ? engine.diameterM * 0.75 : 1, 0.6);
    return { manifest, engine: engine ?? null, tanks, bodyRadius };
  });

  // ── Pass 2: stack the stages bottom-to-top ──
  const stages: StageVisualSpec[] = [];
  let cursor = 0; // stack-space y of the current stage's nozzle exit plane

  for (let i = 0; i < config.stages.length; i++) {
    const { manifest, engine, tanks, bodyRadius } = resolved[i];
    const isTop = i === lastIndex;
    const bottomY = cursor;

    // Engines occupy the bottom of the stage.
    const engineCount = Math.max(manifest.engineIds.length, engine ? 1 : 0);
    const cluster = engine
      ? computeEngineCluster(engine, engineCount, bodyRadius)
      : { positions: [] as Array<[number, number]>, scale: 1 };
    const engineLength = engine ? engine.lengthM * cluster.scale : 0;
    const engineTopY = bottomY + engineLength;

    // Tanks stack above the engines, separated by intertank rings.
    const tankPlacements: TankPlacement[] = [];
    let tankCursor = engineTopY;
    for (const tank of tanks) {
      tankPlacements.push({ part: tank, bottomY: tankCursor, height: tank.lengthM });
      tankCursor += tank.lengthM + INTERTANK_GAP;
    }
    if (tanks.length > 0) tankCursor -= INTERTANK_GAP; // no gap after the last tank
    const tanksTopY = Math.max(tankCursor, engineTopY + 1); // stage never shorter than 1 m

    // Top of stage: nose cone (top stage) or adapter/transition (lower stages).
    const noseCone = (manifest.noseConeId ? findPartById(manifest.noseConeId) : undefined) as
      | NoseCone
      | undefined;
    const adapter = (manifest.interstageAdapterId
      ? findPartById(manifest.interstageAdapterId)
      : undefined) as InterstageAdapter | undefined;

    let topY: number;
    let adapterHeight = 0;
    let adapterTopRadius = bodyRadius;
    let noseConeHeight = 0;

    if (isTop) {
      if (noseCone) {
        // Fairings keep their catalog length; plain ogives get a minimum
        // fineness ratio so a short cone on a fat body doesn't look bulbous.
        noseConeHeight = noseCone.id.includes("fairing")
          ? noseCone.lengthM
          : Math.max(noseCone.lengthM, bodyRadius * 2.6);
        topY = tanksTopY + noseConeHeight;
      } else {
        // No nose cone: cap with a stubby dome so the stack isn't open-topped.
        noseConeHeight = bodyRadius * 0.9;
        topY = tanksTopY + noseConeHeight;
      }
    } else {
      adapterTopRadius = resolved[i + 1].bodyRadius;
      // Adapter height: real interstages are roughly 1.2–1.5× the body radius;
      // widen for big diameter transitions so the cone isn't too steep.
      adapterHeight = adapter
        ? Math.max(bodyRadius * 1.3, Math.abs(adapterTopRadius - bodyRadius) * 2 + 0.5)
        : Math.abs(adapterTopRadius - bodyRadius) * 2 + 0.4; // auto transition cone
      topY = tanksTopY + adapterHeight;
    }

    stages.push({
      stageIndex: i,
      bottomY,
      topY,
      bodyRadius,
      engine,
      enginePositions: cluster.positions,
      engineScale: cluster.scale,
      engineTopY,
      tanks: tankPlacements,
      noseCone: noseCone ?? null,
      noseConeBottomY: tanksTopY,
      noseConeHeight,
      fins: (manifest.finId ? (findPartById(manifest.finId) as Fin) : null) ?? null,
      landingLegs:
        (manifest.landingLegId ? (findPartById(manifest.landingLegId) as LandingLeg) : null) ??
        null,
      rcs:
        (manifest.rcsThrusterIds[0]
          ? (findPartById(manifest.rcsThrusterIds[0]) as RCSThruster)
          : null) ?? null,
      adapter: adapter ?? null,
      adapterBottomY: tanksTopY,
      adapterHeight,
      adapterTopRadius,
      nozzleExitY: bottomY,
      plumeStyle:
        (engine && PLUME_STYLES[engine.propellant]) || DEFAULT_PLUME_STYLE,
    });

    // The next stage's nozzles sit recessed inside this stage's adapter
    // (like MVac inside Falcon 9's interstage) so no bells dangle in the open.
    const nextEngine = !isTop ? resolved[i + 1].engine : null;
    const recess = nextEngine
      ? Math.min(nextEngine.lengthM * 0.7, adapterHeight * 0.8)
      : 0;
    cursor = topY - recess;
  }

  const totalHeight = stages[stages.length - 1].topY;
  const maxDiameter = Math.max(...stages.map((s) => s.bodyRadius * 2));

  const seed = hashString(
    config.name +
      "|" +
      manifests
        .map((m) =>
          [
            m.engineIds.join(","),
            m.tankIds.join(","),
            m.rcsThrusterIds.join(","),
            m.finId ?? "",
            m.landingLegId ?? "",
            m.interstageAdapterId ?? "",
            m.noseConeId ?? "",
          ].join(";"),
        )
        .join("|"),
  );

  return { stages, totalHeight, maxDiameter, seed };
}
