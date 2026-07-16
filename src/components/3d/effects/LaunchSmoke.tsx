/**
 * LAUNCH PAD SMOKE
 * ================
 * The classic liftoff steam cloud: while the rocket is thrusting below ~60 m,
 * grey billows erupt at the pad and roll outward along the ground (deflected
 * by the flame trench). Normal blending (unlike the additive exhaust) so it
 * reads as opaque steam, not glow. One InstancedMesh, 200 instances.
 *
 * Same render-bridge pattern as everything else: reads refs inside useFrame,
 * never re-renders.
 */

/* eslint-disable react-hooks/immutability --
   react-three-fiber render bridge: particle state created in useMemo is
   intentionally mutated inside useFrame every frame (no React re-renders). */

import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { MultiStageRocketState } from "../../../physics/engine";
import type { MultiStageRocketConfig } from "../../../physics/MultiStageSystem";
import type { RocketVisualInfo } from "../rocket/types";
import { mulberry32 } from "../rocket/geometry";

interface LaunchSmokeProps {
  flightStateRef: React.MutableRefObject<MultiStageRocketState>;
  configRef: React.MutableRefObject<MultiStageRocketConfig>;
  visualInfoRef: React.MutableRefObject<RocketVisualInfo>;
}

const COUNT = 200;
const MAX_EMIT_ALTITUDE = 60;

interface SmokeParticle {
  life: number;      // 0–1, 1 = dead; starts ≥ 1 (dormant)
  lifeSpan: number;  // seconds to live
  dirX: number;      // horizontal drift direction (unit-ish)
  dirZ: number;
  speed: number;     // m/s outward
  size: number;      // base scale
  x: number;
  y: number;
  z: number;
}

const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

export const LaunchSmoke: React.FC<LaunchSmokeProps> = ({
  flightStateRef,
  configRef,
  visualInfoRef,
}) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const colorArray = useMemo(() => new Float32Array(COUNT * 3), []);

  const particles = useMemo<SmokeParticle[]>(() => {
    const rand = mulberry32(0x50f0e); // deterministic; render-pure
    return new Array(COUNT).fill(0).map(() => ({
      life: 1 + rand(), // dormant until first emit
      lifeSpan: 3 + rand() * 3,
      dirX: 0,
      dirZ: 0,
      speed: 0,
      size: 1,
      x: 0,
      y: -9999,
      z: 0,
    }));
  }, []);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const flight = flightStateRef.current;
    const config = configRef.current;
    const info = visualInfoRef.current;

    const activeStage = config.stages.find((s) => s.isActive && !s.isSeparated);
    const throttle = activeStage ? activeStage.thrustPercentage / 100 : 0;
    const emitting =
      flight.position.y < MAX_EMIT_ALTITUDE &&
      !!activeStage &&
      throttle > 0.05 &&
      activeStage.fuelMass > 0;

    for (let i = 0; i < COUNT; i++) {
      const p = particles[i];
      p.life += delta / p.lifeSpan;

      if (p.life >= 1) {
        if (emitting) {
          // Respawn at the pad under the nozzle. Bias drift along ±X (the
          // flame trench axis) so the cloud rolls out in two lobes.
          const angle = Math.random() * Math.PI * 2;
          const trenchBias = Math.random() < 0.65 ? (Math.random() < 0.5 ? 0 : Math.PI) : angle;
          p.life = 0;
          p.dirX = Math.cos(trenchBias) + (Math.random() - 0.5) * 0.6;
          p.dirZ = Math.sin(trenchBias) + (Math.random() - 0.5) * 0.6;
          p.speed = (8 + Math.random() * 14) * (0.5 + throttle * 0.5);
          p.size = (1.2 + Math.random() * 1.8) * Math.max(info.nozzleRadius, 0.4);
          p.x = info.nozzleX + (Math.random() - 0.5) * 2;
          p.y = 0.3 + Math.random() * 0.5;
          p.z = (Math.random() - 0.5) * 2;
        } else {
          _dummy.position.set(0, -9999, 0);
          _dummy.scale.setScalar(0.0001);
          _dummy.updateMatrix();
          mesh.setMatrixAt(i, _dummy.matrix);
          continue;
        }
      }

      // Outward roll, decelerating; gentle billow upward.
      const decay = 1 - p.life * 0.7;
      p.x += p.dirX * p.speed * decay * delta;
      p.z += p.dirZ * p.speed * decay * delta;
      p.y += (1.5 + p.life * 2.5) * delta;

      // Grow over life; sin curve avoids popping at birth and death.
      const scale = p.size * (0.5 + p.life * 3.5) * Math.sin(Math.min(p.life, 1) * Math.PI) ** 0.35;
      _dummy.position.set(p.x, p.y, p.z);
      _dummy.scale.setScalar(Math.max(scale, 0.0001));
      _dummy.rotation.y = p.life * 2 + i;
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);

      // White steam core aging into grey.
      const v = 0.95 - p.life * 0.45;
      _color.setRGB(v, v, v * 1.02);
      _color.toArray(colorArray, i * 3);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (!mesh.geometry.hasAttribute("color")) {
      mesh.geometry.setAttribute("color", new THREE.InstancedBufferAttribute(colorArray, 3));
    } else {
      (mesh.geometry.attributes.color as THREE.InstancedBufferAttribute).copyArray(colorArray);
      mesh.geometry.attributes.color.needsUpdate = true;
    }
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, COUNT]} frustumCulled={false}>
      <sphereGeometry args={[1, 7, 6]} />
      <meshBasicMaterial vertexColors transparent opacity={0.3} depthWrite={false} />
    </instancedMesh>
  );
};
