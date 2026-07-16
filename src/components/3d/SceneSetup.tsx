/**
 * SCENE SETUP — lighting, sky, ground, launch complex
 * ===================================================
 * Full environment for the flight view:
 *   - Three-light rig (hemisphere ambient + shadow-casting key + cool fill)
 *   - Offline environment reflections: <Environment> built from local
 *     Lightformers (NO network fetch — drei's HDRI presets hit a CDN, so we
 *     deliberately avoid them)
 *   - Gradient sky dome (custom shader) that fades to space with altitude,
 *     revealing the stars; exponential ground haze that thins out to vacuum
 *   - Procedural canvas-textured ground + concrete apron with scorch marks
 *   - Launch complex: pad deck, flame trench + deflector, lattice service
 *     tower (single InstancedMesh), strongback, lightning masts, propellant
 *     sphere farm
 *   - Cloud deck at ~1.8 km that the rocket punches through, plus a couple
 *     of drei volumetric clouds near the pad for depth
 *
 * The sky dome and star field follow the camera every frame so they still
 * surround the view at 50+ km altitude (they used to be pinned at the origin,
 * which broke above a few hundred meters).
 */

/* eslint-disable react-hooks/immutability --
   react-three-fiber render bridge: the scene fog/background and sky-shader
   uniforms created in useMemo are intentionally mutated inside useFrame to
   track altitude (the standard r3f imperative pattern). */

import React, { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Stars, Cloud, Environment, Lightformer } from "@react-three/drei";
import type { MultiStageRocketState } from "../../physics/engine";
import { mulberry32 } from "./rocket/geometry";

interface SceneSetupProps {
  flightStateRef: React.MutableRefObject<MultiStageRocketState>;
}

// ── Sky dome shader: horizon→zenith gradient + sun glow, fading to space ─────

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSunDir;
  uniform float uSpaceBlend;
  void main() {
    float h = clamp(vDir.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));
    float sunDot = max(dot(vDir, uSunDir), 0.0);
    col += vec3(1.0, 0.92, 0.75) * pow(sunDot, 400.0) * 3.0; // sun disc
    col += vec3(1.0, 0.85, 0.6) * pow(sunDot, 6.0) * 0.18;   // wide glow
    // Fade the whole dome out as we leave the atmosphere so stars show through.
    gl_FragColor = vec4(col * (1.0 - uSpaceBlend), 1.0 - uSpaceBlend);
  }
