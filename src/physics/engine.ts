/**
 * ROCKET SIMULATOR - PHYSICS ENGINE (MULTI-STAGE + RK4 VERSION)
 * ===================================================================
 * Core physics simulation: forces, kinematics, staging, and angular motion.
 *
 * NEW IN THIS VERSION:
 *   - Deterministic Runge-Kutta 4th Order (RK4) integrator for high precision.
 *   - US Standard Atmosphere 1976 integration (dynamic density, temp, pressure).
 *   - Aerodynamics: Mach-dependent drag coefficient (Cd) and dynamic pressure (Q).
 *   - Gravity Turn (Pitch Program) for automated orbital ascent profiles.
 *   - Dynamic mass updates as fuel burns.
 */

import type { Vector2D, SimulationConfig } from "./types";
import { getAirDensity, getMachNumber, getDragCoefficient } from "./AtmosphereModel";
import type { MultiStageRocketConfig } from "./MultiStageSystem";
import {
  calculateTotalMass,
  calculateTotalThrust,
  applyMultiStageThrottle,
  checkAndPerformStaging,
  consumeFuel,
  resetAllStages,
} from "./MultiStageSystem";
import {
  ANGULAR_THRUST_RATE,
  ANGULAR_DAMPING,
  MAX_TILT_ANGLE,
  ANGULAR_RESTORE_RATE,
} from "../utils/constants";

// ─── STATE TYPE ───────────────────────────────────────────────────────────────

export interface MultiStageRocketState {
  position: Vector2D;
  velocity: Vector2D;
  acceleration: Vector2D;
  angle: number;
  angularVelocity: number;
  isFlying: boolean;
  hasLanded: boolean;
  landingVelocity: number;
  maxAltitudeReached: number;
  timeElapsed: number;
  activeStageNumber: number;
  stageSeparationCount: number;
  didStageSeperateThisFrame: boolean;
  // Auto-fly / Pitch Program state
  autoPitchTarget: number;
}

export interface MultiStagePhysicsFrame {
  state: MultiStageRocketState;
  deltaTime: number;
  groundImpact: boolean;
}

// ─── FACTORY ──────────────────────────────────────────────────────────────────

export function createMultiStageRocket(
  _config: MultiStageRocketConfig
): MultiStageRocketState {
  return {
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    acceleration: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    isFlying: false,
    hasLanded: false,
    landingVelocity: 0,
    maxAltitudeReached: 0,
    timeElapsed: 0,
    activeStageNumber: 0,
    stageSeparationCount: 0,
    didStageSeperateThisFrame: false,
    autoPitchTarget: 0,
  };
}

// ─── CONTROLS ─────────────────────────────────────────────────────────────────

export function applyControls(
  config: MultiStageRocketConfig,
  state: MultiStageRocketState,
  holdingThrottle: boolean,
  clickThrottle: boolean,
  tiltLeft: boolean,
  tiltRight: boolean,
  deltaTime: number,
  autoFlyEnabled: boolean = false
): void {
  applyMultiStageThrottle(config, holdingThrottle, clickThrottle, deltaTime);

  if (!state.isFlying) return;

  if (autoFlyEnabled) {
    // Pitch Program / Gravity Turn logic.
    // Basic PD controller to align the rocket's angle with the target pitch.
    const error = state.autoPitchTarget - state.angle;
    const pGain = 1.0;
    const dGain = 0.5;
    const control = pGain * error - dGain * state.angularVelocity;
    
    // Clamp the control input to our max turn rate
    const maxControl = ANGULAR_THRUST_RATE;
    const clampedControl = Math.max(-maxControl, Math.min(maxControl, control));
    
    state.angularVelocity += clampedControl * deltaTime;
  } else {
    // Manual steering
    if (tiltLeft) {
      state.angularVelocity -= ANGULAR_THRUST_RATE * deltaTime;
    }
    if (tiltRight) {
      state.angularVelocity += ANGULAR_THRUST_RATE * deltaTime;
    }
  }
}

// ─── PITCH PROGRAM ────────────────────────────────────────────────────────────

/**
 * Calculates the target pitch angle for a basic gravity turn.
 * @param altitude Current altitude in meters.
 * @param velocity Current velocity in m/s.
 * @param currentAngle Current tilt angle in radians.
 * @returns Target pitch angle in radians.
 */
