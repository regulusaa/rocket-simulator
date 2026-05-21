/**
 * ROCKET SIMULATOR - CONSTANTS
 * ============================
 * Central location for every fixed value used throughout the simulator.
 * Tuning the game world (gravity, thrust, visual scale) means changing values here —
 * no need to hunt through component code.
 *
 * ORGANIZATION:
 *   - World physics
 *   - Rendering / canvas
 *   - Rocket angular controls
 *   - Pre-configured rocket specs (legacy, kept for TrajectoryPanel compat)
 *   - Altitude goals
 *   - UI sizing
 *   - Gameplay thresholds
 *   - Debug flags
 */

import type { RocketConfig, AltitudeGoal } from "../physics/types";
// Import the type definitions so we can create typed constant objects below.

// ─── WORLD PHYSICS ────────────────────────────────────────────────────────────

/**
 * Standard Earth surface gravity (m/s²).
 * This is the constant downward acceleration every object experiences.
 * Real value is 9.80665 m/s²; we round to 9.81 for clarity.
 */
export const GRAVITY = 9.81;

/**
 * Simplified drag coefficient for air resistance calculations.
 * The physics engine uses: dragForce = DRAG_COEFFICIENT * |velocity|.
 * Higher values = rocket slows down faster (more atmospheric drag).
 * Real rockets use a full aerodynamic model, but this simplified version
 * is good enough for gameplay and produces realistic decelerations.
 */
export const DRAG_COEFFICIENT = 0.1;

/**
 * Rocket body radius used in drag calculations (meters).
 * A wider rocket presents more cross-section to the airstream, causing more drag.
 * This is a fixed approximation — real rockets have varying cross-section with altitude.
 */
export const ROCKET_RADIUS = 0.5;

/**
 * Physics target update rate (Hz).
 * 60 means we aim to calculate physics 60 times per second.
 * Each tick: Δt = 1/60 ≈ 0.0167 s.
 * Higher values improve accuracy but require more CPU.
 */
export const PHYSICS_TICK_RATE = 60;

/**
 * Ambient wind speed vector (m/s).
 * x = horizontal wind (positive = blowing rightward, pushing rocket right).
 * y = vertical wind (positive = upward updraft, slightly increases altitude gain).
 *
 * NOTE: Changed from {x:0, y:0} to add a light horizontal breeze.
 * This ensures the rocket's horizontal steering (A/D keys) is not the ONLY
 * source of lateral motion — real launch pads have 2-10 m/s crosswinds.
 * At 3 m/s, a rocket with TWR ~1.4 will drift only slightly unless corrected.
 */
export const WIND_SPEED = { x: 3, y: 0 };
// 3 m/s horizontal wind: light breeze that nudges the rocket but doesn't
// dominate — the player's steering input is still the primary lateral control.

// ─── RENDERING / CANVAS ────────────────────────────────────────────────────────

/**
 * CANVAS_WIDTH and CANVAS_HEIGHT are LEGACY fallback values kept here so that
 * existing files (TrajectoryPanel.tsx) that still import them don't break.
 *
 * The ACTUAL canvas in RocketSimulator.tsx now fills window.innerWidth × window.innerHeight
 * and listens for resize events. Do NOT use these for new canvas rendering code.
 * Use the canvas element's own .width / .height properties instead.
 */
export const CANVAS_WIDTH = 1000; // px — legacy fallback, NOT the live canvas size
export const CANVAS_HEIGHT = 600; // px — legacy fallback, NOT the live canvas size

/**
 * Pixels per meter — base scale ratio at camera zoom 1.0.
 * 1 real-world meter = PIXELS_PER_METER pixels on screen at zoom=1.
 *
 * A value of 2 means:
 *   - Ground (0 m) to 100 m shows as 200 px of height on screen at zoom 1.
 *   - A 10 m tall rocket body stage is 20 px tall at zoom 1.
 *
 * This is multiplied by camera.zoom before any rendering — the Camera class
 * handles the scaling automatically through worldToScreen().
 */
export const PIXELS_PER_METER = 2;

// ─── ROCKET VISUAL DIMENSIONS (world space, meters) ────────────────────────────
// These are the REAL-WORLD size of the drawn rocket elements.
// Camera.worldLengthToPixels() converts them to pixel sizes at render time.

/** Height of the rocket nose cone in world space (meters). */
export const ROCKET_BODY_HEIGHT = 20; // meters — total body height of one stage segment

/** Width of the rocket body in world space (meters). */
export const ROCKET_BODY_WIDTH = 3; // meters — wider = easier to see at high altitude

/** Height of the nose cone in world space (meters). */
export const ROCKET_NOSE_HEIGHT = 5; // meters — pointed tip above the top stage

/**
 * Flame visual length in world space (meters).
 * Flame grows from FLAME_MIN to FLAME_MAX as throttle increases from 0% to 100%.
 */
export const ROCKET_FLAME_HEIGHT_MIN = 2; // meters at minimum throttle
export const ROCKET_FLAME_HEIGHT_MAX = 20; // meters at full throttle

