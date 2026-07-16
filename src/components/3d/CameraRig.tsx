/* eslint-disable react-hooks/immutability --
   react-three-fiber render bridge: the previous-target tracker is
   intentionally mutated inside useFrame (the standard r3f imperative pattern). */

import React, { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { MultiStageRocketState } from '../../physics/engine';
import type { RocketVisualInfo } from './rocket/types';
import { useTelemetryStore } from '../../store/telemetryStore';

interface CameraRigProps {
  flightStateRef: React.MutableRefObject<MultiStageRocketState>;
  /** Written by RocketAssembly each frame: real stack height + center. */
  visualInfoRef: React.MutableRefObject<RocketVisualInfo>;
}

// Module-scope temp — reused every frame so useFrame never allocates.
const _desiredPos = new THREE.Vector3();

export const CameraRig: React.FC<CameraRigProps> = ({ flightStateRef, visualInfoRef }) => {
  const { camera } = useThree();
  const cameraZoom = useTelemetryStore((s) => s.mission.cameraZoom);
  // Last frame's target, for velocity feed-forward (x set to NaN = uninitialized).
  const prevTargetRef = useRef({ x: NaN, y: 0 });

  useFrame(() => {
    const flight = flightStateRef.current;
    const info = visualInfoRef.current;

    // Target the visual center of the remaining stack, derived from the
    // CURRENT physics position. (info.centerY is written by RocketAssembly
    // AFTER this runs — using it directly would lag the rendered rocket by
    // one frame, kilometers at high time-warp.)
    const targetX = flight.position.x;
    const targetY = Math.max(flight.position.y + info.totalHeight / 2, 2);

    // Velocity feed-forward: move with the rocket first, then lerp toward the
    // desired offset. Pure lerp alone lags by (speed / lerp-rate) — kilometers
    // at orbital velocity, leaving the rocket a speck in the distance.
    const prev = prevTargetRef.current;
    if (!Number.isNaN(prev.x)) {
      camera.position.x += targetX - prev.x;
      camera.position.y += targetY - prev.y;
    }
    prev.x = targetX;
    prev.y = targetY;

    // Base distance scales with the rocket so tall stacks fit in frame.
    const speed = Math.sqrt(flight.velocity.x ** 2 + flight.velocity.y ** 2);
    const zoomOut = Math.min(speed * 0.15, 60); // pull back with speed
    const baseZ = Math.max(30, info.totalHeight * 2.2) * cameraZoom;
    const targetZ = baseZ + zoomOut * cameraZoom;

    // Max-Q Camera Shake (aerodynamic stress ~5k–25k m, peaking at 12k m)
    let shakeX = 0;
    let shakeY = 0;
    const altitude = flight.position.y;
    if (altitude > 5000 && altitude < 25000 && flight.isFlying) {
      const shakeIntensity = Math.max(0, 1 - Math.abs(altitude - 12000) / 7000);
      shakeX = (Math.random() - 0.5) * shakeIntensity * 1.5;
      shakeY = (Math.random() - 0.5) * shakeIntensity * 1.5;
    }

    // Smoothly interpolate camera position, slightly above center for a
    // gentle hero angle at the pad.
    _desiredPos.set(targetX + shakeX, targetY + shakeY + info.totalHeight * 0.08, targetZ);
    camera.position.lerp(_desiredPos, 0.1);
    camera.lookAt(targetX, targetY, 0);
  });

  return null; // Logic-only component that drives the default camera
};
