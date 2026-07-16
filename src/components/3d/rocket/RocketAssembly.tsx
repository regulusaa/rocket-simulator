/**
 * ROCKET ASSEMBLY — the procedural flight rocket
 * ==============================================
 * Replaces the old hardcoded RocketMesh. Builds real per-part 3D geometry from
 * the rocket's config (via generateRocketSpec) so every custom build looks
 * like the parts it was assembled from.
 *
 * Render-bridge contract (same as the rest of the 3D scene): physics writes a
 * mutable flightStateRef each tick; this component reads it inside useFrame
 * and moves THREE objects directly — zero React re-renders per frame.
 *
 * Scene graph:
 *   <group ref={pivotRef}>          world transform: position + tilt (pivot = stack center)
 *     <group ref={innerRef}>        offsets stack space so the pivot sits at the center
 *       ...stage groups (children at absolute stack-space y)
 *     </group>
 *   </group>
 *   <group ref={droppedRootRef}>    world-space jettisoned stages, tumbling away
 *
 * Position contract (inherited from the old RocketMesh + ExhaustParticles):
 * physics position.y = the ACTIVE stage's nozzle-exit plane. After separation
 * the stack is re-offset so the new bottom stays glued to the physics altitude.
 *
 * Stage separation: when config.stages[i].isSeparated flips true, that stage's
 * group is reparented from the stack into world space with its current pose
 * and tumbles away ballistically for a few seconds. Reset reattaches it.
 */

/* eslint-disable react-hooks/immutability --
   react-three-fiber render bridge: the stage groups built in useMemo are
   intentionally mutated inside useFrame (transforms, reparenting on stage
   separation, emissive throttle glow) — the standard r3f imperative pattern. */

