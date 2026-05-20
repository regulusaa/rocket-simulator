/**
 * ROCKET SIMULATOR - PHYSICS ENGINE (MULTI-STAGE VERSION)
 * =======================================================
 * Updated physics engine that works with multi-stage rockets instead of single-stage.
 * 
 * Key differences from single-stage version:
 * - Uses MultiStageRocketConfig instead of RocketState for configuration
 * - Calculates thrust and mass from all active stages
 * - Handles fuel consumption across all stages
 * - Performs automatic staging when stages run out of fuel
 * - Tracks which stage is currently active
 * 
 * The physics calculations remain the same (F=ma, kinematics, etc.),
 * but now we sum forces and mass across multiple stages.
 */

import type {
  Vector2D,
  SimulationConfig,
} from "./types";
import type { MultiStageRocketConfig } from "./MultiStageSystem";
import {
  calculateTotalMass,
  calculateTotalThrust,
  applyMultiStageThrottle,
  checkAndPerformStaging,
  consumeFuel,
  resetAllStages,
} from "./MultiStageSystem";

/**
 * State for a multi-stage rocket during flight.
 * This is similar to RocketState but adapted for multi-stage rockets.
 * 
 * The key difference: instead of storing fuel/mass/thrust in one state object,
 * we store them in the MultiStageRocketConfig (which contains all stages),
 * and this state object tracks position, velocity, and flight metrics.
 */
export interface MultiStageRocketState {
  // === POSITION AND MOVEMENT ===
  // Where the rocket is in 3D space
  position: Vector2D; // (x, y) in meters
  velocity: Vector2D; // (vx, vy) in m/s
  acceleration: Vector2D; // (ax, ay) in m/s²

  // === FLIGHT STATE ===
  // Is the rocket actively flying (off the ground)?
  isFlying: boolean;

  // Has the rocket landed/crashed?
  hasLanded: boolean;

  // How fast was it moving when it landed?
  landingVelocity: number; // m/s (negative = downward)

  // === METRICS ===
  // Highest altitude reached so far
  maxAltitudeReached: number; // meters

  // Total time since launch
  timeElapsed: number; // seconds

  // Which stage is currently active (burning fuel)?
  // 0 = first stage, 1 = second stage, etc.
  activeStageNumber: number;

  // Total number of stages that have separated so far
  stageSeparationCount: number;

  // Did a stage separate this frame? (for visual effects)
  didStageSeperateThisFrame: boolean;
}

/**
 * Create initial multi-stage rocket state.
 * Sets up all the position/velocity/flight data for a new launch.
 * 
 * @param config - The multi-stage rocket configuration
 * @returns Initialized flight state
 */
export interface MultiStagePhysicsFrame {
  state: MultiStageRocketState;
  deltaTime: number;
  groundImpact: boolean;
}

export function createMultiStageRocket(
  _config: MultiStageRocketConfig
): MultiStageRocketState {
  return {
    // === POSITION AND MOVEMENT ===
    // Start on the ground, centered horizontally
    position: { x: 0, y: 0 },
    // No initial motion
    velocity: { x: 0, y: 0 },
    // No acceleration yet (gravity will be applied in update)
    acceleration: { x: 0, y: 0 },

    // === FLIGHT STATE ===
    // Rocket hasn't launched yet
    isFlying: false,
    // Rocket hasn't landed
    hasLanded: false,
    // No landing velocity yet
    landingVelocity: 0,

    // === METRICS ===
    // Max altitude starts at ground level
    maxAltitudeReached: 0,
    // No time has passed yet
    timeElapsed: 0,
    // First stage (0) is the initial active stage
    activeStageNumber: 0,
    // No stages separated yet
    stageSeparationCount: 0,
    // No separation this frame
    didStageSeperateThisFrame: false,
  };
}

/**
 * Apply player controls to all stages of the rocket.
 * This is identical to single-stage version but calls the multi-stage throttle function.
 * 
 * @param config - The rocket configuration (contains all stages)
 * @param holdingThrottle - Is player holding spacebar?
 * @param clickThrottle - Did player just click?
 * @param throttleMultiplier - Control responsiveness
 */
