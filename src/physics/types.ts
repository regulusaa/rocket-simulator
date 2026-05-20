/**
 * ROCKET SIMULATOR - PHYSICS TYPES
 * ================================
 * This file defines all the TypeScript interfaces and types that represent
 * the rocket, its state, and the physics parameters. Think of this as the
 * "blueprint" for what data we track about the rocket at any moment.
 */

/**
 * Vector2D represents a 2D point or direction with X and Y components.
 * Used for position, velocity, and acceleration throughout the simulation.
 * 
 * Example:
 * position: { x: 100, y: 500 } means the rocket is 100m horizontally, 500m up
 * velocity: { x: 0, y: 50 } means rocket is moving 50 m/s upward
 */
export interface Vector2D {
  x: number; // Horizontal component (meters or m/s)
  y: number; // Vertical component (meters or m/s)
}

/**
 * RocketState contains ALL information about the rocket at a single moment in time.
 * Every frame, we update these values based on physics calculations.
 * 
 * Think of this as a snapshot: "Here's exactly what the rocket looks like RIGHT NOW"
 */
export interface RocketState {
  // === POSITION AND MOVEMENT ===
  position: Vector2D; // Where the rocket is in 3D space (x=horizontal, y=altitude)
  velocity: Vector2D; // How fast it's moving (x=horizontal speed, y=vertical speed)
  acceleration: Vector2D; // How much velocity is changing (gravity + thrust causes this)

  // === MASS PROPERTIES ===
  dryMass: number; // Mass of rocket structure with no fuel (kg)
  fuelMass: number; // How much fuel is currently in the tank (kg)
  totalMass: number; // dryMass + fuelMass (changes as fuel burns)

  // === ENGINE PROPERTIES ===
  engineThrust: number; // Maximum thrust the engine can produce (Newtons)
  specificImpulse: number; // Engine efficiency (affects fuel burn rate)
  burnRate: number; // How much fuel is consumed per second when thrusting (kg/s)
  isThrusting: boolean; // Is the engine currently firing?
  thrustPercentage: number; // What percentage of max thrust (0-100%) - for variable thrust

  // === FLIGHT STATE ===
  isFlying: boolean; // Has the rocket launched and is it still in the air?
  hasLanded: boolean; // Has the rocket come back down and stopped?
  landingVelocity: number; // How fast was the rocket moving when it landed?

  // === METRICS ===
  maxAltitudeReached: number; // Highest point achieved so far (meters)
  timeElapsed: number; // How long has the simulation been running (seconds)
}

/**
 * RocketConfig holds the initial specifications for a rocket type.
 * These are the "design specs" — they don't change during flight.
 * 
 * Example: A "SpaceX Falcon 9" config might have different thrust
 * than a "small hobbyist rocket" config.
 */
export interface RocketConfig {
  name: string; // Name of the rocket (e.g., "Falcon 9", "Starship", "Small Sounding Rocket")
  dryMass: number; // Empty rocket weight (kg)
  fuelMass: number; // How much fuel it starts with (kg)
  engineThrust: number; // Engine power (Newtons) - this is the FORCE it produces
  specificImpulse: number; // How efficient the engine is (Isp - higher = better fuel use)
  throttleResponseTime: number; // How quickly the engine can change thrust (milliseconds)
}

/**
 * SimulationConfig contains all the settings that control how the simulation behaves.
 * These are separate from the rocket — they're about the world (Earth, gravity, etc).
 */
export interface SimulationConfig {
  gravity: number; // Gravity acceleration (m/s²) - Earth is 9.81
  windSpeed: Vector2D; // Wind that affects the rocket (m/s)
  dragCoefficient: number; // How much air resistance the rocket experiences
  rocketRadius: number; // Radius of the rocket body (meters) - used for drag calculations
  timeStep: number; // How often we recalculate physics per second (Hz) - higher = more accurate
}

/**
 * AltitudeGoal represents a milestone the player can try to reach.
 * These are pre-defined targets or custom goals the user sets.
 */
export interface AltitudeGoal {
  name: string; // Name of the goal (e.g., "Kármán Line", "ISS Orbit")
  altitude: number; // Target altitude in meters
  description: string; // What this milestone represents
  isCustom: boolean; // Was this created by the user (true) or pre-defined (false)?
}

/**
 * PhysicsFrame is what we return after each physics update.
 * It contains the new state and any additional info about what happened.
 */
export interface PhysicsFrame {
  state: RocketState; // The updated rocket state
  deltaTime: number; // Time elapsed since last frame (seconds)
  groundImpact: boolean; // Did the rocket hit the ground this frame?
}