`;

// ── Procedural ground textures ────────────────────────────────────────────────

function makeGrassTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(0x5eed);

  ctx.fillStyle = "#3b4a33";
  ctx.fillRect(0, 0, size, size);
  // Mottled grass/scrub blotches.
  for (let i = 0; i < 900; i++) {
    const g = 55 + Math.floor(rand() * 40);
    ctx.fillStyle = `rgba(${Math.floor(g * 0.75)},${g},${Math.floor(g * 0.55)},0.5)`;
    const r = 2 + rand() * 14;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(60, 60);
  return texture;
}

function makeApronTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(0xc0ffee);
  const c = size / 2;

  // Concrete base with expansion-joint grid.
  ctx.fillStyle = "#77776f";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(70,70,68,0.35)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    const p = (i / 8) * size;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  // Weathering blotches.
  for (let i = 0; i < 120; i++) {
    const g = 120 + Math.floor(rand() * 40);
    ctx.fillStyle = `rgba(${g},${g},${g - 4},0.3)`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 3 + rand() * 18, 0, Math.PI * 2);
    ctx.fill();
  }
  // Soft radial scorch streaks from the flame trench (along ±X).
  for (let i = 0; i < 50; i++) {
    const angle = (rand() < 0.5 ? 0 : Math.PI) + (rand() - 0.5) * 0.7;
    const len = 50 + rand() * 150;
    const grad = ctx.createLinearGradient(
      c, c,
      c + Math.cos(angle) * len, c + Math.sin(angle) * len,
    );
    grad.addColorStop(0, "rgba(30,27,24,0.28)");
    grad.addColorStop(1, "rgba(30,27,24,0)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 10 + rand() * 20;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(angle) * len, c + Math.sin(angle) * len);
    ctx.stroke();
  }
  // Central burn ring.
  const burn = ctx.createRadialGradient(c, c, 0, c, c, 90);
  burn.addColorStop(0, "rgba(18,16,14,0.85)");
  burn.addColorStop(1, "rgba(18,16,14,0)");
  ctx.fillStyle = burn;
  ctx.fillRect(0, 0, size, size);

  return new THREE.CanvasTexture(canvas);
}

function makeCloudDeckTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(0xc10d5);

  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 260; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 12 + rand() * 44;
    // Keep the center clearer so the pad view isn't smothered.
    const distFromCenter = Math.hypot(x - size / 2, y - size / 2) / (size / 2);
    const alpha = 0.16 * Math.min(distFromCenter * 1.6 + 0.15, 1);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

// ── Launch complex (static, built once) ───────────────────────────────────────

function buildLaunchComplex(): THREE.Group {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: "#b8bcc2", roughness: 0.55, metalness: 0.7 });
  const redSteel = new THREE.MeshStandardMaterial({ color: "#8c2f28", roughness: 0.6, metalness: 0.4 });
  const concrete = new THREE.MeshStandardMaterial({ color: "#8e8e8a", roughness: 0.95, metalness: 0 });
  const darkConcrete = new THREE.MeshStandardMaterial({ color: "#3a3a38", roughness: 0.95, metalness: 0 });

  // Pad deck the rocket sits on (top face at y = 0).
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(12, 13.5, 1.4, 8), concrete);
  deck.position.y = -0.7;
  deck.receiveShadow = true;
  group.add(deck);

  // Flame trench cutting under the deck along ±X, with a wedge deflector.
  const trench = new THREE.Mesh(new THREE.BoxGeometry(46, 2.4, 7), darkConcrete);
  trench.position.set(0, -1.55, 0);
  group.add(trench);
  const deflector = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 6.4, 3), darkConcrete);
  deflector.rotation.set(Math.PI / 2, 0, Math.PI / 2);
  deflector.position.set(0, -1.0, 0);
  group.add(deflector);

  // Lattice service tower: one InstancedMesh of unit boxes, scaled per member.
  const towerX = -15;
  const towerH = 46;
  const legSpan = 2.6;
  const members: Array<{ pos: [number, number, number]; scale: [number, number, number]; rotY?: number; rotZ?: number }> = [];
  // 4 legs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      members.push({
        pos: [towerX + (sx * legSpan) / 2, towerH / 2, (sz * legSpan) / 2],
        scale: [0.45, towerH, 0.45],
      });
    }
  }
  // Horizontal braces + X-diagonals every 4.6 m on the two visible faces.
  const diagLen = Math.hypot(legSpan, 4.6);
  for (let level = 1; level <= 9; level++) {
    const y = level * 4.6;
    for (const sz of [-1, 1]) {
      members.push({ pos: [towerX, y, (sz * legSpan) / 2], scale: [legSpan, 0.28, 0.28] });
      members.push({
        pos: [towerX, y - 2.3, (sz * legSpan) / 2],
        scale: [diagLen, 0.2, 0.2],
        rotZ: Math.atan2(4.6, legSpan) * (sz > 0 ? 1 : -1) * (level % 2 === 0 ? 1 : -1),
      });
    }
    for (const sx of [-1, 1]) {
      members.push({
        pos: [towerX + (sx * legSpan) / 2, y, 0],
        scale: [0.28, 0.28, legSpan],
      });
    }
  }
  // Work platforms.
  for (let level = 2; level <= 8; level += 2) {
    members.push({ pos: [towerX, level * 4.6 + 0.2, 0], scale: [legSpan + 1.2, 0.18, legSpan + 1.2] });
  }
  const towerMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    redSteel,
    members.length,
  );
  const dummy = new THREE.Object3D();
  members.forEach((m, i) => {
    dummy.position.set(...m.pos);
    dummy.rotation.set(0, m.rotY ?? 0, m.rotZ ?? 0);
    dummy.scale.set(...m.scale);
    dummy.updateMatrix();
    towerMesh.setMatrixAt(i, dummy.matrix);
  });
  towerMesh.castShadow = true;
  group.add(towerMesh);

  // Strongback arm reaching from the tower to the rocket body.
  const strongback = new THREE.Mesh(new THREE.BoxGeometry(13.5, 0.9, 1.6), steel);
  strongback.position.set(towerX + 6.9, towerH * 0.62, 0);
  strongback.rotation.z = -0.14;
  strongback.castShadow = true;
  group.add(strongback);

  // Lightning masts at the apron corners.
  const mastGeo = new THREE.CylinderGeometry(0.22, 0.4, 58, 8);
  const tipGeo = new THREE.ConeGeometry(0.3, 3, 8);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const mx = Math.cos(a) * 46;
    const mz = Math.sin(a) * 46;
    const mast = new THREE.Mesh(mastGeo, steel);
    mast.position.set(mx, 29, mz);
    mast.castShadow = true;
    group.add(mast);
    const tip = new THREE.Mesh(tipGeo, steel);
    tip.position.set(mx, 59.5, mz);
    group.add(tip);
  }

  // Propellant storage: white sphere + horizontal tank + pipe run.
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 16), steel);
  sphere.position.set(42, 6, -34);
  sphere.castShadow = true;
  group.add(sphere);
  const legGeo = new THREE.CylinderGeometry(0.3, 0.3, 4, 8);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const leg = new THREE.Mesh(legGeo, steel);
    leg.position.set(42 + Math.cos(a) * 4.2, 2, -34 + Math.sin(a) * 4.2);
    group.add(leg);
  }
  const horizTank = new THREE.Mesh(new THREE.CapsuleGeometry(2, 9, 8, 16), steel);
  horizTank.rotation.z = Math.PI / 2;
  horizTank.position.set(30, 2.4, -44);
  horizTank.castShadow = true;
  group.add(horizTank);
  // Short transfer pipe between the sphere and the horizontal tank.
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 15, 8), steel);
  pipe.position.set(36, 1.1, -39);
  pipe.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(-12, 0, -10).normalize(),
  );
  group.add(pipe);

  return group;
}

// ── Component ─────────────────────────────────────────────────────────────────

const SUN_DIRECTION = new THREE.Vector3(80, 120, 60).normalize();
const _bgColor = new THREE.Color();
const BG_GROUND = new THREE.Color("#87CEEB");
const BG_SPACE = new THREE.Color("#000000");

export const SceneSetup: React.FC<SceneSetupProps> = ({ flightStateRef }) => {
  const { scene, camera } = useThree();
  const skyFollowRef = useRef<THREE.Group>(null);
  const skyMatRef = useRef<THREE.ShaderMaterial>(null);

  const skyUniforms = useMemo(
    () => ({
      uHorizon: { value: new THREE.Color("#cfe4f5") },
      uZenith: { value: new THREE.Color("#3f7fd1") },
      uSunDir: { value: SUN_DIRECTION.clone() },
      uSpaceBlend: { value: 0 },
    }),
    [],
  );

  const grassTexture = useMemo(() => makeGrassTexture(), []);
  const apronTexture = useMemo(() => makeApronTexture(), []);
  const cloudDeckTexture = useMemo(() => makeCloudDeckTexture(), []);
  const launchComplex = useMemo(() => buildLaunchComplex(), []);
  const fog = useMemo(() => new THREE.FogExp2("#cfe4f5", 0.00008), []);

  useEffect(() => {
    scene.background = new THREE.Color("#87CEEB");
    scene.fog = fog;
    return () => {
      scene.fog = null;
    };
  }, [scene, fog]);

  useFrame(() => {
    const altitude = Math.max(flightStateRef.current.position.y, 0);
    const t = Math.min(altitude / 50000, 1);
    const smoothT = t * t * (3 - 2 * t);

    // Background fallback color behind the (fading) sky dome.
    _bgColor.copy(BG_GROUND).lerp(BG_SPACE, smoothT);
    if (scene.background instanceof THREE.Color) scene.background.copy(_bgColor);

    // Sky dome fades to transparent as we reach space, revealing the stars.
    // Written via the material ref: r3f may clone a `uniforms` prop object,
    // so mutating the original object would silently do nothing.
    const skyMat = skyMatRef.current;
    if (skyMat) skyMat.uniforms.uSpaceBlend.value = smoothT;

    // Ground haze thins with altitude; gone entirely in space.
    fog.density = 0.00008 * Math.pow(1 - smoothT, 2);

    // Keep the sky dome + stars centered on the camera at any altitude.
    skyFollowRef.current?.position.copy(camera.position);
  });

  return (
    <>
      {/* ── Light rig ── */}
      <hemisphereLight args={["#bcd8ff", "#3a4a35", 0.5]} />
      <ambientLight intensity={0.15} />
      <directionalLight
        position={[80, 120, 60]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={80}
        shadow-camera-bottom={-20}
        shadow-camera-far={400}
        shadow-bias={-0.0002}
      />
      <directionalLight position={[-60, 40, -80]} intensity={0.3} color="#a8c4e8" />

      {/* ── Offline environment reflections (no CDN fetch) ── */}
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={2.2} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[12, 12, 1]} color="#ffffff" />
        <Lightformer form="circle" intensity={5} position={[6, 8, 5]} scale={[3, 3, 1]} color="#fff4e0" target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={0.8} position={[0, -6, 0]} rotation-x={-Math.PI / 2} scale={[14, 14, 1]} color="#3d4a38" />
        <Lightformer form="rect" intensity={1.1} position={[-8, 2, -6]} scale={[8, 4, 1]} color="#bcd4ee" target={[0, 0, 0]} />
      </Environment>

      {/* ── Sky dome + stars, following the camera. Stars sit OUTSIDE the
             dome; the transparent-pass far→near sort draws them first, so the
             dome's alpha (1 at ground → 0 in space) hides them in daylight
             and reveals them as the atmosphere fades. ── */}
      <group ref={skyFollowRef}>
        <mesh>
          <sphereGeometry args={[8000, 32, 16]} />
          <shaderMaterial
            ref={skyMatRef}
            vertexShader={SKY_VERTEX}
            fragmentShader={SKY_FRAGMENT}
            uniforms={skyUniforms}
            side={THREE.BackSide}
            transparent
            depthWrite={false}
          />
        </mesh>
        <Stars radius={8600} depth={800} count={5000} factor={30} saturation={0} fade speed={0.5} />
      </group>

      {/* ── Ground + apron ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.12, 0]} receiveShadow>
        <planeGeometry args={[20000, 20000]} />
        <meshStandardMaterial map={grassTexture} color="#8ca080" roughness={1} metalness={0} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
        <circleGeometry args={[55, 48]} />
        <meshStandardMaterial map={apronTexture} roughness={0.95} metalness={0} />
      </mesh>

      {/* ── Launch complex ── */}
      <primitive object={launchComplex} />

      {/* ── Cloud deck the rocket punches through + near-pad volumetrics ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 1800, 0]} renderOrder={-1}>
        <circleGeometry args={[7000, 32]} />
        <meshBasicMaterial
          map={cloudDeckTexture}
          transparent
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <Cloud position={[-70, 90, -120]} speed={0.15} opacity={0.45} color="#ffffff" bounds={[30, 8, 30]} volume={14} />
      <Cloud position={[90, 130, -160]} speed={0.1} opacity={0.4} color="#ffffff" bounds={[40, 10, 40]} volume={18} />
    </>
  );
};