export function calculateGravityTurnAngle(
  altitude: number, 
  velocity: Vector2D, 
  currentAngle: number
): number {
  const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
  
  // Tower clearance / Initial vertical climb
  if (altitude < 200 || speed < 40) {
    return 0; // Keep straight up
  }
  
  // Initial pitch kick (start turning slightly downrange)
  if (altitude < 1000) {
    return 0.05; // Small initial tilt (~3 degrees)
  }

  // Pure gravity turn: follow the velocity vector (prograde)
  // Angle of the velocity vector from vertical
  if (speed > 10) {
    const progradeAngle = Math.atan2(velocity.x, velocity.y);
    // Limit how far we can deviate from vertical to avoid tumbling or extreme steering
    return Math.max(-MAX_TILT_ANGLE, Math.min(MAX_TILT_ANGLE, progradeAngle));
  }
  
  return currentAngle;
}


// ─── RK4 DERIVATIVE HELPER ────────────────────────────────────────────────────

interface RK4State {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  omega: number;
}

interface RK4Derivative {
  dx: number;
  dy: number;
  dvx: number;
  dvy: number;
  dAngle: number;
  dOmega: number;
}

/**
 * Pure function to evaluate physics derivatives at a given state.
 */
function computeDerivatives(
  s: RK4State,
  totalMass: number,
  totalThrust: number,
  simConfig: SimulationConfig,
  isFlying: boolean
): RK4Derivative {
  let ax = 0;
  let ay = 0;
  let alpha = 0;

  // 1. GRAVITY
  const EARTH_RADIUS = 6_371_000;
  const altitude = Math.max(0, s.y);
  const gravityAtAltitude = simConfig.gravity * Math.pow(EARTH_RADIUS / (EARTH_RADIUS + altitude), 2);
  ay -= gravityAtAltitude;

  // 2. THRUST
  if (totalThrust > 0) {
    ax += (Math.sin(s.angle) * totalThrust) / totalMass;
    ay += (Math.cos(s.angle) * totalThrust) / totalMass;
  }

  // 3. AERODYNAMIC DRAG
  const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
  if (speed > 0) {
    const rho = getAirDensity(altitude);
    const mach = getMachNumber(speed, altitude);
    const cd = getDragCoefficient(mach);
    const area = Math.PI * simConfig.rocketRadius * simConfig.rocketRadius;
    
    // F_drag = 0.5 * rho * v^2 * Cd * A
    const dragForce = 0.5 * rho * speed * speed * cd * area;
    const dragAccel = dragForce / totalMass;
    
    // Oppose velocity
    ax -= dragAccel * (s.vx / speed);
    ay -= dragAccel * (s.vy / speed);
  }

  // 4. WIND
  if (simConfig.windSpeed.x !== 0) {
    const windForce = simConfig.windSpeed.x * 1000;
    ax += windForce / totalMass;
  }

  // 5. GROUND CONSTRAINT (Pre-launch)
  if (s.y <= 0 && !isFlying) {
    if (ay < 0) ay = 0; // Normal force cancels downward acceleration
    ax = 0; // Launch clamps
  }

  // 6. ANGULAR DYNAMICS
  // We approximate the damping and restore as continuous angular accelerations.
  alpha -= ANGULAR_DAMPING * s.omega;
  
  if (isFlying) {
    alpha -= ANGULAR_RESTORE_RATE * s.angle;
  }

  return {
    dx: s.vx,
    dy: s.vy,
    dvx: ax,
    dvy: ay,
    dAngle: s.omega,
    dOmega: alpha
  };
}

// ─── PHYSICS UPDATE ───────────────────────────────────────────────────────────

