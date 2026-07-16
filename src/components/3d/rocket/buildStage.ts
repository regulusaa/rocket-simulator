/**
 * STAGE GROUP FACTORY
 * ===================
 * Assembles all part builders into one THREE.Group per stage (children are
 * positioned in absolute stack-space coordinates), and provides disposal for
 * rebuilds. Geometry is disposed; materials are NOT (they're module-cached
 * and shared) except the per-assembly inner-bell emissive materials, which
 * the caller owns.
 */

import * as THREE from "three";
import type { StageVisualSpec } from "./types";
import { buildEngineCluster } from "./parts/engineCluster";
import { buildFuelTanks } from "./parts/fuelTanks";
import { buildNoseCone } from "./parts/noseCone";
import { buildFinSet } from "./parts/fins";
import { buildLandingLegs } from "./parts/landingLegs";
import { buildInterstage } from "./parts/interstage";
import { buildRcsBlocks } from "./parts/rcs";

export interface BuiltStage {
  group: THREE.Group;
  /** Emissive inner-bell material — drive emissiveIntensity from throttle. */
  innerBellMaterial: THREE.MeshStandardMaterial | null;
}

export function buildStageGroup(stage: StageVisualSpec, seed: number): BuiltStage {
  const group = new THREE.Group();
  const engines = buildEngineCluster(stage);
  group.add(
    engines.group,
    buildFuelTanks(stage, seed),
    buildNoseCone(stage),
    buildFinSet(stage),
    buildLandingLegs(stage),
    buildInterstage(stage),
    buildRcsBlocks(stage),
  );
  return { group, innerBellMaterial: engines.innerMaterial };
}

/** Dispose every geometry under a root (shared cached materials are kept). */
export function disposeStageGroup(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh || (obj as THREE.InstancedMesh).isInstancedMesh) {
      mesh.geometry?.dispose();
    }
  });
}
