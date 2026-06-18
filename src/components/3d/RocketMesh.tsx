import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { MultiStageRocketState } from '../../physics/engine';

interface RocketMeshProps {
  flightStateRef: React.MutableRefObject<MultiStageRocketState>;
}

export const RocketMesh: React.FC<RocketMeshProps> = ({ flightStateRef }) => {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!groupRef.current) return;
    
    const state = flightStateRef.current;
    
    // Apply position
    // In physics engine, position.x is horizontal, position.y is altitude.
    // Adding 6 to y so the 12m tall rocket (center at 0) sits above the ground (y=0).
    groupRef.current.position.set(state.position.x, state.position.y + 6, 0);
    
    // Apply rotation
    // Physics engine angle: 0 is vertical, positive is tilted right.
    // Three.js: rotation.z controls roll around Z axis (which looks like tilt on 2D screen).
    // A negative rotation in ThreeJS Z tilts to the right.
    groupRef.current.rotation.z = -state.angle; 
  });

  return (
    <group ref={groupRef}>
      {/* Main Rocket Body */}
      <mesh position={[0, 0, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.5, 1.5, 10, 32]} />
        <meshStandardMaterial color="#eeeeee" roughness={0.2} metalness={0.8} />
      </mesh>
      
      {/* Nosecone */}
      <mesh position={[0, 6, 0]} castShadow receiveShadow>
        <coneGeometry args={[1.5, 2, 32]} />
        <meshStandardMaterial color="#222222" roughness={0.5} metalness={0.5} />
      </mesh>
      
      {/* Engine Bell */}
      <mesh position={[0, -5.5, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1, 1.5, 1, 32]} />
        <meshStandardMaterial color="#111111" roughness={0.8} metalness={0.9} />
      </mesh>
      
      {/* Small Fins */}
      <mesh position={[1.5, -4, 0]} rotation={[0, 0, -Math.PI / 8]} castShadow receiveShadow>
        <boxGeometry args={[1, 2, 0.1]} />
        <meshStandardMaterial color="#222222" />
      </mesh>
      <mesh position={[-1.5, -4, 0]} rotation={[0, 0, Math.PI / 8]} castShadow receiveShadow>
        <boxGeometry args={[1, 2, 0.1]} />
        <meshStandardMaterial color="#222222" />
      </mesh>
    </group>
  );
};
