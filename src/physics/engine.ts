/**
 * ROCKET SIMULATOR - PHYSICS ENGINE
 * =================================
 * This file contains all the physics calculations that make the rocket move.
 * It implements real physics: gravity, thrust, velocity, position updates, fuel consumption.
 * 
 * Every frame, we:
 * 1. Apply forces (gravity pushes down, thrust pushes up)
 * 2. Calculate acceleration from those forces (F = m * a, so a = F / m)
 * 3. Update velocity based on acceleration
 * 4. Update position based on velocity
 * 5. Consume fuel if thrusting
 * 6. Check if rocket hit the ground
 */

import type {
  RocketState,
  RocketConfig,
  SimulationConfig,
  Vector2D,
  PhysicsFrame,
} from "./types";

/**
 * Creates a new rocket with all initial values set based on the rocket config.
 * This is called once at the start of the simulation to set up the rocket.
 * 
 * @param config - The rocket specifications (thrust, mass, fuel, etc.)
 * @returns A complete RocketState with all values initialized
 */
export function createRocket(config: RocketConfig): RocketState {
  // Calculate total mass by adding dry mass (structure) and fuel mass
  const totalMass = config.dryMass + config.fuelMass;

  return {
    // === POSITION AND MOVEMENT ===
    // Start at ground level (y=0) and centered horizontally (x=0)
    position: { x: 0, y: 0 },
    // Rocket starts stationary (no movement)
    velocity: { x: 0, y: 0 },
    // No acceleration yet (gravity will be applied in physics update)
    acceleration: { x: 0, y: 0 },

    // === MASS PROPERTIES ===
    // Dry mass never changes (it's the rocket structure)
    dryMass: config.dryMass,
    // Fuel mass starts full and decreases as we burn
    fuelMass: config.fuelMass,
    // Total mass is the sum (used in F=ma calculations)
    totalMass: totalMass,

    // === ENGINE PROPERTIES ===
    // Copy engine thrust from config (maximum force the engine can produce)
    engineThrust: config.engineThrust,
    // Copy specific impulse (engine efficiency)
    specificImpulse: config.specificImpulse,
    // Burn rate calculated from specific impulse (kg/s consumed when thrusting)
    // Formula: burnRate = engineThrust / (g0 * Isp)
    // where g0 = 9.81 m/s² (standard gravity)
    // This means higher Isp = lower burn rate = longer flights
    burnRate: config.engineThrust / (9.81 * config.specificImpulse),
    // Engine is off at start
    isThrusting: false,
    // Throttle starts at 0% (no thrust being produced yet)
    thrustPercentage: 0,

    // === FLIGHT STATE ===
    // Rocket hasn't launched yet
    isFlying: false,
    // Rocket hasn't landed
    hasLanded: false,
    // No landing velocity yet (will be recorded when it lands)
    landingVelocity: 0,

    // === METRICS ===
    // Max altitude starts at 0 (rocket is on ground)
    maxAltitudeReached: 0,
    // Simulation just started, no time has passed
    timeElapsed: 0,
  };
}

/**
 * Sets the throttle (how much thrust to apply).
 * Throttle ranges from 0 to 100 (percentage of max thrust).
 * 
 * Example:
 * - throttle = 0: Engine off, no thrust
 * - throttle = 50: Engine at 50% power
 * - throttle = 100: Engine at full power (maximum thrust)
 * 
 * @param state - The current rocket state
 * @param throttlePercent - Desired throttle as percentage (0-100)
 */
export function setThrottle(state: RocketState, throttlePercent: number): void {
  // Clamp throttle to valid range (can't be negative or over 100%)
  // Math.max ensures value is at least 0
  // Math.min ensures value is at most 100
  state.thrustPercentage = Math.max(0, Math.min(100, throttlePercent));

  // Set isThrusting flag: if throttle > 0, we're thrusting
  // This tells physics update to consume fuel
  state.isThrusting = state.thrustPercentage > 0;
}

/**
 * Applies the control inputs to the rocket (spacebar and click thrust).
 * This is called from the React component when the player presses keys or clicks.
 * 
 * @param state - The rocket state to modify
 * @param holdingThrottle - Is the player holding down the throttle key?
 * @param clickThrottle - Did the player just click (burst thrust)?
 * @param throttleMultiplier - How strong should the controls be (0-1)?
 */