export function applyControls(
  config: MultiStageRocketConfig,
  holdingThrottle: boolean,
  clickThrottle: boolean,
  throttleMultiplier: number = 1
): void {
  // Call multi-stage throttle function which handles all stages
  applyMultiStageThrottle(config, holdingThrottle, clickThrottle, throttleMultiplier);
}

/**
 * The main physics update function for multi-stage rockets.
 * Called every frame to simulate one time step of rocket flight.
 * 
 * Process:
 * 1. Check if any stages should separate (automatic staging)
 * 2. Calculate total mass and thrust from all active stages
 * 3. Apply forces (gravity, thrust, drag)
 * 4. Update velocity and position using kinematics
 * 5. Consume fuel from all burning stages
 * 6. Check for ground collision
 * 7. Track metrics (max altitude, time, etc.)
 * 
 * @param state - Current flight state
 * @param config - Rocket configuration (all stages)
 * @param simConfig - World settings (gravity, wind, drag)
 * @param deltaTime - Time since last frame (seconds)
 * @returns PhysicsFrame with updated state and events
 */
export function updatePhysics(
  state: MultiStageRocketState,
  config: MultiStageRocketConfig,
  simConfig: SimulationConfig,
  deltaTime: number
): MultiStagePhysicsFrame {
  // Track if ground was hit this frame
  let groundImpact = false;

  // === STAGING CHECK ===
  // This is the multi-stage logic: when a stage runs out of fuel, separate it
  // and ignite the next stage automatically
  const stagingSeparated = checkAndPerformStaging(config);
  state.didStageSeperateThisFrame = stagingSeparated;

  // If a stage separated, increment our counter and update active stage number
  if (stagingSeparated) {
    state.stageSeparationCount++;
    // Find the currently active stage
    for (let i = 0; i < config.stages.length; i++) {
      if (config.stages[i].isActive) {
        state.activeStageNumber = i;
        break;
      }
    }
  }

  // === FORCE CALCULATIONS ===
  // Start with zero acceleration (no forces yet)
  let accelerationX = 0;
  let accelerationY = 0;

  // Calculate current total mass of all active (non-separated) stages plus payload
  // This is crucial: as fuel burns and stages separate, mass decreases
  // Lower mass = same thrust = higher acceleration (F = m*a, so a = F/m)
  const totalMass = calculateTotalMass(config);

  // Calculate total thrust from all currently thrusting stages
  // This sums the thrust from each active stage
  const totalThrust = calculateTotalThrust(config);

  // === GRAVITY ===
  // Gravity pulls down with constant acceleration
  // Negative because down is negative Y
  accelerationY -= simConfig.gravity;

  // === THRUST ===
  // Apply total thrust to all stages to the rocket
  // Using Newton's 2nd law: a = F / m
  // Thrust acts upward (positive Y)
  if (totalThrust > 0) {
    accelerationY += totalThrust / totalMass;
  }

  // === DRAG ===
  // Air resistance opposes motion (simplified model)
  // Drag force = dragCoefficient * velocity
  // Higher velocity = more drag

  // Drag opposing horizontal motion
  if (state.velocity.x !== 0) {
    const dragForceX = simConfig.dragCoefficient * Math.abs(state.velocity.x);
    // Drag opposes direction of motion
    accelerationX -= (dragForceX / totalMass) * Math.sign(state.velocity.x);
  }

  // Drag opposing vertical motion
  if (state.velocity.y !== 0) {
    const dragForceY = simConfig.dragCoefficient * Math.abs(state.velocity.y);
    // Drag opposes direction of motion
    accelerationY -= (dragForceY / totalMass) * Math.sign(state.velocity.y);
  }

  // === WIND ===
  // If there's wind in the world, it affects horizontal acceleration
  if (simConfig.windSpeed.x !== 0) {
    // Wind pushes the rocket sideways
    // The wind has a fixed force, so smaller rockets (lower mass) are pushed more
    const windForce = simConfig.windSpeed.x * 1000; // Scale wind force
    accelerationX += windForce / totalMass;
  }

  // Store acceleration in state (useful for UI display)
  state.acceleration.x = accelerationX;
  state.acceleration.y = accelerationY;

  // === VELOCITY UPDATE ===
  // v_new = v_old + a * dt
  // This is basic kinematics: velocity changes based on acceleration
  state.velocity.x += accelerationX * deltaTime;
  state.velocity.y += accelerationY * deltaTime;

  // === POSITION UPDATE ===
  // x_new = x_old + v * dt
  // This moves the rocket based on how fast it's moving
  state.position.x += state.velocity.x * deltaTime;
  state.position.y += state.velocity.y * deltaTime;

  // === FUEL CONSUMPTION ===
  // Consume fuel from all burning stages
  // This updates the fuelMass in each stage based on burn rate and throttle
  consumeFuel(config, deltaTime);

  // === MARK AS FLYING ===
  // Once rocket goes above ground level, it's officially flying
  if (state.position.y > 1 && !state.isFlying) {
    state.isFlying = true;
  }

  // === TRACK MAX ALTITUDE ===
  // Keep record of highest point reached
  if (state.position.y > state.maxAltitudeReached) {
    state.maxAltitudeReached = state.position.y;
  }

  // === GROUND COLLISION ===
  // Check if rocket hit the ground (y <= 0)
  if (state.position.y <= 0) {
    // Snap to exactly ground level
    state.position.y = 0;

    // Record landing velocity (how fast we were going)
    state.landingVelocity = state.velocity.y;

    // Stop all motion (crash!)
    state.velocity.x = 0;
    state.velocity.y = 0;

    // Mark flight as over
    state.isFlying = false;
    state.hasLanded = true;

    // Signal ground impact
    groundImpact = true;
  }

  // === UPDATE TIME ===
  // Track how long the simulation has been running
  state.timeElapsed += deltaTime;

  // Return updated state and event flags
  return {
    state,
    deltaTime,
    groundImpact,
  };
}

