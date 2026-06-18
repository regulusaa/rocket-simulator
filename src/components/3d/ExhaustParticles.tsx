import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { MultiStageRocketState } from '../../physics/engine';
import type { MultiStageRocketConfig } from '../../physics/MultiStageSystem';

interface ExhaustParticlesProps {
  flightStateRef: React.MutableRefObject<MultiStageRocketState>;
  configRef: React.MutableRefObject<MultiStageRocketConfig>;
}

const PARTICLE_COUNT = 300;

export const ExhaustParticles: React.FC<ExhaustParticlesProps> = ({ flightStateRef, configRef }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  
  // Track particle life and initial offsets
  const particles = useMemo(() => {
    return new Array(PARTICLE_COUNT).fill(0).map(() => ({
      life: Math.random(),
      speed: 30 + Math.random() * 20,
      offset: new THREE.Vector3((Math.random() - 0.5), 0, (Math.random() - 0.5)),
    }));
  }, []);

  // Use a stable color array to update colors dynamically (blue -> orange -> dark smoke)
  const colorArray = useMemo(() => new Float32Array(PARTICLE_COUNT * 3), []);
  const tempColor = useMemo(() => new THREE.Color(), []);

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    
    const flight = flightStateRef.current;
    const config = configRef.current;
    
    // Check if thrusting
    const activeStage = config.stages.find((s) => s.isActive && !s.isSeparated);
    const isThrusting = activeStage && activeStage.thrustPercentage > 0 && activeStage.fuelMass > 0;
    
    // Position of the exhaust (bottom of the engine bell)
    // Rocket center is y+6, bell is at y=-6 relative to center, so engine is exactly at position.y
    const rocketPos = new THREE.Vector3(flight.position.x, flight.position.y, 0);
    
    // The exhaust plume gets wider at higher altitudes (lower pressure)
    // Vacuum expansion effect
    const altitude = flight.position.y;
    const expansionFactor = 1 + (altitude / 15000); // 1x at 0m, ~4x at 50km

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = particles[i];
      
      if (isThrusting) {
        p.life += delta * 6; // Life goes 0 to 1
        if (p.life > 1) {
          p.life = 0; // Respawn at the engine
        }
      } else {
        p.life += delta * 3; // Fade out remaining quickly
      }

      if (p.life > 1) {
        dummy.position.set(0, -9999, 0);
        dummy.scale.set(0, 0, 0);
      } else {
        // Calculate position relative to rocket
        // They shoot downwards relative to rocket angle
        const downDir = new THREE.Vector3(0, -1, 0).applyAxisAngle(new THREE.Vector3(0,0,1), -flight.angle);
        
        // Base position is rocket position
        const pPos = rocketPos.clone();
        
        // Move along downDir based on life and speed
        const travelDist = p.life * p.speed;
        pPos.add(downDir.clone().multiplyScalar(travelDist));
        
        // Add lateral expansion (wider as it travels down and wider based on altitude)
        const spread = (0.5 + p.life * 3) * expansionFactor;
        pPos.add(p.offset.clone().multiplyScalar(spread));
        
        dummy.position.copy(pPos);
        
        // Scale shrinks as it lives
        const s = (1 - p.life) * 2;
        dummy.scale.set(s, s, s);

        // Color interpolation based on life
        if (p.life < 0.2) {
          // Mach diamond core (bright white/blue)
          tempColor.setRGB(0.8, 0.9, 1.0);
        } else if (p.life < 0.6) {
          // Flame (orange/yellow)
          tempColor.setRGB(1.0, 0.5, 0.1);
        } else {
          // Smoke (darkening orange/grey)
          tempColor.setRGB(0.4, 0.2, 0.1);
        }
        tempColor.toArray(colorArray, i * 3);
      }
      
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    }
    
    meshRef.current.instanceMatrix.needsUpdate = true;
    
    if (!meshRef.current.geometry.hasAttribute('color')) {
      meshRef.current.geometry.setAttribute('color', new THREE.InstancedBufferAttribute(colorArray, 3));
    } else {
      (meshRef.current.geometry.attributes.color as THREE.InstancedBufferAttribute).copyArray(colorArray);
      meshRef.current.geometry.attributes.color.needsUpdate = true;
    }
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, PARTICLE_COUNT]} frustumCulled={false}>
      <sphereGeometry args={[0.5, 8, 8]} />
      {/* Additive blending for glowing fire look */}
      <meshBasicMaterial 
        vertexColors
        transparent 
        opacity={0.8}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </instancedMesh>
  );
};