// ─── ROCKET ANGULAR CONTROL ───────────────────────────────────────────────────
// These constants control how the rocket rotates when the player steers with A/D.

/**
 * How fast angular velocity changes when A or D is held (radians per second²).
 * Higher value = more responsive steering, but also easier to over-rotate.
 * At 1.2 rad/s², after 1 second of holding D the rocket is tilting at 1.2 rad/s,
 * which at MAX_TILT of π/4 ≈ 0.785 rad is a significant lean.
 */
export const ANGULAR_THRUST_RATE = 1.2;

/**
 * Passive angular damping coefficient (applied every frame).
 * The rocket's angular velocity is multiplied by (1 - ANGULAR_DAMPING * deltaTime)
 * each frame, gradually slowing rotation without the player needing to counter-steer.
 * Think of it as aerodynamic stabilization: fins and the airstream slow rotation.
 * At 2.5, angular velocity drops to ~e^(-2.5) ≈ 8% of its value after 1 second.
 */
export const ANGULAR_DAMPING = 2.5;

/**
 * Maximum allowed tilt angle (radians).
 * π/3 = 60° — beyond this the rocket is nearly horizontal, which is unrealistic
 * for a launch vehicle and would confuse the player. We hard-clamp the angle here.
 */
export const MAX_TILT_ANGLE = Math.PI / 3; // 60 degrees maximum tilt from vertical

/**
 * Restoring force when no steering input and not thrusting (radians/s² per radian).
 * Acts like an aerodynamic weathervane: the rocket wants to point straight up
 * when not actively being steered. This prevents infinite tumbling in free-fall.
 * Higher value = more aggressive return to vertical.
 */
export const ANGULAR_RESTORE_RATE = 1.5;

// ─── COLORS ───────────────────────────────────────────────────────────────────

/**
 * Color palette for all rendered elements.
 * Centralized here so changing the visual theme only requires editing this object.
 */
export const COLORS = {
  background: "#0a0e27", // Deep space blue — night sky background
  ground: "#2d5016",     // Dark green — Earth's surface color
  rocket: "#e0e0e0",     // Light gray — rocket body default color
  rocketNose: "#ff4444", // Red nose cone — high-visibility warning color
  flame: "#ff8800",      // Orange flame core — engine exhaust
  velocity: "#00ff00",   // Green velocity vector — traditional "positive" color
  trajectory: "#00ffff", // Cyan trajectory line — stands out against dark background
  text: "#ffffff",       // White text — maximum contrast on dark background
  ui: "#4a6fa5",         // UI accent blue — consistent branding color for panels/borders
};

// ─── GRID (optional visual reference) ─────────────────────────────────────────

/** Spacing between grid lines in pixels (for the optional world-space reference grid). */
export const GRID_SPACING = 100;

/** Color of the reference grid lines (very faint to not distract from the rocket). */
export const GRID_COLOR = "rgba(100, 100, 150, 0.1)";

// ─── LEGACY SINGLE-STAGE ROCKET CONFIGS (kept for backward compatibility) ──────
// These were used in the original single-stage version.
// The simulator now uses ROCKET_SIMPLE_TWO_STAGE, ROCKET_FALCON_9_INSPIRED,
// and ROCKET_THREE_STAGE from MultiStageSystem.ts instead.

/** Small sounding rocket — used in original single-stage system, kept for compat. */
export const ROCKET_SMALL: RocketConfig = {
  name: "Sounding Rocket",
  dryMass: 50,                // kg — very light empty structure
  fuelMass: 100,              // kg — moderate fuel load
  engineThrust: 50000,        // N — enough thrust for small TWR
  specificImpulse: 200,       // s — modest engine efficiency
  throttleResponseTime: 100,  // ms — fast response time
};

/** Medium rocket approximately inspired by Falcon 9 — single-stage legacy config. */
export const ROCKET_MEDIUM: RocketConfig = {
  name: "Falcon 9 (approx)",
  dryMass: 29000,             // kg — large structural mass
  fuelMass: 111500,           // kg — significant propellant
  engineThrust: 1522000,      // N — ~1.5 MN (single Merlin equivalent)
  specificImpulse: 282,       // s — Merlin sea-level Isp
  throttleResponseTime: 200,  // ms — slightly slower response for large engine
};

/** High-efficiency experimental rocket — single-stage legacy config. */
export const ROCKET_LARGE: RocketConfig = {
  name: "Experimental High-Isp",
  dryMass: 500,               // kg — lightweight structure
  fuelMass: 2500,             // kg — moderate fuel
  engineThrust: 200000,       // N — medium thrust
  specificImpulse: 350,       // s — very efficient (ion or advanced chemical)
  throttleResponseTime: 150,  // ms
};

/** All legacy single-stage rockets available for selection. */
export const AVAILABLE_ROCKETS = [ROCKET_SMALL, ROCKET_MEDIUM, ROCKET_LARGE];

// ─── ALTITUDE GOALS ───────────────────────────────────────────────────────────
// Pre-defined target altitudes players can aim for.
// Each corresponds to a real rocketry milestone to make the game educational.

