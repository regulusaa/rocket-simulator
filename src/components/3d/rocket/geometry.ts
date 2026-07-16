/**
 * PROCEDURAL GEOMETRY HELPERS
 * ===========================
 * Lathe profiles, fin outlines, a seeded PRNG, and canvas-generated detail
 * textures for the 3D rocket. Everything is procedural — no asset downloads.
 *
 * Profile convention: arrays of THREE.Vector2 where x = radius, y = height,
 * fed to LatheGeometry which revolves them around the Y axis.
 */

import * as THREE from "three";

/** Radial segment count for all lathe geometry (48 = smooth without being heavy). */
export const LATHE_SEGMENTS = 48;

/**
 * Mulberry32 — tiny deterministic PRNG. Seeded from the rocket spec's hash so
 * greeble jitter (rivets, panel offsets) is identical on every render of the
 * same rocket, but differs between rockets.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Engine bell profile (Rao parabolic approximation), bottom (y=0, nozzle exit)
 * to top (y=length, chamber dome):
 *
 *   exit ── parabolic bell ── throat ── cosine converging section ── chamber
 *
 * Proportions: bell 60% of length, converging section 15%, chamber 25%.
 * Throat radius = 0.25·exit, chamber radius = 0.38·exit.
 */
export function engineBellProfile(exitRadius: number, length: number): THREE.Vector2[] {
  const throatR = exitRadius * 0.25;
  const chamberR = exitRadius * 0.38;
  const bellLen = length * 0.6;
  const convLen = length * 0.15;
  const chamberLen = length * 0.25;

  const points: THREE.Vector2[] = [];

  // Parabolic bell: t=1 at the exit (y=0) down to t=0 at the throat (y=bellLen).
  const BELL_SAMPLES = 12;
  for (let j = 0; j <= BELL_SAMPLES; j++) {
    const t = 1 - j / BELL_SAMPLES;
    const r = throatR + (exitRadius - throatR) * Math.pow(t, 0.65);
    points.push(new THREE.Vector2(r, bellLen * (1 - t)));
  }

  // Converging section: cosine ease from throat radius up to chamber radius.
  const CONV_SAMPLES = 5;
  for (let j = 1; j <= CONV_SAMPLES; j++) {
    const t = j / CONV_SAMPLES;
    const ease = (1 - Math.cos(t * Math.PI)) / 2;
    points.push(new THREE.Vector2(throatR + (chamberR - throatR) * ease, bellLen + convLen * t));
  }

  // Combustion chamber cylinder + rounded top dome.
  points.push(new THREE.Vector2(chamberR, bellLen + convLen + chamberLen * 0.8));
  points.push(new THREE.Vector2(chamberR * 0.7, bellLen + convLen + chamberLen * 0.97));
  points.push(new THREE.Vector2(chamberR * 0.25, bellLen + convLen + chamberLen));

  return points;
}

/**
 * Tangent-ogive nose profile from base (y=0, radius R) to tip (y=L, radius→0).
 *   ρ = (R² + L²) / 2R,  r(y) = √(ρ² − (L − y)²) + R − ρ
 */
export function ogiveProfile(baseRadius: number, length: number, samples = 24): THREE.Vector2[] {
  const rho = (baseRadius * baseRadius + length * length) / (2 * baseRadius);
  const points: THREE.Vector2[] = [];
  for (let j = 0; j <= samples; j++) {
    const y = (j / samples) * length;
    const r = Math.sqrt(Math.max(rho * rho - (length - y) * (length - y), 0)) + baseRadius - rho;
    points.push(new THREE.Vector2(Math.max(r, 0.001), y));
  }
  return points;
}

/**
 * 2:1 elliptical tank end-dome profile from the equator (y=0, radius R) to the
 * pole. `up` controls dome direction: +1 domes upward, −1 downward.
 */
export function ellipticalDomeProfile(radius: number, up: 1 | -1, samples = 10): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  for (let j = 0; j <= samples; j++) {
    const theta = (j / samples) * (Math.PI / 2);
    points.push(
      new THREE.Vector2(
        Math.max(radius * Math.cos(theta), 0.001),
        up * (radius / 2) * Math.sin(theta),
      ),
    );
  }
  if (up === -1) points.reverse(); // keep profile ordered bottom→top for LatheGeometry
  return points;
}

/**
 * Swept trapezoidal fin outline in the XY plane (root along +Y, tip outboard +X).
 *   root chord along the body, tip chord = 45% of root, leading edge swept back.
 */
export function finShape(rootChord: number, span: number, sweepDeg = 35): THREE.Shape {
  const tipChord = rootChord * 0.45;
  const sweep = Math.tan((sweepDeg * Math.PI) / 180) * span;

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);                          // root leading edge
  shape.lineTo(span, -sweep);                  // tip leading edge (swept back/down)
  shape.lineTo(span, -sweep - tipChord);       // tip trailing edge
  shape.lineTo(0, -rootChord);                 // root trailing edge
  shape.closePath();
  return shape;
}

// ─── CANVAS DETAIL TEXTURES ───────────────────────────────────────────────────

const textureCache = new Map<string, THREE.CanvasTexture>();

/**
 * Procedural 512² "panel line" texture: faint grid seams + rivet dots + noise.
 * Used as roughnessMap/bumpMap on tank walls so big cylinders read as built-up
 * aerospace structures instead of smooth plastic. Cached per style key.
 */
export function getPanelTexture(styleKey: string, seed: number): THREE.CanvasTexture {
  const cacheKey = `${styleKey}-${seed & 0xff}`;
  const cached = textureCache.get(cacheKey);
  if (cached) return cached;

  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(seed);

  // Mid-grey base: neutral for roughness/bump maps (0.5 = "no change").
  ctx.fillStyle = "#8a8a8a";
  ctx.fillRect(0, 0, size, size);

  // Subtle large-scale noise blotches (weathering / spray coat variation).
  for (let i = 0; i < 60; i++) {
    const v = 120 + Math.floor(rand() * 30);
    ctx.fillStyle = `rgba(${v},${v},${v},0.25)`;
    const r = 20 + rand() * 60;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Vertical panel seams.
  const cols = 6;
  ctx.strokeStyle = "rgba(60,60,60,0.55)";
  ctx.lineWidth = 2;
  for (let c = 0; c <= cols; c++) {
    const x = (c / cols) * size + (rand() - 0.5) * 6;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }

  // Horizontal weld bands.
  const rows = 4;
  ctx.lineWidth = 3;
  for (let r = 0; r <= rows; r++) {
    const y = (r / rows) * size + (rand() - 0.5) * 6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  // Rivet dots along the seams.
  ctx.fillStyle = "rgba(50,50,50,0.7)";
  for (let c = 0; c <= cols; c++) {
    const x = (c / cols) * size;
    for (let y = 8; y < size; y += 22) {
      ctx.beginPath();
      ctx.arc(x + (rand() - 0.5) * 3, y + (rand() - 0.5) * 3, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 2);
  textureCache.set(cacheKey, texture);
  return texture;
}