export function updatePhysics(
  state: MultiStageRocketState,
  config: MultiStageRocketConfig,
  simConfig: SimulationConfig,
  deltaTime: number
): MultiStagePhysicsFrame {
  let groundImpact = false;

  // Staging Check
  const stagingSeparated = checkAndPerformStaging(config);
  state.didStageSeperateThisFrame = stagingSeparated;
  if (stagingSeparated) {
    state.stageSeparationCount++;
    for (let i = 0; i < config.stages.length; i++) {
      if (config.stages[i].isActive) {
        state.activeStageNumber = i;
        break;
      }
    }
  }

  const totalMass = calculateTotalMass(config);
  const totalThrust = calculateTotalThrust(config);

  // Pitch Program update
  if (state.isFlying) {
    state.autoPitchTarget = calculateGravityTurnAngle(state.position.y, state.velocity, state.angle);
  }

  // ── RK4 INTEGRATION ──
  
  const y0: RK4State = {
    x: state.position.x,
    y: state.position.y,
    vx: state.velocity.x,
    vy: state.velocity.y,
    angle: state.angle,
    omega: state.angularVelocity
  };

  const dt = deltaTime;
  const isFlying = state.isFlying;

  // k1
  const k1 = computeDerivatives(y0, totalMass, totalThrust, simConfig, isFlying);
  
  // k2
  const y2: RK4State = {
    x: y0.x + k1.dx * dt * 0.5,
    y: y0.y + k1.dy * dt * 0.5,
    vx: y0.vx + k1.dvx * dt * 0.5,
    vy: y0.vy + k1.dvy * dt * 0.5,
    angle: y0.angle + k1.dAngle * dt * 0.5,
    omega: y0.omega + k1.dOmega * dt * 0.5
  };
  const k2 = computeDerivatives(y2, totalMass, totalThrust, simConfig, isFlying);

  // k3
  const y3: RK4State = {
    x: y0.x + k2.dx * dt * 0.5,
    y: y0.y + k2.dy * dt * 0.5,
    vx: y0.vx + k2.dvx * dt * 0.5,
    vy: y0.vy + k2.dvy * dt * 0.5,
    angle: y0.angle + k2.dAngle * dt * 0.5,
    omega: y0.omega + k2.dOmega * dt * 0.5
  };
  const k3 = computeDerivatives(y3, totalMass, totalThrust, simConfig, isFlying);

  // k4
  const y4: RK4State = {
    x: y0.x + k3.dx * dt,
    y: y0.y + k3.dy * dt,
    vx: y0.vx + k3.dvx * dt,
    vy: y0.vy + k3.dvy * dt,
    angle: y0.angle + k3.dAngle * dt,
    omega: y0.omega + k3.dOmega * dt
  };
  const k4 = computeDerivatives(y4, totalMass, totalThrust, simConfig, isFlying);

  // Combine
  state.position.x += (dt / 6) * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx);
  state.position.y += (dt / 6) * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy);
  state.velocity.x += (dt / 6) * (k1.dvx + 2 * k2.dvx + 2 * k3.dvx + k4.dvx);
  state.velocity.y += (dt / 6) * (k1.dvy + 2 * k2.dvy + 2 * k3.dvy + k4.dvy);
  state.angle += (dt / 6) * (k1.dAngle + 2 * k2.dAngle + 2 * k3.dAngle + k4.dAngle);
  state.angularVelocity += (dt / 6) * (k1.dOmega + 2 * k2.dOmega + 2 * k3.dOmega + k4.dOmega);

  // Store final acceleration (approximate, using k1) for UI purposes
  state.acceleration.x = k1.dvx;
  state.acceleration.y = k1.dvy;

  // ── POST-INTEGRATION CONSTRAINTS ──

  consumeFuel(config, deltaTime);

  if (state.position.y > 1 && !state.isFlying) {
    state.isFlying = true;
  }

  // Ground collision
  if (state.position.y <= 0 && state.isFlying) {
    state.position.y = 0;
    state.landingVelocity = state.velocity.y;
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.angularVelocity = 0;
    state.isFlying = false;
    state.hasLanded = true;
    groundImpact = true;
  }

  // Launch pad constraints (if we drifted into ground before flying)
  if (state.position.y <= 0 && !state.isFlying) {
    state.position.y = 0;
    if (state.velocity.y < 0) state.velocity.y = 0;
    if (state.acceleration.y < 0) state.acceleration.y = 0;
    state.velocity.x = 0;
    state.acceleration.x = 0;
    state.angle = 0;
    state.angularVelocity = 0;
  }

  // Angle constraints
  state.angle = Math.max(-MAX_TILT_ANGLE, Math.min(MAX_TILT_ANGLE, state.angle));

  if (state.position.y > state.maxAltitudeReached) {
    state.maxAltitudeReached = state.position.y;
  }

  state.timeElapsed += deltaTime;

  return {
    state,
    deltaTime,
    groundImpact,
  };
}

// ─── RESET ────────────────────────────────────────────────────────────────────

export function resetRocket(
  state: MultiStageRocketState,
  config: MultiStageRocketConfig
): void {
  state.position.x = 0;
  state.position.y = 0;
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.acceleration.x = 0;
  state.acceleration.y = 0;
  state.angle = 0;
  state.angularVelocity = 0;
  state.isFlying = false;
  state.hasLanded = false;
  state.landingVelocity = 0;
  state.maxAltitudeReached = 0;
  state.timeElapsed = 0;
  state.activeStageNumber = 0;
  state.stageSeparationCount = 0;
  state.didStageSeperateThisFrame = false;
  state.autoPitchTarget = 0;

  resetAllStages(config);
}

// ─── LANDING SCORE ────────────────────────────────────────────────────────────

export function calculateLandingScore(landingVelocity: number): number {
  const speed = Math.abs(landingVelocity);
  if (speed < 5)  return 100;
  if (speed < 10) return 80;
  if (speed < 20) return 60;
  if (speed < 40) return 30;
  return 0;
}

// ─── FUEL STATUS QUERY ────────────────────────────────────────────────────────

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
    fuelPercent: (stage.fuelMass / stage.fuelCapacity) * 100,
    isSeparated: stage.isSeparated,
    isActive: stage.isActive,
  }));
}
