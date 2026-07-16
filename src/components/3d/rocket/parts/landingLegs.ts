/**
 * LANDING LEG SET BUILDER
 * =======================
 * Two looks:
 *   - Deployable legs (Falcon 9 / heavy): long tapered panels stowed flush
 *     against the booster skin — the iconic ascent configuration.
 *   - Fixed struts: splayed A-frame struts with foot pads reaching the
 *     nozzle-exit plane, so the rocket visibly stands on them at the pad.
 */

import * as THREE from "three";
import { structuralMaterials } from "../materials";
import type { StageVisualSpec } from "../types";

/** Cylinder strut between two points. */
function strut(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const dir = to.clone().sub(from);
  const length = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 10), material);
  mesh.position.copy(from).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

export function buildLandingLegs(stage: StageVisualSpec): THREE.Group {
  const group = new THREE.Group();
  const legs = stage.landingLegs;
  if (!legs) return group;

  const bodyR = stage.bodyRadius;
  const count = Math.max(legs.setOf, 3);
  const material = structuralMaterials.legStrut;
  const stageHeight = stage.topY - stage.bottomY;

  if (legs.deployable) {
    // Stowed: tapered panels hugging the skin from the base upward.
    const panelLen = Math.min(stageHeight * 0.4, 11);
    const panelW = Math.min(bodyR * 0.42, 1.4);
    const panelGeo = new THREE.BoxGeometry(panelW, panelLen, Math.max(bodyR * 0.07, 0.1));
    // Taper the top of the panel (legs narrow toward the hinge).
    panelGeo.translate(0, 0, 0);

    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.PI / count;
      const panel = new THREE.Mesh(panelGeo, material);
      panel.position.set(
        Math.cos(a) * (bodyR + 0.08),
        stage.engineTopY + panelLen / 2 + 0.2,
        Math.sin(a) * (bodyR + 0.08),
      );
      panel.rotation.y = -a + Math.PI / 2;
      panel.scale.set(1, 1, 1);
      panel.castShadow = true;
      group.add(panel);
    }
  } else {
    // Fixed struts: main strut + brace, foot pads at the nozzle-exit plane.
    const attachY = stage.engineTopY + Math.min(stageHeight * 0.12, 2);
    const footR = bodyR * 1.7;
    const footY = stage.bottomY + 0.06;
    const strutR = Math.max(bodyR * 0.045, 0.05);
    const padGeo = new THREE.CylinderGeometry(strutR * 4, strutR * 5, strutR * 1.6, 12);

    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.PI / count;
      const dirX = Math.cos(a);
      const dirZ = Math.sin(a);

      const top = new THREE.Vector3(dirX * bodyR * 0.95, attachY, dirZ * bodyR * 0.95);
      const foot = new THREE.Vector3(dirX * footR, footY, dirZ * footR);
      const braceTop = new THREE.Vector3(dirX * bodyR * 0.95, stage.bottomY + 0.6, dirZ * bodyR * 0.95);

      const main = strut(top, foot, strutR, material);
      main.castShadow = true;
      const brace = strut(braceTop, foot, strutR * 0.7, material);
      const pad = new THREE.Mesh(padGeo, material);
      pad.position.copy(foot);
      group.add(main, brace, pad);
    }
  }

  return group;
}
