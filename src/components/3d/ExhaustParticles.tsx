/**
 * EXHAUST PLUME
 * =============
 * Three layers, all driven by the active stage's plume style (propellant-
 * specific: sooty orange kerolox, tight blue methalox, faint hydrolox):
 *
 *   1. A core flame cone under the nozzle — HDR additive color so Bloom
 *      gives it a glow halo; length tracks throttle + vacuum expansion.
 *   2. Mach diamonds — small bright octahedra inside the core, visible only
 *      in dense atmosphere (below ~15 km).
 *   3. 300 instanced flame billboards streaming down-plume, stretched along
 *      the flow, color-ramped core → flame → smoke.
 *
 * Emission originates at visualInfoRef.nozzle{X,Y} — the ACTIVE stage's bell,
 * so upper-stage burns emit from the right place after separation.
 * Reads mutable refs in useFrame; zero per-frame allocations.
 */

/* eslint-disable react-hooks/immutability --
   react-three-fiber render bridge: particle state created in useMemo is
   intentionally mutated inside useFrame every frame (no React re-renders). */

import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { MultiStageRocketState } from '../../physics/engine';
import type { MultiStageRocketConfig } from '../../physics/MultiStageSystem';
import type { RocketVisualInfo } from './rocket/types';
import { mulberry32 } from './rocket/geometry';

interface ExhaustParticlesProps {
  flightStateRef: React.MutableRefObject<MultiStageRocketState>;
  configRef: React.MutableRefObject<MultiStageRocketConfig>;
  visualInfoRef: React.MutableRefObject<RocketVisualInfo>;
}

const PARTICLE_COUNT = 300;
const MACH_DIAMOND_COUNT = 3;

// Module-scope temps — reused every frame to avoid GC churn in useFrame.
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();
const _down = new THREE.Vector3();
const _pos = new THREE.Vector3();