/**
 * Reset the rocket for a new launch.
 * Refills fuel, resets position, and reactivates first stage.
 * 
 * @param state - The flight state to reset
 * @param config - The rocket configuration to reset
 */
export function resetRocket(
  state: MultiStageRocketState,
  config: MultiStageRocketConfig
): void {
  // === RESET POSITION ===
  // Back to ground, centered
  state.position.x = 0;
  state.position.y = 0;

  // === RESET MOTION ===
  // Stop all movement
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.acceleration.x = 0;
  state.acceleration.y = 0;

  // === RESET FLIGHT STATE ===
  // Not flying anymore
  state.isFlying = false;
  state.hasLanded = false;
  state.landingVelocity = 0;

  // === RESET METRICS ===
  // Clear records
  state.maxAltitudeReached = 0;
  state.timeElapsed = 0;
  state.activeStageNumber = 0;
  state.stageSeparationCount = 0;
  state.didStageSeperateThisFrame = false;

  // === RESET ALL STAGES ===
  // Refill fuel tanks, reattach stages, turn off engines
  resetAllStages(config);
}

/**
 * Calculate landing quality score (0-100).
 * Soft landings (low velocity) score higher.
 * Hard crashes (high velocity) score lower.
 * 
 * @param landingVelocity - Speed when hitting ground (m/s, negative = downward)
 * @returns Score from 0 (crash) to 100 (perfect landing)
 */
export function calculateLandingScore(landingVelocity: number): number {
  // Convert to absolute speed (we don't care about direction, just magnitude)
  const speed = Math.abs(landingVelocity);

  // Safe soft landing (very gentle)
  if (speed < 5) return 100;

  // Good landing (gentle)
  if (speed < 10) return 80;

  // Acceptable landing (moderate impact)
  if (speed < 20) return 60;

  // Hard landing (rough impact but may survive)
  if (speed < 40) return 30;

  // Crash (extremely hard impact)
  return 0;
}

/**
 * Get information about fuel status of all stages.
 * Useful for displaying stage-by-stage telemetry in UI.
 * 
 * @param config - The rocket configuration
 * @returns Array of fuel status for each stage
 */
export function getStageFuelStatus(config: MultiStageRocketConfig): Array<{
  stageNumber: number;
  name: string;
  fuelPercent: number;
  isSeparated: boolean;
  isActive: boolean;
}> {
  return config.stages.map((stage) => ({
    stageNumber: stage.stageNumber,
    name: stage.name,
    // Calculate fuel as percentage of capacity
    fuelPercent: (stage.fuelMass / stage.fuelCapacity) * 100,
    isSeparated: stage.isSeparated,
    isActive: stage.isActive,
  }));
}