export const ALTITUDE_GOALS: AltitudeGoal[] = [
  {
    name: "Kármán Line",
    altitude: 100000,        // 100 km — internationally recognized start of space
    description: "The officially recognized boundary of outer space (100 km)",
    isCustom: false,
  },
  {
    name: "ISS Orbit",
    altitude: 408000,        // 408 km — International Space Station's orbital altitude
    description: "Reach the altitude of the International Space Station",
    isCustom: false,
  },
  {
    name: "Geostationary Orbit",
    altitude: 35786000,      // 35,786 km — geostationary orbit where satellites hover stationary
    description: "Altitude where a satellite orbits once per Earth rotation",
    isCustom: false,
  },
  {
    name: "Moon Distance",
    altitude: 384400000,     // 384,400 km — average Earth-to-Moon distance
    description: "Travel the distance to the Moon from Earth",
    isCustom: false,
  },
  {
    name: "1 km",
    altitude: 1000,          // 1 km — entry-level goal for new players
    description: "Beginner goal: reach 1 kilometer altitude",
    isCustom: false,
  },
  {
    name: "10 km",
    altitude: 10000,         // 10 km — higher than most clouds and weather balloons
    description: "Higher than commercial airplane cruising altitude",
    isCustom: false,
  },
  {
    name: "50 km",
    altitude: 50000,         // 50 km — mesosphere, where meteors burn up
    description: "Upper atmosphere — above weather, below the Kármán Line",
    isCustom: false,
  },
];

// ─── UI CONFIGURATION ─────────────────────────────────────────────────────────

/** Large heading text size in pixels. */
export const FONT_SIZE_LARGE = 24;

/** Medium text size used for panel titles and important readouts. */
export const FONT_SIZE_MEDIUM = 18;

/** Small text size used for individual telemetry lines and labels. */
export const FONT_SIZE_SMALL = 14;

/** Width of the telemetry information panel (bottom-right canvas overlay) in pixels. */
export const INFO_PANEL_WIDTH = 280;

/** Height of the telemetry information panel in pixels. */
export const INFO_PANEL_HEIGHT = 350;

/** Gap between the panel edge and the canvas edge in pixels. */
export const INFO_PANEL_MARGIN = 20;

/** Width of the mini trajectory preview panel in pixels. */
export const TRAJECTORY_PANEL_WIDTH = 250;

/** Height of the mini trajectory preview panel in pixels. */
export const TRAJECTORY_PANEL_HEIGHT = 250;

// ─── GAMEPLAY THRESHOLDS ──────────────────────────────────────────────────────

/** Landing velocity below which the touchdown is classified as "SOFT" (m/s). */
export const LANDING_VELOCITY_SAFE = 5;

/** Landing velocity below which the touchdown is "ACCEPTABLE" but not ideal (m/s). */
export const LANDING_VELOCITY_ACCEPTABLE = 20;

/** Landing velocity above which the rocket is likely destroyed on impact (m/s). */
export const LANDING_VELOCITY_CRASH = 40;

/**
 * Throttle ramp-up rate (% per second).
 * When the player holds SPACEBAR, throttle increases at this rate.
 * 50 %/s means it takes 2 full seconds to go from 0% → 100% throttle.
 * This "throttle response time" mirrors real rocket engine spooling behavior
 * and prevents the rocket from instantly hitting full thrust (which caused it
 * to fly off screen in 2-3 seconds with the old instant-throttle system).
 */
export const THROTTLE_INCREASE_RATE = 50; // %/s — gradual ramp-up over 2 seconds

/**
 * Throttle ramp-down rate (% per second).
 * When SPACEBAR is released, throttle decreases at this faster rate.
 * 100 %/s means it takes 1 second to go from 100% → 0% (engines spool down).
 * Faster than ramp-up to allow the player to cut thrust quickly for control.
 */
export const THROTTLE_DECREASE_RATE = 100; // %/s — faster spool-down for control

/**
 * Throttle burst amount (%) added by a single click (mouse / canvas tap).
 * Only 30% instead of 100% for a brief controlled pulse, not an instant full burn.
 * Allows precise short burns without committing to sustained full throttle.
 */
export const THROTTLE_BURST_AMOUNT = 30; // % added per click (gentler than before)

/**
 * Minimum altitude (meters) for the rocket to be considered "in flight".
 * Prevents floating-point noise near y=0 from registering as a launch.
 */
export const MIN_FLYING_ALTITUDE = 1;

// ─── DEBUG FLAGS ──────────────────────────────────────────────────────────────

/**
 * Master debug flag. When true, performance stats panel is visible by default.
 * Set to false for release builds.
 */
export const DEBUG_MODE = false;

/** Draw physics vectors (velocity arrow, acceleration arrow) when true. */
export const SHOW_PHYSICS_VECTORS = false;

/** Draw the world-space reference grid when true. */
export const SHOW_GRID = false;

/**
 * Global time scale multiplier for slow-motion debugging.
 * 1.0 = normal speed.  0.25 = quarter speed (useful for watching stage separation).
 * Note: this is a static developer override, separate from the player's time controls.
 */
export const DEBUG_TIME_SCALE = 1.0;