export const ExhaustParticles: React.FC<ExhaustParticlesProps> = ({
  flightStateRef,
  configRef,
  visualInfoRef,
}) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const diamondsRef = useRef<THREE.InstancedMesh>(null);
  const diamondMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const particles = useMemo(() => {
    const rand = mulberry32(0xf1a3e); // deterministic; render-pure
    return new Array(PARTICLE_COUNT).fill(0).map(() => ({
      life: rand(),
      speed: 30 + rand() * 20,
      offsetX: rand() - 0.5,
      offsetZ: rand() - 0.5,
    }));
  }, []);

  const colorArray = useMemo(() => new Float32Array(PARTICLE_COUNT * 3), []);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const flight = flightStateRef.current;
    const config = configRef.current;
    const info = visualInfoRef.current;
    const style = info.plumeStyle;

    const activeStage = config.stages.find((s) => s.isActive && !s.isSeparated);
    const throttle = activeStage ? activeStage.thrustPercentage / 100 : 0;
    const isThrusting = !!activeStage && throttle > 0 && activeStage.fuelMass > 0;

    // Exhaust origin: the ACTIVE stage's nozzle exit (world space).
    const nozzleX = info.nozzleX;
    const nozzleY = info.nozzleY;

    // Vacuum expansion: plumes widen as ambient pressure drops, capped at 4×
    // (uncapped it fills the whole screen with additive glow by ~100 km).
    const altitude = flight.position.y;
    const expansionFactor = (1 + Math.min(altitude / 15000, 3)) * style.widthScale;
    const plumeScale = Math.max(info.nozzleRadius * 1.6, 0.5);

    // Down-plume direction (rocket's -Y in world space).
    _down.set(-Math.sin(flight.angle), -Math.cos(flight.angle), 0);

    // ── Core flame cone + Mach diamonds ──
    const core = coreRef.current;
    const coreMat = coreMatRef.current;
    if (core && coreMat) {
      const coreLen = plumeScale * 4.2 * throttle * (0.6 + expansionFactor * 0.25);
      core.visible = isThrusting && coreLen > 0.05;
      if (core.visible) {
        // Cone apex is local +Y; rotate π−angle so the apex points down-plume,
        // and center the cone half a length below the nozzle.
        _pos.set(nozzleX, nozzleY, 0).addScaledVector(_down, coreLen / 2);
        core.position.copy(_pos);
        core.rotation.z = Math.PI - flight.angle;
        core.scale.set(plumeScale * (0.8 + expansionFactor * 0.15), coreLen, plumeScale * (0.8 + expansionFactor * 0.15));
        coreMat.color.setRGB(style.coreColor[0], style.coreColor[1], style.coreColor[2]);
        coreMat.opacity = 0.55 * style.opacity;
      }
    }
    const diamonds = diamondsRef.current;
    if (diamonds && diamondMatRef.current) {
      const showDiamonds = isThrusting && altitude < 15000 && throttle > 0.4;
      diamonds.visible = showDiamonds;
      if (showDiamonds) {
        for (let i = 0; i < MACH_DIAMOND_COUNT; i++) {
          const dist = plumeScale * (1.6 + i * 1.5) * throttle;
          _pos.set(nozzleX, nozzleY, 0).addScaledVector(_down, dist);
          _dummy.position.copy(_pos);
          _dummy.rotation.set(0, 0, -flight.angle);
          const s = plumeScale * 0.5 * (1 - i * 0.22);
          _dummy.scale.set(s * 0.6, s, s * 0.6);
          _dummy.updateMatrix();
          diamonds.setMatrixAt(i, _dummy.matrix);
        }
        diamonds.instanceMatrix.needsUpdate = true;
        diamondMatRef.current.color.setRGB(
          style.coreColor[0] * 1.2,
          style.coreColor[1] * 1.2,
          style.coreColor[2] * 1.2,
        );
      }
    }

    // ── Streaming flame particles ──
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = particles[i];

      if (isThrusting) {
        p.life += delta * 6;
        if (p.life > 1) p.life = 0; // respawn at the nozzle
      } else {
        p.life += delta * 3; // fade out remaining quickly
      }

      if (p.life > 1) {
        _dummy.position.set(0, -9999, 0);
        _dummy.scale.setScalar(0.0001);
      } else {
        const travel = p.life * p.speed * (0.5 + throttle * 0.5);
        _pos.set(nozzleX, nozzleY, 0).addScaledVector(_down, travel);
        const spread = (0.5 + p.life * 3) * expansionFactor * plumeScale * 0.7;
        _pos.x += p.offsetX * spread;
        _pos.z += p.offsetZ * spread;
        _dummy.position.copy(_pos);

        // Stretch along the plume direction so instances read as flame, not blobs.
        const s = (1 - p.life) * 1.6 * plumeScale * 0.9;
        _dummy.scale.set(s, s * 2.4, s);
        _dummy.rotation.set(0, 0, -flight.angle);

        // Color ramp: HDR core → flame → smoke (per-propellant).
        if (p.life < 0.15) {
          _color.setRGB(style.coreColor[0], style.coreColor[1], style.coreColor[2]);
        } else if (p.life < 0.55) {
          _color.setRGB(style.flameColor[0], style.flameColor[1], style.flameColor[2]);
        } else {
          const fade = 1 - (p.life - 0.55) / 0.45;
          _color.setRGB(
            style.smokeColor[0] * fade * (0.3 + style.smokeAmount * 0.7),
            style.smokeColor[1] * fade * (0.3 + style.smokeAmount * 0.7),
            style.smokeColor[2] * fade * (0.3 + style.smokeAmount * 0.7),
          );
        }
        _color.multiplyScalar(style.opacity);
        _color.toArray(colorArray, i * 3);
      }

      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;

    if (!mesh.geometry.hasAttribute('color')) {
      mesh.geometry.setAttribute('color', new THREE.InstancedBufferAttribute(colorArray, 3));
    } else {
      (mesh.geometry.attributes.color as THREE.InstancedBufferAttribute).copyArray(colorArray);
      mesh.geometry.attributes.color.needsUpdate = true;
    }
  });

  return (
    <>
      {/* Core flame cone (unit cone, tip down, scaled per frame). */}
      <mesh ref={coreRef} visible={false} frustumCulled={false}>
        <coneGeometry args={[0.5, 1, 16, 1, true]} />
        <meshBasicMaterial
          ref={coreMatRef}
          transparent
          opacity={0.85}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Mach diamonds. */}
      <instancedMesh
        ref={diamondsRef}
        args={[undefined, undefined, MACH_DIAMOND_COUNT]}
        visible={false}
        frustumCulled={false}
      >
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          ref={diamondMatRef}
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </instancedMesh>

      {/* Streaming flame billboards. */}
      <instancedMesh ref={meshRef} args={[undefined, undefined, PARTICLE_COUNT]} frustumCulled={false}>
        <sphereGeometry args={[0.5, 8, 8]} />
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={0.8}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </instancedMesh>
    </>
  );
};
