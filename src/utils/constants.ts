/**
 * ROCKET SIMULATOR - CONSTANTS
 * ============================
 * This file contains all the fixed values and default configurations used throughout
 * the simulator. These are things that don't change during a simulation run but define
 * how the world works and what rockets are available.
 * 
 * By putting these in one place, we can easily tune the game balance without searching
 * through code. Want gravity to be weaker? Change one number here.
 */

import type { RocketConfig, AltitudeGoal } from "../physics/types";

/**
 * WORLD CONFIGURATION
 * What the Earth is like in our simulation
 */

// Standard Earth gravity acceleration (m/s²)
// This is how fast objects accelerate downward due to gravity
// Real Earth: 9.81 m/s², we use the same
export const GRAVITY = 9.81;

// How much air resistance affects the rocket
// Higher number = more drag = slower max velocity
// This is simplified (not a full aerodynamic model) but works well for gameplay
export const DRAG_COEFFICIENT = 0.1;

// Rocket body radius used for drag calculations (meters)
// Affects how much the rocket is slowed by air resistance
export const ROCKET_RADIUS = 0.5;

// How often the physics engine updates per second (Hz)
// Higher = more accurate but more CPU intensive
// 60 = 60 updates per second (standard for smooth 60 FPS)
// Each frame: deltaTime = 1/60 ≈ 0.0167 seconds
export const PHYSICS_TICK_RATE = 60;

// Wind speed and direction (m/s)
// x = horizontal wind (positive = right)
// y = vertical wind (positive = up)
// Currently no wind, but we support it in the physics engine
export const WIND_SPEED = { x: 0, y: 0 };

/**
 * RENDERING CONFIGURATION
 * How the canvas displays the rocket and world
 */

// Canvas dimensions (pixels)
export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 600;

// Ground level in pixels (where the rocket starts)
// We use pixels on screen, but physics uses meters
// This conversion factor tells us: 1 meter in the world = ? pixels on screen
export const PIXELS_PER_METER = 2; // 1 meter of altitude = 2 pixels tall

// Rocket visual properties (in pixels)
export const ROCKET_BODY_HEIGHT = 40; // How tall the rocket looks
export const ROCKET_BODY_WIDTH = 15; // How wide the rocket body is
export const ROCKET_NOSE_HEIGHT = 20; // How tall the pointed nose is
export const ROCKET_FLAME_HEIGHT_MIN = 10; // Minimum flame length when thrusting
export const ROCKET_FLAME_HEIGHT_MAX = 60; // Maximum flame length at full thrust

// Colors used in rendering
export const COLORS = {
  background: "#0a0e27", // Dark space blue
  ground: "#2d5016", // Dark green ground
  rocket: "#e0e0e0", // Light gray rocket body
  rocketNose: "#ff4444", // Red rocket nose
  flame: "#ff8800", // Orange flame
  velocity: "#00ff00", // Green velocity vector
  trajectory: "#00ffff", // Cyan trajectory line
  text: "#ffffff", // White text
  ui: "#4a6fa5", // UI blue (Caulrion theme)
};

// Grid for visual reference (optional, can be turned on/off)
export const GRID_SPACING = 100; // Pixels between grid lines
export const GRID_COLOR = "rgba(100, 100, 150, 0.1)"; // Faint blue grid

/**
 * PRE-CONFIGURED ROCKET MODELS
 * Different rocket types players can choose from
 */

// A small experimental rocket (good for learning)
export const ROCKET_SMALL: RocketConfig = {
  name: "Sounding Rocket",
  dryMass: 50, // kg (empty rocket weight)
  fuelMass: 100, // kg (fuel capacity)
  engineThrust: 50000, // Newtons (thrust force)
  // Specific impulse: how efficient the engine is
  // Higher Isp = same fuel lasts longer = further you can go
  // Real rocket engines range from 150-400 seconds
  specificImpulse: 200, // seconds
  throttleResponseTime: 100, // milliseconds to go from 0% to 100% thrust
};

