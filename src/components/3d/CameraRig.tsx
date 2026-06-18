import React from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { MultiStageRocketState } from '../../physics/engine';

interface CameraRigProps {
  flightStateRef: React.MutableRefObject<MultiStageRocketState>;
}

export const CameraRig: React.FC<CameraRigProps> = ({ flightStateRef }) => {
  const { camera } = useThree();

  useFrame(() => {
    const flight = flightStateRef.current;
    
    // Target position is the rocket
    const targetX = flight.position.x;
    const targetY = flight.position.y + 6; // Center of rocket
    
    // As velocity increases, pull the camera back to convey speed and scale
    const speed = Math.sqrt(flight.velocity.x ** 2 + flight.velocity.y ** 2);
    const zoomOut = Math.min(speed * 0.15, 60); // Max zoom out is 60 units
    const baseZ = 30; // Base distance from rocket
    const targetZ = baseZ + zoomOut;
    
    // Max-Q Camera Shake (Simulate aerodynamic stress around 8k-25k meters)
    let shakeX = 0;
    let shakeY = 0;
    const altitude = flight.position.y;
    
    if (altitude > 5000 && altitude < 25000 && flight.isFlying) {
      // Peak shake around 12,000m
      const shakeIntensity = Math.max(0, 1 - Math.abs(altitude - 12000) / 7000);
      shakeX = (Math.random() - 0.5) * shakeIntensity * 1.5;
      shakeY = (Math.random() - 0.5) * shakeIntensity * 1.5;
    }
    
    // Smoothly interpolate camera position using Lerp
    const currentPos = camera.position;
    const desiredPos = new THREE.Vector3(targetX + shakeX, targetY + shakeY, targetZ);
    currentPos.lerp(desiredPos, 0.1);
    
    // Keep camera looking at the rocket
    camera.lookAt(targetX, targetY, 0);
  });

  return null; // This is a logic-only component that controls the default camera
};
