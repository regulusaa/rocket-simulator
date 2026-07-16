/**
 * FIN SET BUILDER
 * ===============
 * Two families:
 *   - Planar fins (carbon fiber / aluminum): swept trapezoid outline extruded
 *     with a bevel so the cross-section reads as an airfoil, placed radially
 *     around the stage base.
 *   - Titanium grid fins ("ti-grid-fins"): rounded-frame lattice panels
 *     mounted near the top of the booster like Falcon 9's, deployed outward.
 */

import * as THREE from "three";
import { finShape } from "../geometry";
import { structuralMaterials } from "../materials";
import type { StageVisualSpec } from "../types";
import type { Fin } from "../../../../data/RocketPartsCatalog";

function finMaterial(fin: Fin): THREE.MeshStandardMaterial {
  if (fin.id === "ti-grid-fins") return structuralMaterials.titanium;
  if (fin.id === "aluminum-fins") return structuralMaterials.whiteComposite;
  return structuralMaterials.composite; // carbon fiber
}

export function buildFinSet(stage: StageVisualSpec): THREE.Group {
  const group = new THREE.Group();
  const fin = stage.fins;
  if (!fin) return group;

  const bodyR = stage.bodyRadius;
  const count = Math.max(fin.setOf, 3);
  const material = finMaterial(fin);

  if (fin.id === "ti-grid-fins") {
    // Grid fins: lattice panels near the stage top, sticking outward.
    const panelW = Math.min(bodyR * 0.9, 2.0);  // outboard span
    const panelH = panelW * 0.7;                 // along-body height
    const bar = panelW * 0.05;                   // lattice bar thickness

    const panel = new THREE.Group();
    // Frame: 2 vertical + 2 horizontal edge bars (in the XZ-outboard plane).
    const frameV = new THREE.BoxGeometry(bar, panelH, bar * 1.6);
    const frameH = new THREE.BoxGeometry(panelW, bar, bar * 1.6);
    for (const side of [0, 1]) {
      const v = new THREE.Mesh(frameV, material);
      v.position.set(side * panelW - panelW / 2, 0, 0);
      panel.add(v);
      const h = new THREE.Mesh(frameH, material);
      h.position.set(0, side * panelH - panelH / 2, 0);
      panel.add(h);
    }
    // Crossed diagonal lattice bars.
    const diagLen = Math.hypot(panelW, panelH) * 0.95;
    const diagGeo = new THREE.BoxGeometry(diagLen, bar * 0.6, bar);
    for (let d = -2; d <= 2; d++) {
      for (const angle of [Math.PI / 4, -Math.PI / 4]) {
        const bar1 = new THREE.Mesh(diagGeo, material);
        bar1.rotation.z = angle;
        bar1.position.set((d * panelW) / 5, (-d * panelH) / 5 * Math.sign(angle), 0);
        bar1.scale.x = 1 - Math.abs(d) * 0.28;
        panel.add(bar1);
      }
    }

    const mountY = stage.adapterBottomY + Math.min(stage.adapterHeight * 0.3, 1);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const wrapper = panel.clone();
      wrapper.position.set(
        Math.cos(a) * (bodyR + panelW / 2 + 0.05),
        mountY,
        Math.sin(a) * (bodyR + panelW / 2 + 0.05),
      );
      wrapper.rotation.y = -a;
      wrapper.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
      });
      group.add(wrapper);
    }
    return group;
  }

  // Planar fins at the stage base.
  const stageHeight = stage.topY - stage.bottomY;
  const rootChord = Math.min(Math.max(stageHeight * 0.18, 0.8), 8);
  const span = bodyR * 1.15;
  const thickness = Math.max(span * 0.05, 0.05);

  const geometry = new THREE.ExtrudeGeometry(finShape(rootChord, span), {
    depth: thickness * 0.3,
    bevelEnabled: true,
    bevelThickness: thickness * 0.35,
    bevelSize: Math.min(rootChord, span) * 0.05,
    bevelSegments: 2,
  });
  geometry.translate(0, 0, -thickness * 0.15); // center across the extrusion axis

  // Fins root just above the engine skirt, trailing edge near the stage bottom.
  const rootTopY = stage.engineTopY + rootChord * 0.9;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const mesh = new THREE.Mesh(geometry, material);
    const holder = new THREE.Group();
    mesh.position.set(bodyR * 0.96, rootTopY, 0);
    holder.add(mesh);
    holder.rotation.y = -a;
    mesh.castShadow = true;
    group.add(holder);
  }

  return group;
}