export function applyControls(
  state: RocketState,
  holdingThrottle: boolean,
  clickThrottle: boolean,
  throttleMultiplier: number = 1
): void {
  // Start with current throttle (don't lose thrust from previous frame)
  let desiredThrottle = state.thrustPercentage;

  // If holding the throttle key (spacebar), gradually increase to 100%
  // This gives smooth, continuous thrust control
  if (holdingThrottle) {
    // Increase throttle by 1% per frame (adjust this value to change how quickly you reach full throttle)
    // Multiply by throttleMultiplier so we can tune control responsiveness
    desiredThrottle = Math.min(100, desiredThrottle + 2 * throttleMultiplier);
  } else {
    // If not holding throttle, gradually decrease (engine spools down)
    // Decrease by 2% per frame for smooth shutdown
    desiredThrottle = Math.max(0, desiredThrottle - 2 * throttleMultiplier);
  }

  // If player clicked, add a burst of thrust (10% boost)
  // This adds on top of continuous thrust for quick maneuvers
  if (clickThrottle) {
    desiredThrottle = Math.min(100, desiredThrottle + 10);
  }

  // Apply the desired throttle to the rocket
  setThrottle(state, desiredThrottle);
}

/**
 * The main physics update function. Called every frame (typically 60 times per second).
 * This is where all the movement happens using Newton's laws of motion.
 * 
 * Physics process:
 * 1. Calculate all forces acting on the rocket (gravity down, thrust up, drag opposing motion)
 * 2. Sum all forces to get net force
 * 3. Use F = m*a to calculate acceleration
 * 4. Use a = dv/dt to update velocity
 * 5. Use v = dx/dt to update position
 * 6. Consume fuel if thrusting
 * 7. Track max altitude reached
 * 8. Check if rocket hit ground
 * 
 * @param state - Current rocket state
 * @param simConfig - World settings (gravity, wind, drag, etc.)
 * @param deltaTime - Time since last frame (seconds)
 * @returns PhysicsFrame with updated state and event flags
 */