import React, { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { MultiStageRocketState } from "../../../physics/engine";
import type { MultiStageRocketConfig } from "../../../physics/MultiStageSystem";
import { generateRocketSpec } from "./generateRocketSpec";
import { buildStageGroup, disposeStageGroup, type BuiltStage } from "./buildStage";
import { mulberry32 } from "./geometry";
import type { RocketVisualInfo } from "./types";

interface RocketAssemblyProps {
  flightStateRef: React.MutableRefObject<MultiStageRocketState>;
  /**
   * The active config OBJECT (not a ref): RocketSimulator's `rocketConfig`
   * state, which gets a fresh identity on every rocket switch/reset — that
   * identity change is what triggers a geometry rebuild.
   */
  config: MultiStageRocketConfig;
  /** Live physics config (mutated by the engine) — read for throttle/staging. */
  configRef: React.MutableRefObject<MultiStageRocketConfig>;
  /** Written every frame: camera/exhaust/smoke read framing + nozzle info here. */
  visualInfoRef: React.MutableRefObject<RocketVisualInfo>;
}

interface DroppedStage {
  stageIndex: number;
  object: THREE.Group;
  velocityX: number;
  velocityY: number;
  angularVelocity: number;
  age: number;
}

/** Dropped stages vanish after this long (they're far behind the camera by then). */
const DROPPED_LIFETIME_S = 12;

export const RocketAssembly: React.FC<RocketAssemblyProps> = ({
  flightStateRef,
  config,
  configRef,
  visualInfoRef,
}) => {
  const pivotRef = useRef<THREE.Group>(null);
  const innerRef = useRef<THREE.Group>(null);
  const droppedRootRef = useRef<THREE.Group>(null);
  const prevSeparatedRef = useRef<boolean[]>([]);
  const droppedRef = useRef<DroppedStage[]>([]);

  // Rebuild the visual spec + geometry only when the config object changes
  // (rocket switch or reset — never per frame).
  const spec = useMemo(() => generateRocketSpec(config), [config]);
  const builtStages: BuiltStage[] = useMemo(
    () => spec.stages.map((stage) => buildStageGroup(stage, spec.seed)),
    [spec],
  );

  // Dispose geometry + per-assembly emissive materials when rebuilt/unmounted,
  // and clear any debris/separation tracking from the previous rocket.
  useEffect(() => {
    prevSeparatedRef.current = spec.stages.map(() => false);
    droppedRef.current = [];
    return () => {
      for (const built of builtStages) {
        disposeStageGroup(built.group);
        built.innerBellMaterial?.dispose();
      }
    };
  }, [builtStages, spec]);

  useFrame((_, delta) => {
    const pivot = pivotRef.current;
    const inner = innerRef.current;
    const droppedRoot = droppedRootRef.current;
    if (!pivot || !inner || !droppedRoot) return;

    const flight = flightStateRef.current;
    const liveConfig = configRef.current;
    const stageCount = spec.stages.length;

    // ── Active stage: first non-separated (the last stage never "leaves"). ──
    let activeIndex = liveConfig.stages.findIndex((s) => !s.isSeparated);
    if (activeIndex === -1 || activeIndex >= stageCount) activeIndex = stageCount - 1;
    const activeSpec = spec.stages[activeIndex];

    // ── Stack placement: pivot at the remaining stack's center so tilt looks
    //    like a rotation about the vehicle, not about its tail. ──
    const nozzleY = activeSpec.nozzleExitY;
    const stackCenterY = (nozzleY + spec.totalHeight) / 2;
    inner.position.y = -stackCenterY;
    pivot.position.set(flight.position.x, flight.position.y + (stackCenterY - nozzleY), 0);
    pivot.rotation.z = -flight.angle;

    // ── Separation events (never the top stage — something must remain). ──
    for (let i = 0; i < stageCount - 1; i++) {
      const isSep = liveConfig.stages[i]?.isSeparated ?? false;
      const wasSep = prevSeparatedRef.current[i];

      if (isSep && !wasSep) {
        const built = builtStages[i];
        if (built.group.parent === inner) {
          // Freeze the stage's current world pose, then hand it to world space.
          const worldPos = new THREE.Vector3();
          const worldQuat = new THREE.Quaternion();
          built.group.getWorldPosition(worldPos);
          built.group.getWorldQuaternion(worldQuat);
          droppedRoot.add(built.group);
          built.group.position.copy(worldPos);
          built.group.quaternion.copy(worldQuat);

          const rand = mulberry32(spec.seed ^ (i + 1));
          droppedRef.current.push({
            stageIndex: i,
            object: built.group,
            velocityX: flight.velocity.x * 0.9,
            velocityY: flight.velocity.y - 6,
            angularVelocity: (rand() - 0.5) * 0.9,
            age: 0,
          });
        }
      } else if (!isSep && wasSep) {
        // Reset mid-flight: reattach the stage in its build position.
        const built = builtStages[i];
        const dropIdx = droppedRef.current.findIndex((d) => d.stageIndex === i);
        if (dropIdx !== -1) droppedRef.current.splice(dropIdx, 1);
        inner.add(built.group);
        built.group.position.set(0, 0, 0);
        built.group.quaternion.identity();
        built.group.visible = true;
      }
      prevSeparatedRef.current[i] = isSep;
    }

    // ── Tumble + expire dropped stages (simple ballistic integration). ──
    for (let d = droppedRef.current.length - 1; d >= 0; d--) {
      const dropped = droppedRef.current[d];
      dropped.age += delta;
      dropped.velocityY -= 9.81 * delta;
      dropped.object.position.x += dropped.velocityX * delta;
      dropped.object.position.y += dropped.velocityY * delta;
      dropped.object.rotation.z += dropped.angularVelocity * delta;
      if (dropped.age > DROPPED_LIFETIME_S || dropped.object.position.y < -200) {
        dropped.object.visible = false;
        droppedRoot.remove(dropped.object);
        droppedRef.current.splice(d, 1);
      }
    }

    // ── Engine glow: inner bell emissive tracks each stage's live throttle. ──
    for (let i = 0; i < stageCount; i++) {
      const material = builtStages[i].innerBellMaterial;
      if (!material) continue;
      const stage = liveConfig.stages[i];
      const target =
        stage && stage.isThrusting && stage.fuelMass > 0 ? (stage.thrustPercentage / 100) * 1.6 : 0;
      material.emissiveIntensity += (target - material.emissiveIntensity) * Math.min(delta * 8, 1);
    }

    // ── Publish framing/exhaust info for CameraRig, ExhaustParticles, smoke. ──
    const info = visualInfoRef.current;
    const dy = nozzleY - stackCenterY; // nozzle offset below the pivot (negative)
    info.totalHeight = spec.totalHeight - nozzleY;
    info.centerY = pivot.position.y;
    info.nozzleX = pivot.position.x + dy * Math.sin(flight.angle);
    info.nozzleY = pivot.position.y + dy * Math.cos(flight.angle);
    info.plumeStyle = activeSpec.plumeStyle;
    info.bodyRadius = activeSpec.bodyRadius;
    info.nozzleRadius = activeSpec.engine
      ? (activeSpec.engine.diameterM / 2) * activeSpec.engineScale
      : activeSpec.bodyRadius * 0.4;
  });

  return (
    <>
      <group ref={pivotRef}>
        <group ref={innerRef}>
          {builtStages.map((built, i) => (
            <primitive object={built.group} key={`${spec.seed}-${i}`} />
          ))}
        </group>
      </group>
      <group ref={droppedRootRef} />
    </>
  );
};
