/**
 * ENGINE CLUSTER BUILDER
 * ======================
 * Builds the engine section of one stage: Rao-curve lathe bells (outer shell +
 * emissive inner surface), greebles (gimbal ring, turbopump, feed line,
 * stiffener rings on big bells), plus the boat-tail skirt and heat-shield
 * plate that close the bottom of the tank stack.
 *
 * Clusters of 4+ engines use InstancedMesh (Falcon 9's 9 Merlins = 2 draw
 * calls). The inner-bell material is returned so RocketAssembly can drive its
 * emissiveIntensity from the live throttle (Bloom turns that into engine glow).
 */

import * as THREE from "three";
import { engineBellProfile, LATHE_SEGMENTS } from "../geometry";
import { bellMaterialFor, createBellInnerMaterial, structuralMaterials } from "../materials";
import type { StageVisualSpec } from "../types";

export function buildEngineCluster(stage: StageVisualSpec): {
  group: THREE.Group;
  innerMaterial: THREE.MeshStandardMaterial | null;
} {
  const group = new THREE.Group();
  if (!stage.engine || stage.enginePositions.length === 0) {
    return { group, innerMaterial: null };
  }

  const engine = stage.engine;
  const scale = stage.engineScale;
  const exitR = (engine.diameterM / 2) * scale;
  const length = engine.lengthM * scale;
  const baseY = stage.bottomY;
  const count = stage.enginePositions.length;

  const outerGeo = new THREE.LatheGeometry(engineBellProfile(exitR, length), LATHE_SEGMENTS);
  const innerGeo = new THREE.LatheGeometry(
    engineBellProfile(exitR * 0.96, length * 0.995),
    LATHE_SEGMENTS,
  );
  const outerMat = bellMaterialFor(engine.propellant);
  const innerMat = createBellInnerMaterial();

  if (count > 3) {
    // Big clusters: two instanced draws for the whole cluster.
    const outer = new THREE.InstancedMesh(outerGeo, outerMat, count);
    const inner = new THREE.InstancedMesh(innerGeo, innerMat, count);
    const dummy = new THREE.Object3D();
    stage.enginePositions.forEach(([x, z], i) => {
      dummy.position.set(x, baseY, z);
      dummy.updateMatrix();
      outer.setMatrixAt(i, dummy.matrix);
      inner.setMatrixAt(i, dummy.matrix);
    });
    outer.castShadow = true;
    group.add(outer, inner);
  } else {
    // 1–3 engines: individual meshes + per-engine greebles.
    const throatY = baseY + length * 0.62;
    const gimbalGeo = new THREE.TorusGeometry(exitR * 0.3, exitR * 0.07, 8, 24);
    const pumpGeo = new THREE.CylinderGeometry(exitR * 0.16, exitR * 0.16, length * 0.28, 12);
    const feedGeo = new THREE.CylinderGeometry(exitR * 0.05, exitR * 0.05, length * 0.5, 8);

    for (const [x, z] of stage.enginePositions) {
      const outer = new THREE.Mesh(outerGeo, outerMat);
      outer.position.set(x, baseY, z);
      outer.castShadow = true;
      const inner = new THREE.Mesh(innerGeo, innerMat);
      inner.position.set(x, baseY, z);
      group.add(outer, inner);

      // Gimbal ring at the throat.
      const gimbal = new THREE.Mesh(gimbalGeo, structuralMaterials.darkMetal);
      gimbal.rotation.x = Math.PI / 2;
      gimbal.position.set(x, throatY, z);
      group.add(gimbal);

      // Turbopump beside the chamber + propellant feed line running up.
      const pump = new THREE.Mesh(pumpGeo, structuralMaterials.darkMetal);
      pump.position.set(x + exitR * 0.42, baseY + length * 0.82, z);
      group.add(pump);
      const feed = new THREE.Mesh(feedGeo, structuralMaterials.raceway);
      feed.position.set(x - exitR * 0.3, baseY + length * 0.85, z);
      group.add(feed);

      // Stiffener rings on large bells (RS-25 / F-1 class).
      if (exitR > 0.8) {
        for (const frac of [0.15, 0.35]) {
          // Bell radius at height y: r = throat + (exit − throat)·t^0.65, t = 1 − y/bellLen
          const t = 1 - frac / 0.6;
          const r = exitR * 0.25 + exitR * 0.75 * Math.pow(t, 0.65);
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(r, exitR * 0.025, 6, 32),
            structuralMaterials.darkMetal,
          );
          ring.rotation.x = Math.PI / 2;
          ring.position.set(x, baseY + length * frac, z);
          group.add(ring);
        }
      }
    }
  }

  // Boat-tail skirt + heat-shield plate closing the stage base (only when the
  // stage has a tank body to close against).
  if (stage.tanks.length > 0) {
    const bodyR = stage.bodyRadius;
    const skirtBottomY = baseY + length * 0.5;
    const skirtH = stage.engineTopY - skirtBottomY;
    if (skirtH > 0.15) {
      const skirt = new THREE.Mesh(
        new THREE.CylinderGeometry(bodyR, bodyR * 0.97, skirtH, LATHE_SEGMENTS, 1, true),
        structuralMaterials.darkMetal,
      );
      skirt.position.y = skirtBottomY + skirtH / 2;
      skirt.castShadow = true;
      group.add(skirt);
    }
    const heatShield = new THREE.Mesh(
      new THREE.CylinderGeometry(bodyR * 0.985, bodyR * 0.985, 0.08, LATHE_SEGMENTS),
      structuralMaterials.darkMetal,
    );
    heatShield.position.y = skirtBottomY + 0.04;
    group.add(heatShield);
  }

  return { group, innerMaterial: innerMat };
}
