/**
 * SHARED PBR MATERIALS
 * ====================
 * Module-level cached MeshStandardMaterials shared across every part mesh.
 * Sharing materials (instead of one per <meshStandardMaterial> JSX tag) keeps
 * the renderer's program/uniform switching cheap — the whole rocket plus the
 * launch complex should stay under ~150 draw calls.
 *
 * Propellant → tank finish mapping (real-world inspired):
 *   LOX/LH2  → SOFI spray-on foam orange (SLS / Shuttle ET)
 *   LOX/RP-1 → gloss white paint (Falcon 9 / Saturn V)
 *   LOX/CH4  → bare brushed stainless steel (Starship)
 *   LOX/LNG  → pale steel with a warm tint (New Glenn-ish)
 */

import * as THREE from "three";
import { getPanelTexture } from "./geometry";

const cache = new Map<string, THREE.MeshStandardMaterial>();

function material(key: string, create: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = cache.get(key);
  if (!m) {
    m = create();
    cache.set(key, m);
  }
  return m;
}

// ── Tank / body finishes ──────────────────────────────────────────────────────

export function tankMaterialFor(propellantType: string, seed: number): THREE.MeshStandardMaterial {
  switch (propellantType) {
    case "LOX/LH2":
      return material("sofi", () => {
        const m = new THREE.MeshStandardMaterial({
          color: "#c9622a",
          roughness: 0.92,
          metalness: 0.0,
        });
        m.roughnessMap = getPanelTexture("sofi", seed);
        m.bumpMap = m.roughnessMap;
        m.bumpScale = 0.6;
        return m;
      });
    case "LOX/CH4":
      return material("stainless", () => {
        const m = new THREE.MeshStandardMaterial({
          color: "#c8ccd2",
          roughness: 0.3,
          metalness: 0.95,
        });
        m.roughnessMap = getPanelTexture("stainless", seed);
        m.bumpMap = m.roughnessMap;
        m.bumpScale = 0.25;
        return m;
      });
    case "LOX/LNG":
      return material("lngSteel", () => {
        const m = new THREE.MeshStandardMaterial({
          color: "#d8d2c4",
          roughness: 0.45,
          metalness: 0.7,
        });
        m.roughnessMap = getPanelTexture("lng", seed);
        m.bumpMap = m.roughnessMap;
        m.bumpScale = 0.3;
        return m;
      });
    default: // LOX/RP-1 and anything unrecognized: classic gloss white
      return material("whitePaint", () => {
        const m = new THREE.MeshStandardMaterial({
          color: "#f2f3f5",
          roughness: 0.32,
          metalness: 0.15,
        });
        m.roughnessMap = getPanelTexture("white", seed);
        m.bumpMap = m.roughnessMap;
        m.bumpScale = 0.35;
        return m;
      });
  }
}

// ── Engine bell finishes (outer shell), keyed by propellant family ────────────

export function bellMaterialFor(propellantType: string): THREE.MeshStandardMaterial {
  switch (propellantType) {
    case "LOX/LH2":
      // Regeneratively-cooled channel wall: cool blue-grey (RS-25 look).
      return material("bellHydrolox", () =>
        new THREE.MeshStandardMaterial({ color: "#5a6673", roughness: 0.4, metalness: 0.9 }),
      );
    case "LOX/CH4":
    case "LOX/LNG":
      // Bare steel (Raptor / BE-4 look).
      return material("bellMethalox", () =>
        new THREE.MeshStandardMaterial({ color: "#7d8288", roughness: 0.35, metalness: 0.95 }),
      );
    default:
      // Kerolox: charred copper-brown from RP-1 soot (Merlin / F-1 look).
      return material("bellKerolox", () =>
        new THREE.MeshStandardMaterial({ color: "#4a3428", roughness: 0.45, metalness: 0.8 }),
      );
  }
}

/**
 * Inner bell surface: emissive so throttle makes it glow (and Bloom picks it
 * up). NOT cached/shared — each RocketAssembly instance mutates
 * emissiveIntensity per frame, so every assembly needs its own copy.
 */
export function createBellInnerMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: "#1a1a1a",
    roughness: 0.6,
    metalness: 0.4,
    emissive: new THREE.Color(3.0, 1.2, 0.3),
    emissiveIntensity: 0,
    side: THREE.BackSide,
  });
}

// ── Structural / detail materials ─────────────────────────────────────────────

export const structuralMaterials = {
  get composite() {
    return material("composite", () =>
      new THREE.MeshStandardMaterial({ color: "#23262b", roughness: 0.55, metalness: 0.3 }),
    );
  },
  get darkMetal() {
    return material("darkMetal", () =>
      new THREE.MeshStandardMaterial({ color: "#2e3238", roughness: 0.45, metalness: 0.85 }),
    );
  },
  get titanium() {
    return material("titanium", () =>
      new THREE.MeshStandardMaterial({ color: "#b8a888", roughness: 0.45, metalness: 1.0 }),
    );
  },
  get whiteComposite() {
    return material("whiteComposite", () =>
      new THREE.MeshStandardMaterial({ color: "#e8eaee", roughness: 0.4, metalness: 0.1 }),
    );
  },
  get raceway() {
    return material("raceway", () =>
      new THREE.MeshStandardMaterial({ color: "#3a3f46", roughness: 0.5, metalness: 0.6 }),
    );
  },
  get sepRing() {
    return material("sepRing", () => {
      const m = new THREE.MeshStandardMaterial({
        color: "#1c1e22",
        roughness: 0.4,
        metalness: 0.7,
      });
      // Faint warm emissive: reads as a pyro separation line under Bloom.
      m.emissive = new THREE.Color(0.6, 0.25, 0.05);
      m.emissiveIntensity = 0.35;
      return m;
    });
  },
  get legStrut() {
    return material("legStrut", () =>
      new THREE.MeshStandardMaterial({ color: "#15171a", roughness: 0.75, metalness: 0.3 }),
    );
  },
  get rcsBlock() {
    return material("rcsBlock", () =>
      new THREE.MeshStandardMaterial({ color: "#caccd0", roughness: 0.5, metalness: 0.4 }),
    );
  },
};
