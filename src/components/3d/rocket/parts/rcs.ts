/**
 * RCS THRUSTER BLOCK BUILDER
 * ==========================
 * Small quad-pod thruster blocks near the top of the stage body: a housing
 * box with four tiny cone nozzles (out / up / down), placed at 4 points
 * around the circumference like Dragon's Draco pods.
 */

import * as THREE from "three";
import { structuralMaterials } from "../materials";
import type { StageVisualSpec } from "../types";

export function buildRcsBlocks(stage: StageVisualSpec): THREE.Group {
  const group = new THREE.Group();
  if (!stage.rcs || stage.tanks.length === 0) return group;

  const bodyR = stage.bodyRadius;
  const size = Math.min(Math.max(bodyR * 0.22, 0.15), 0.5);
  const lastTank = stage.tanks[stage.tanks.length - 1];
  const mountY = lastTank.bottomY + lastTank.height * 0.82;

  const housingGeo = new THREE.BoxGeometry(size, size * 0.8, size * 1.3);
  const nozzleGeo = new THREE.ConeGeometry(size * 0.16, size * 0.4, 10);
  const material = structuralMaterials.rcsBlock;
  const nozzleMat = structuralMaterials.darkMetal;

  const pod = new THREE.Group();
  const housing = new THREE.Mesh(housingGeo, material);
  pod.add(housing);
  // Nozzles: outboard, up, down, and sideways.
  const nozzleSpecs: Array<{ pos: [number, number, number]; rot: [number, number, number] }> = [
    { pos: [size * 0.55, 0, 0], rot: [0, 0, -Math.PI / 2] },          // outboard
    { pos: [size * 0.25, size * 0.5, 0], rot: [0, 0, 0] },            // up
    { pos: [size * 0.25, -size * 0.5, 0], rot: [Math.PI, 0, 0] },     // down
    { pos: [size * 0.25, 0, size * 0.75], rot: [Math.PI / 2, 0, 0] }, // tangential
  ];
  for (const spec of nozzleSpecs) {
    const nozzle = new THREE.Mesh(nozzleGeo, nozzleMat);
    nozzle.position.set(...spec.pos);
    nozzle.rotation.set(...spec.rot);
    pod.add(nozzle);
  }

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const instance = pod.clone();
    instance.position.set(Math.cos(a) * (bodyR + size * 0.3), mountY, Math.sin(a) * (bodyR + size * 0.3));
    instance.rotation.y = -a;
    group.add(instance);
  }

  return group;
}
