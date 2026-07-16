/**
 * FUEL TANK SECTION BUILDER
 * =========================
 * Builds the stacked tank body of one stage: cylinder walls with propellant-
 * specific finishes (SOFI orange / gloss white / stainless), elliptical top
 * domes, weld-seam rings, dark intertank bands between stacked tanks, and a
 * full-length raceway conduit with cable clamps (seeded placement).
 */

import * as THREE from "three";
import { ellipticalDomeProfile, LATHE_SEGMENTS, mulberry32 } from "../geometry";
import { structuralMaterials, tankMaterialFor } from "../materials";
import type { StageVisualSpec } from "../types";

export function buildFuelTanks(stage: StageVisualSpec, seed: number): THREE.Group {
  const group = new THREE.Group();
  if (stage.tanks.length === 0) return group;

  const rand = mulberry32(seed ^ (stage.stageIndex * 0x9e3779b9));
  const racewayAngle = rand() * Math.PI * 2;

  let prevTopY: number | null = null;

  for (const placement of stage.tanks) {
    const tank = placement.part;
    const radius = tank.diameterM / 2;
    const material = tankMaterialFor(tank.propellantType, seed);

    // Top dome takes a slice of the tank's height; the wall fills the rest.
    const domeH = Math.min(radius * 0.5, placement.height * 0.25);
    const wallH = placement.height - domeH;

    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, wallH, LATHE_SEGMENTS),
      material,
    );
    wall.position.y = placement.bottomY + wallH / 2;
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);

    // Elliptical 2:1 top dome, squashed to the allotted dome height.
    const dome = new THREE.Mesh(
      new THREE.LatheGeometry(ellipticalDomeProfile(radius, 1), LATHE_SEGMENTS),
      material,
    );
    dome.scale.y = domeH / (radius / 2);
    dome.position.y = placement.bottomY + wallH;
    dome.castShadow = true;
    group.add(dome);

    // Circumferential weld seams every ~1/3 of the wall.
    const seamCount = Math.max(1, Math.round(wallH / (tank.lengthM / 3 + 0.001)));
    for (let s = 1; s <= seamCount; s++) {
      const seam = new THREE.Mesh(
        new THREE.TorusGeometry(radius + 0.01, Math.max(radius * 0.012, 0.015), 5, LATHE_SEGMENTS),
        structuralMaterials.darkMetal,
      );
      seam.rotation.x = Math.PI / 2;
      seam.position.y = placement.bottomY + (wallH * s) / (seamCount + 1);
      group.add(seam);
    }

    // Dark intertank band bridging the gap to the tank below.
    if (prevTopY !== null && placement.bottomY - prevTopY > 0.05) {
      const bandH = placement.bottomY - prevTopY;
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.985, radius * 0.985, bandH, LATHE_SEGMENTS),
        structuralMaterials.composite,
      );
      band.position.y = prevTopY + bandH / 2;
      group.add(band);
    }
    prevTopY = placement.bottomY + placement.height;
  }

  // Raceway conduit: full-length cable duct at a seeded angle, with clamps.
  const bodyR = stage.bodyRadius;
  const firstTank = stage.tanks[0];
  const lastTank = stage.tanks[stage.tanks.length - 1];
  const racewayBottom = firstTank.bottomY;
  const racewayTop = lastTank.bottomY + lastTank.height * 0.9;
  const racewayH = racewayTop - racewayBottom;

  if (racewayH > 1) {
    const rx = Math.cos(racewayAngle) * (bodyR + 0.05);
    const rz = Math.sin(racewayAngle) * (bodyR + 0.05);
    const duct = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(bodyR * 0.09, 0.08), racewayH, Math.max(bodyR * 0.07, 0.06)),
      structuralMaterials.raceway,
    );
    duct.position.set(rx, racewayBottom + racewayH / 2, rz);
    duct.rotation.y = -racewayAngle;
    group.add(duct);

    // Cable clamps every ~2 m.
    const clampCount = Math.min(Math.floor(racewayH / 2), 12);
    if (clampCount > 0) {
      const clampGeo = new THREE.BoxGeometry(
        Math.max(bodyR * 0.13, 0.12),
        0.12,
        Math.max(bodyR * 0.1, 0.09),
      );
      const clamps = new THREE.InstancedMesh(clampGeo, structuralMaterials.darkMetal, clampCount);
      const dummy = new THREE.Object3D();
      for (let i = 0; i < clampCount; i++) {
        dummy.position.set(rx, racewayBottom + ((i + 0.5) / clampCount) * racewayH, rz);
        dummy.rotation.y = -racewayAngle;
        dummy.updateMatrix();
        clamps.setMatrixAt(i, dummy.matrix);
      }
      group.add(clamps);
    }
  }

  return group;
}
