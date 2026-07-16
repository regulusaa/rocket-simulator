/**
 * NOSE CONE / FAIRING BUILDER
 * ===========================
 * Top stage cap. Three variants:
 *   - Payload fairings ("medium-fairing" / "large-fairing"): flared base
 *     adapter, cylindrical barrel, ogive top, half-shell seam lines, and a
 *     separation ring at the base — the Falcon 9 / SLS silhouette.
 *   - Ogive nose ("small-ogive-nose" or anything else): pure tangent-ogive.
 *   - No nose cone equipped: a stubby dome so the stack isn't open-topped.
 */

import * as THREE from "three";
import { ellipticalDomeProfile, LATHE_SEGMENTS, ogiveProfile } from "../geometry";
import { structuralMaterials } from "../materials";
import type { StageVisualSpec } from "../types";

export function buildNoseCone(stage: StageVisualSpec): THREE.Group {
  const group = new THREE.Group();
  if (stage.noseConeHeight <= 0) return group;

  const bodyR = stage.bodyRadius;
  const baseY = stage.noseConeBottomY;
  const height = stage.noseConeHeight;
  const material = structuralMaterials.whiteComposite;

  // No nose cone part: stubby cap dome.
  if (!stage.noseCone) {
    const cap = new THREE.Mesh(
      new THREE.LatheGeometry(ellipticalDomeProfile(bodyR, 1), LATHE_SEGMENTS),
      material,
    );
    cap.scale.y = height / (bodyR / 2);
    cap.position.y = baseY;
    cap.castShadow = true;
    group.add(cap);
    return group;
  }

  const isFairing = stage.noseCone.id.includes("fairing");
  const coneR = Math.max(stage.noseCone.diameterM / 2, bodyR * 0.6);

  if (isFairing) {
    // Flared base adapter (fairings are often wider than the stage below).
    const flareH = Math.min(height * 0.12, 1.6);
    const barrelH = height * 0.55 - flareH;
    const ogiveH = height - flareH - barrelH;

    const flare = new THREE.Mesh(
      new THREE.CylinderGeometry(coneR, bodyR, flareH, LATHE_SEGMENTS),
      material,
    );
    flare.position.y = baseY + flareH / 2;
    flare.castShadow = true;
    group.add(flare);

    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(coneR, coneR, barrelH, LATHE_SEGMENTS),
      material,
    );
    barrel.position.y = baseY + flareH + barrelH / 2;
    barrel.castShadow = true;
    group.add(barrel);

    const ogive = new THREE.Mesh(
      new THREE.LatheGeometry(ogiveProfile(coneR, ogiveH), LATHE_SEGMENTS),
      material,
    );
    ogive.position.y = baseY + flareH + barrelH;
    ogive.castShadow = true;
    group.add(ogive);

    // Half-shell separation seams down the barrel (±X so they catch the light).
    const seamGeo = new THREE.BoxGeometry(0.04, barrelH + flareH, coneR * 0.06);
    for (const side of [1, -1]) {
      const seam = new THREE.Mesh(seamGeo, structuralMaterials.composite);
      seam.position.set(side * (coneR + 0.01), baseY + (barrelH + flareH) / 2, 0);
      group.add(seam);
    }

    // Separation ring at the fairing base.
    const sepRing = new THREE.Mesh(
      new THREE.TorusGeometry(bodyR + 0.02, Math.max(bodyR * 0.03, 0.04), 6, LATHE_SEGMENTS),
      structuralMaterials.sepRing,
    );
    sepRing.rotation.x = Math.PI / 2;
    sepRing.position.y = baseY + 0.05;
    group.add(sepRing);
  } else {
    // Plain tangent-ogive nose, blended to the body radius.
    const ogive = new THREE.Mesh(
      new THREE.LatheGeometry(ogiveProfile(bodyR, height), LATHE_SEGMENTS),
      material,
    );
    ogive.position.y = baseY;
    ogive.castShadow = true;
    group.add(ogive);

    // Base joint ring.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(bodyR + 0.01, Math.max(bodyR * 0.02, 0.025), 6, LATHE_SEGMENTS),
      structuralMaterials.darkMetal,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = baseY + 0.02;
    group.add(ring);
  }

  return group;
}