export function updatePhysics(
  state: RocketState,
  simConfig: SimulationConfig,
  deltaTime: number
): PhysicsFrame {
  // Track if ground was impacted this frame (for collision detection)
  let groundImpact = false;

  // === FORCE CALCULATIONS ===
  // We calculate acceleration by summing all forces and dividing by mass
  // Then apply that acceleration to velocity each frame

  // Start with clean acceleration (no forces yet)
  let accelerationX = 0;
  let accelerationY = 0;

  // === GRAVITY ===
  // Gravity pulls down with constant acceleration of 9.81 m/s²
  // Negative because down is negative Y direction
  accelerationY -= simConfig.gravity;

  // === THRUST ===
  // Thrust only applies if engine is on and we have fuel
  if (state.isThrusting && state.fuelMass > 0) {
    // Calculate actual thrust force based on throttle percentage
    // If throttle is 50%, only use 50% of engine's maximum thrust
    const actualThrust = state.engineThrust * (state.thrustPercentage / 100);

    // Apply thrust using Newton's 2nd law: F = m*a, so a = F/m
    // Thrust acts upward (positive Y)
    // Divide by totalMass so heavier rockets need more thrust to accelerate same amount
    accelerationY += actualThrust / state.totalMass;

    // === FUEL CONSUMPTION ===
    // When thrusting, we burn fuel
    // Amount burned per frame = burnRate (kg/s) * deltaTime (seconds)
    // This gives us how much fuel was burned THIS frame
    const fuelBurnedThisFrame = state.burnRate * (state.thrustPercentage / 100) * deltaTime;

    // Subtract burned fuel from fuel tank
    state.fuelMass -= fuelBurnedThisFrame;

    // Clamp to zero (can't have negative fuel)
    if (state.fuelMass < 0) {
      state.fuelMass = 0;
    }

    // Recalculate total mass since fuel mass changed
    // This is important: as you burn fuel, the rocket gets lighter
    // Lighter rockets accelerate faster with same thrust (a = F/m)
    state.totalMass = state.dryMass + state.fuelMass;

    // If out of fuel, turn off engine
    if (state.fuelMass <= 0) {
      state.isThrusting = false;
      state.thrustPercentage = 0;
    }
  } else {
    // No thrust if not thrusting or out of fuel
    // Gravity still pulls down (already added above)
  }

  // === DRAG (simplified) ===
  // Air resistance opposes motion - the faster you go, the more drag
  // Drag force = 0.5 * rho * v² * Cd * Area
  // But we'll use a simplified version: dragCoefficient * velocity
  // This is not perfectly realistic but is easier to tune and more forgiving to play

  // Calculate drag opposing horizontal motion
  if (state.velocity.x !== 0) {
    const dragForceX = simConfig.dragCoefficient * Math.abs(state.velocity.x);
    // Drag opposes motion direction
    accelerationX -= (dragForceX / state.totalMass) * Math.sign(state.velocity.x);
  }

  // Calculate drag opposing vertical motion
  if (state.velocity.y !== 0) {
    const dragForceY = simConfig.dragCoefficient * Math.abs(state.velocity.y);
    // Drag opposes motion direction
    accelerationY -= (dragForceY / state.totalMass) * Math.sign(state.velocity.y);
  }

  // Store acceleration in state (useful for UI display)
  state.acceleration.x = accelerationX;
  state.acceleration.y = accelerationY;

  // === VELOCITY UPDATE ===
  // v_new = v_old + a * dt (basic kinematics)
  // This is how much the velocity changes over this frame
  state.velocity.x += accelerationX * deltaTime;
  state.velocity.y += accelerationY * deltaTime;

  // === POSITION UPDATE ===
  // x_new = x_old + v * dt (basic kinematics)
  // This moves the rocket based on how fast it's moving
  state.position.x += state.velocity.x * deltaTime;
  state.position.y += state.velocity.y * deltaTime;

  // === MARK ROCKET AS FLYING ===
  // Once the rocket moves up off the ground, it's officially flying
  if (state.position.y > 1 && !state.isFlying) {
    state.isFlying = true;
  }

  // === TRACK MAX ALTITUDE ===
  // Keep track of the highest point reached
  if (state.position.y > state.maxAltitudeReached) {
    state.maxAltitudeReached = state.position.y;
  }

  // === GROUND COLLISION ===
  // Check if rocket hit the ground (position.y <= 0)
  if (state.position.y <= 0) {
    // Snap position to exactly ground level
    state.position.y = 0;

    // Record how fast we were going when we hit
    state.landingVelocity = state.velocity.y;

    // Stop all motion immediately (crash!)
    state.velocity.x = 0;
    state.velocity.y = 0;

    // Mark that we've landed
    state.isFlying = false;
    state.hasLanded = true;

    // Signal that ground impact happened (for animations, sounds, etc.)
    groundImpact = true;
  }

  // === UPDATE SIMULATION TIME ===
  // Keep track of how long the simulation has been running
  state.timeElapsed += deltaTime;

  // Return the updated state and metadata
  return {
    state,
    deltaTime,
    groundImpact,
  };
}

/**
 * Resets the rocket to its starting state without creating a new object.
 * Used when the player clicks "Reset" or "Launch Again".
 * 
 * @param state - The rocket state to reset
 * @param config - The rocket config (to restore original fuel, mass, etc.)
 */
export function resetRocket(state: RocketState, config: RocketConfig): void {
  // Return to starting position (ground level, x = 0)
  state.position.x = 0;
  state.position.y = 0;

  // Zero out all motion
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.acceleration.x = 0;
  state.acceleration.y = 0;

  // Refill the fuel tank
  state.fuelMass = config.fuelMass;
  state.totalMass = config.dryMass + config.fuelMass;

  // Reset engine state
  state.isThrusting = false;
  state.thrustPercentage = 0;

  // Reset flight state
  state.isFlying = false;
  state.hasLanded = false;
  state.landingVelocity = 0;

  // Reset metrics
  state.maxAltitudeReached = 0;
  state.timeElapsed = 0;
}

/**
 * Calculates the landing quality as a score.
 * Soft landings (low velocity) score higher than crashes (high velocity).
 * 
 * @param landingVelocity - How fast the rocket was moving when it hit (m/s, negative = downward)
 * @returns A score from 0 (crash) to 100 (perfect landing)
 */
export function calculateLandingScore(landingVelocity: number): number {
  // Convert to absolute value (we only care about speed, not direction)
  const speed = Math.abs(landingVelocity);

  // Safe landing: less than 5 m/s
  if (speed < 5) return 100;

  // Good landing: 5-10 m/s
  if (speed < 10) return 80;

  // Acceptable: 10-20 m/s
  if (speed < 20) return 60;

  // Hard landing: 20-40 m/s
  if (speed < 40) return 30;

  // Crash: over 40 m/s (rocket probably exploded)
  return 0;
}