// Medium rocket (realistic performance)
export const ROCKET_MEDIUM: RocketConfig = {
  name: "Falcon 9 (approx)",
  dryMass: 29000, // kg
  fuelMass: 111500, // kg
  engineThrust: 1522000, // Newtons (Merlin engine ~1.5 MN)
  specificImpulse: 282, // seconds (Merlin vacuum Isp)
  throttleResponseTime: 200,
};

// Large high-efficiency rocket
export const ROCKET_LARGE: RocketConfig = {
  name: "Experimental High-Isp",
  dryMass: 500, // kg
  fuelMass: 2500, // kg
  engineThrust: 200000, // Newtons
  specificImpulse: 350, // seconds (very efficient engine)
  throttleResponseTime: 150,
};

// Collection of all available rockets
// Player can select from this list
export const AVAILABLE_ROCKETS = [ROCKET_SMALL, ROCKET_MEDIUM, ROCKET_LARGE];

/**
 * ALTITUDE GOALS
 * Pre-defined targets for players to aim for
 * Each represents a real-world milestone in rocketry
 */

export const ALTITUDE_GOALS: AltitudeGoal[] = [
  {
    name: "Kármán Line",
    altitude: 100000, // 100 km - official boundary of space
    description: "The internationally recognized edge of space (100 km altitude)",
    isCustom: false,
  },
  {
    name: "ISS Orbit",
    altitude: 408000, // 408 km - International Space Station
    description: "Reach the altitude of the International Space Station",
    isCustom: false,
  },
  {
    name: "Geostationary Orbit",
    altitude: 35786000, // 35,786 km
    description: "Reach geostationary orbit altitude (satellites that stay over one spot)",
    isCustom: false,
  },
  {
    name: "Moon Distance",
    altitude: 384400000, // 384,400 km - average Earth-Moon distance
    description: "Reach the distance to the Moon from Earth",
    isCustom: false,
  },
  {
    name: "1 km",
    altitude: 1000,
    description: "Simple starter goal: reach 1 kilometer altitude",
    isCustom: false,
  },
  {
    name: "10 km",
    altitude: 10000,
    description: "Higher than commercial airliners",
    isCustom: false,
  },
  {
    name: "50 km",
    altitude: 50000,
    description: "Upper atmosphere, where aurora happens",
    isCustom: false,
  },
];

/**
 * UI CONFIGURATION
 * How the user interface looks and behaves
 */

// Font sizes (pixels)
export const FONT_SIZE_LARGE = 24;
export const FONT_SIZE_MEDIUM = 18;
export const FONT_SIZE_SMALL = 14;

// Panel dimensions (info display bottom right)
export const INFO_PANEL_WIDTH = 280;
export const INFO_PANEL_HEIGHT = 350;
export const INFO_PANEL_MARGIN = 20; // Space from edge

// Trajectory preview panel
export const TRAJECTORY_PANEL_WIDTH = 250;
export const TRAJECTORY_PANEL_HEIGHT = 250;

/**
 * GAMEPLAY CONFIGURATION
 * How the game mechanics work
 */

// Landing quality thresholds (m/s - velocity when hitting ground)
export const LANDING_VELOCITY_SAFE = 5; // Soft landing
export const LANDING_VELOCITY_ACCEPTABLE = 20; // Hard but survivable
export const LANDING_VELOCITY_CRASH = 40; // Rocket probably destroyed

// Control sensitivity
// How responsive the throttle is to player input
export const THROTTLE_INCREASE_RATE = 2; // % per frame
export const THROTTLE_DECREASE_RATE = 2; // % per frame
export const THROTTLE_BURST_AMOUNT = 10; // % added per click

// Minimum altitude to register as "flying"
// Prevents rocket from being marked as flying due to floating point errors
export const MIN_FLYING_ALTITUDE = 1; // meters

/**
 * DEBUG/DEVELOPMENT
 * Flags and settings for development and debugging
 */

// Show debug information on screen?
export const DEBUG_MODE = false;

// Draw physics vectors (velocity, acceleration)?
export const SHOW_PHYSICS_VECTORS = false;

// Draw grid reference?
export const SHOW_GRID = false;

// Slow motion for testing
export const DEBUG_TIME_SCALE = 1.0; // 1.0 = normal speed, 0.5 = half speed