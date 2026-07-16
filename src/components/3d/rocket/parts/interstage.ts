/**
 * INTERSTAGE / TRANSITION BUILDER
 * ===============================
 * The section between a stage's tanks and the stage above: a (possibly
 * tapered) composite cylinder with vertical stringer ribs (one InstancedMesh)
 * and a faintly-glowing separation ring at the joint — the pyro line that
 * Bloom picks up.
 */

import * as THREE from "three";
import { LATHE_SEGMENTS } from "../geometry";
import { structuralMaterials } from "../materials";
import type { StageVisualSpec } from "../types";

export function buildInterstage(stage: StageVisualSpec): THREE.Group {
  const group = new THREE.Group();
  if (stage.adapterHeight <= 0) return group;

  const bottomR = stage.bodyRadius;
  const topR = stage.adapterTopRadius;
  const height = stage.adapterHeight;
  const baseY = stage.adapterBottomY;

  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(topR, bottomR, height, LATHE_SEGMENTS),
    structuralMaterials.composite,
  );
  shell.position.y = baseY + height / 2;
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  // Vertical stringer ribs — only on near-cylindrical adapters (a heavily
  // tapered cone with straight ribs looks wrong).
  if (Math.abs(topR - bottomR) < bottomR * 0.25) {
    const ribCount = 24;
    const midR = (topR + bottomR) / 2;
    const ribGeo = new THREE.BoxGeometry(
      Math.max(midR * 0.03, 0.03),
      height * 0.92,
      Math.max(midR * 0.045, 0.045),
    );
    const ribs = new THREE.InstancedMesh(ribGeo, structuralMaterials.darkMetal, ribCount);
    const dummy = new THREE.Object3D();
    const lean = Math.atan2(bottomR - topR, height); // follow the taper
    for (let i = 0; i < ribCount; i++) {
      const a = (i / ribCount) * Math.PI * 2;
      dummy.position.set(
        Math.cos(a) * (midR + 0.02),
        baseY + height / 2,
        Math.sin(a) * (midR + 0.02),
      );
      dummy.rotation.set(0, -a, 0);
      dummy.rotateX(lean);
      dummy.updateMatrix();
      ribs.setMatrixAt(i, dummy.matrix);
    }
    group.add(ribs);
  }

  // Separation ring at the bottom joint (slight emissive → pyro line).
  const sepRing = new THREE.Mesh(
    new THREE.TorusGeometry(bottomR + 0.01, Math.max(bottomR * 0.025, 0.03), 6, LATHE_SEGMENTS),
    structuralMaterials.sepRing,
  );
  sepRing.rotation.x = Math.PI / 2;
  sepRing.position.y = baseY + 0.04;
  group.add(sepRing);

  return group;
}
