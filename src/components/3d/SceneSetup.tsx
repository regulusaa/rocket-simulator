import React from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Stars } from '@react-three/drei';
import type { MultiStageRocketState } from '../../physics/engine';

interface SceneSetupProps {
  flightStateRef: React.MutableRefObject<MultiStageRocketState>;
}

export const SceneSetup: React.FC<SceneSetupProps> = ({ flightStateRef }) => {
  const { scene } = useThree();
  const skyColor = new THREE.Color();
  
  // Set initial background color
  if (!scene.background) {
    scene.background = new THREE.Color("#87CEEB");
  }

  useFrame(() => {
    const altitude = flightStateRef.current.position.y;
    // Interpolate sky color based on altitude
    // 0m = #87CEEB (Sky Blue), 50000m = #000000 (Black)
    const t = Math.min(Math.max(altitude / 50000, 0), 1);
    
    // Smoothstep for a more natural transition
    const smoothT = t * t * (3 - 2 * t);
    
    skyColor.set("#87CEEB").lerp(new THREE.Color("#000000"), smoothT);
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(skyColor);
    }
  });

  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight 
        position={[100, 200, 50]} 
        intensity={2.5} 
        castShadow 
      />
      
      {/* Stars in the background */}
      <Stars radius={300} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
      
      {/* Infinite Ground Plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]} receiveShadow>
        <planeGeometry args={[10000, 10000]} />
        <meshStandardMaterial color="#2d3a2d" />
      </mesh>
      
      {/* Launch Pad Base */}
      <mesh position={[0, 0.5, 0]} receiveShadow>
        <cylinderGeometry args={[10, 10, 1, 32]} />
        <meshStandardMaterial color="#555555" />
      </mesh>
      
      {/* Launch Tower Tower */}
      <mesh position={[-4, 10, 0]} receiveShadow>
        <boxGeometry args={[2, 20, 2]} />
        <meshStandardMaterial color="#aa2222" />
      </mesh>
    </>
  );
};
