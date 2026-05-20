/**
 * ROCKET SIMULATOR - MAIN COMPONENT
 * =================================
 * This is the main React component that brings everything together.
 * It handles:
 * - Rendering the canvas (where the rocket and world are drawn)
 * - Running the game loop (physics updates every frame)
 * - Handling player input (spacebar and mouse clicks)
 * - Displaying UI (altitude, velocity, fuel, goals)
 * - Managing state (rocket status, goals, etc.)
 * 
 * Think of this as the "conductor" that orchestrates all the other pieces.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  createRocket,
  updatePhysics,
  resetRocket,
  applyControls,
  calculateLandingScore,
} from "../physics/engine";
import type { RocketState, RocketConfig, AltitudeGoal } from "../physics/types";
import {
  GRAVITY,
  DRAG_COEFFICIENT,
  ROCKET_RADIUS,
  PHYSICS_TICK_RATE,
  WIND_SPEED,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  PIXELS_PER_METER,
  ROCKET_BODY_HEIGHT,
  ROCKET_BODY_WIDTH,
  ROCKET_NOSE_HEIGHT,
  ROCKET_FLAME_HEIGHT_MIN,
  ROCKET_FLAME_HEIGHT_MAX,
  COLORS,
  ROCKET_SMALL,
  AVAILABLE_ROCKETS,
  ALTITUDE_GOALS,
  INFO_PANEL_WIDTH,
  INFO_PANEL_HEIGHT,
  INFO_PANEL_MARGIN,
  FONT_SIZE_LARGE,
  FONT_SIZE_MEDIUM,
  FONT_SIZE_SMALL,
  DEBUG_MODE,
} from "../utils/constants";

/**
 * Main RocketSimulator component
 * This React component handles the entire simulator
 */
export const RocketSimulator: React.FC = () => {
  // === REFS (persistent across renders) ===

  // Reference to the canvas element (where we draw)
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Reference to the animation frame ID (so we can cancel it on cleanup)
  const animationFrameRef = useRef<number | null>(null);

  // Track which keys are pressed (for smooth continuous input)
  const keysPressed = useRef<{ [key: string]: boolean }>({});

  // === STATE (triggers re-renders when changed) ===

  // The current rocket state (position, velocity, fuel, etc.)
  const [rocketState, setRocketState] = useState<RocketState>(() =>
    createRocket(ROCKET_SMALL)
  );

  // The rocket configuration (specs like thrust, mass)
  const [rocketConfig, setRocketConfig] = useState<RocketConfig>(ROCKET_SMALL);

  // Currently selected altitude goal (what the player is trying to reach)
  const [selectedGoal, setSelectedGoal] = useState<AltitudeGoal | null>(
    ALTITUDE_GOALS[0]
  );

  // Custom altitude goal entered by user
  const [customGoalAltitude, setCustomGoalAltitude] = useState<number | null>(
    null
  );

  // Landing score (only set after rocket lands)
  const [landingScore, setLandingScore] = useState<number | null>(null);

  // Should fullscreen trajectory be shown?
  const [showFullscreenTrajectory, setShowFullscreenTrajectory] =
    useState(false);

  // === EVENT HANDLERS ===

  /**
   * Handle when a key is pressed down.
   * We record which key so we can check it every frame in the game loop.
   */
  const handleKeyDown = (e: KeyboardEvent) => {
    // Record that this key is pressed
    keysPressed.current[e.key.toLowerCase()] = true;

    // Spacebar launches the rocket (sets isFlying to true if on ground)
    if (e.key === " ") {
      e.preventDefault(); // Prevent page scroll
    }
  };

  /**
   * Handle when a key is released.
   * We stop recording it as pressed.
   */
  const handleKeyUp = (e: KeyboardEvent) => {
    keysPressed.current[e.key.toLowerCase()] = false;
  };

  /**
   * Handle mouse click on canvas for thrust bursts.
   */
  const handleCanvasClick = () => {
    // We handle click thrust in the game loop by setting a flag
    // This is set to true, then immediately set to false after one frame
    keysPressed.current["mouseClick"] = true;
  };

  /**
   * Handle selecting a different rocket from the dropdown.
   */
  const handleRocketChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedName = e.target.value;
    const rocket = AVAILABLE_ROCKETS.find((r) => r.name === selectedName);

    if (rocket) {
      // Create a new rocket with the selected config
      const newState = createRocket(rocket);
      setRocketState(newState);
      setRocketConfig(rocket);
      // Reset score when switching rockets
      setLandingScore(null);
    }
  };

  /**
   * Handle selecting a pre-defined goal.
   */
  const handleGoalChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const goalName = e.target.value;
    const goal = ALTITUDE_GOALS.find((g) => g.name === goalName);
    if (goal) {
      setSelectedGoal(goal);
      setCustomGoalAltitude(null);
    }
  };

  /**
   * Handle custom goal altitude input.
   */
  const handleCustomGoal = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "") {
      setCustomGoalAltitude(null);
      setSelectedGoal(ALTITUDE_GOALS[0]);
    } else {
      const altitude = parseFloat(value);
      if (!isNaN(altitude) && altitude > 0) {
        setCustomGoalAltitude(altitude);
        // Keep selected goal as null to indicate custom
        setSelectedGoal(null);
      }
    }
  };

  /**
   * Reset the rocket for another flight.
   */
  const handleReset = () => {
    resetRocket(rocketState, rocketConfig);
    setRocketState({ ...rocketState }); // Trigger re-render
    setLandingScore(null);
    setShowFullscreenTrajectory(false);
  };

  // === DRAWING FUNCTIONS ===

  /**
   * Draw the ground at the bottom of the canvas.
   */
  const drawGround = (ctx: CanvasRenderingContext2D) => {
    // Ground is a simple rectangle at the bottom
    const groundY = CANVAS_HEIGHT - 20; // Leave some margin at bottom

    // Fill ground
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, groundY, CANVAS_WIDTH, 20);

    // Draw a border on top of ground
    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(CANVAS_WIDTH, groundY);
    ctx.stroke();
  };

  /**
   * Draw the rocket on the canvas.
   * The rocket consists of: body (cylinder), nose (cone), and flame (if thrusting).
   */
  const drawRocket = (ctx: CanvasRenderingContext2D, state: RocketState) => {
    // Convert world coordinates (meters) to screen coordinates (pixels)
    // The rocket is at position.x (horizontal) and position.y (altitude)
    // We need to flip Y because canvas has Y=0 at top, but we want Y=0 at bottom
    const screenX = (CANVAS_WIDTH / 2) + (state.position.x * PIXELS_PER_METER);
    const screenY = CANVAS_HEIGHT - 20 - (state.position.y * PIXELS_PER_METER);

    // === DRAW ROCKET BODY ===
    ctx.fillStyle = COLORS.rocket;
    ctx.fillRect(
      screenX - ROCKET_BODY_WIDTH / 2,
      screenY,
      ROCKET_BODY_WIDTH,
      ROCKET_BODY_HEIGHT
    );

    // === DRAW ROCKET NOSE (pointed tip) ===
    ctx.fillStyle = COLORS.rocketNose;
    ctx.beginPath();
    // Draw a triangle pointing up for the nose cone
    ctx.moveTo(screenX, screenY - ROCKET_NOSE_HEIGHT); // Top point
    ctx.lineTo(screenX - ROCKET_BODY_WIDTH / 2, screenY); // Bottom left
    ctx.lineTo(screenX + ROCKET_BODY_WIDTH / 2, screenY); // Bottom right
    ctx.closePath();
    ctx.fill();

    // === DRAW THRUST FLAME (if thrusting) ===
    if (state.isThrusting && state.fuelMass > 0) {
      // Calculate flame height based on throttle percentage
      // Higher throttle = longer flame
      const flameHeight =
        ROCKET_FLAME_HEIGHT_MIN +
        ((ROCKET_FLAME_HEIGHT_MAX - ROCKET_FLAME_HEIGHT_MIN) *
          (state.thrustPercentage / 100));

      // Draw flame (orange/yellow gradient effect)
      ctx.fillStyle = COLORS.flame;
      ctx.beginPath();
      // Draw flame as a triangle below the rocket
      ctx.moveTo(screenX, screenY + ROCKET_BODY_HEIGHT); // Bottom of rocket
      ctx.lineTo(screenX - ROCKET_BODY_WIDTH / 1.5, screenY + ROCKET_BODY_HEIGHT + flameHeight); // Bottom left
      ctx.lineTo(screenX + ROCKET_BODY_WIDTH / 1.5, screenY + ROCKET_BODY_HEIGHT + flameHeight); // Bottom right
      ctx.closePath();
      ctx.fill();

      // Draw inner flame (brighter, smaller)
      ctx.fillStyle = "rgba(255, 200, 0, 0.7)"; // Yellow/white
      ctx.beginPath();
      ctx.moveTo(screenX, screenY + ROCKET_BODY_HEIGHT);
      ctx.lineTo(screenX - ROCKET_BODY_WIDTH / 2.5, screenY + ROCKET_BODY_HEIGHT + flameHeight * 0.6);
      ctx.lineTo(screenX + ROCKET_BODY_WIDTH / 2.5, screenY + ROCKET_BODY_HEIGHT + flameHeight * 0.6);
      ctx.closePath();
      ctx.fill();
    }

    // === DRAW LANDING LEGS (visual only, on ground) ===
    if (state.position.y <= 1) {
      ctx.strokeStyle = COLORS.rocket;
      ctx.lineWidth = 2;
      // Left leg
      ctx.beginPath();
      ctx.moveTo(screenX - ROCKET_BODY_WIDTH / 2, screenY + ROCKET_BODY_HEIGHT);
      ctx.lineTo(screenX - ROCKET_BODY_WIDTH - 10, screenY + ROCKET_BODY_HEIGHT + 15);
      ctx.stroke();
      // Right leg
      ctx.beginPath();
      ctx.moveTo(screenX + ROCKET_BODY_WIDTH / 2, screenY + ROCKET_BODY_HEIGHT);
      ctx.lineTo(screenX + ROCKET_BODY_WIDTH + 10, screenY + ROCKET_BODY_HEIGHT + 15);
      ctx.stroke();
    }
  };

  /**
   * Draw the info panel (bottom right corner).
   * Shows altitude, velocity, fuel, etc.
   */
  const drawInfoPanel = (ctx: CanvasRenderingContext2D, state: RocketState) => {
    const panelX = CANVAS_WIDTH - INFO_PANEL_WIDTH - INFO_PANEL_MARGIN;
    const panelY = CANVAS_HEIGHT - INFO_PANEL_HEIGHT - INFO_PANEL_MARGIN;

    // Draw semi-transparent background
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(panelX, panelY, INFO_PANEL_WIDTH, INFO_PANEL_HEIGHT);

    // Draw border
    ctx.strokeStyle = COLORS.ui;
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX, panelY, INFO_PANEL_WIDTH, INFO_PANEL_HEIGHT);

    // Text styling
    ctx.fillStyle = COLORS.text;
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;

    // Helper function to draw a line of text
    const drawLine = (text: string, yOffset: number) => {
      ctx.fillText(text, panelX + 10, panelY + 25 + yOffset);
    };

    let lineOffset = 0;
    const lineHeight = 20;

    // Title
    ctx.font = `bold ${FONT_SIZE_MEDIUM}px monospace`;
    drawLine("TELEMETRY", lineOffset);
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;
    lineOffset += lineHeight + 5;

    // Draw a separator line
    ctx.strokeStyle = COLORS.ui;
    ctx.beginPath();
    ctx.moveTo(panelX + 10, panelY + 35);
    ctx.lineTo(panelX + INFO_PANEL_WIDTH - 10, panelY + 35);
    ctx.stroke();
    lineOffset += 10;

    // Altitude (convert from meters to km if very high)
    const altitudeDisplay =
      state.maxAltitudeReached > 100000
        ? (state.maxAltitudeReached / 1000).toFixed(0) + " km"
        : state.maxAltitudeReached.toFixed(0) + " m";
    drawLine(`ALT: ${altitudeDisplay}`, lineOffset);
    lineOffset += lineHeight;

    // Current altitude
    const currentAlt = state.position.y > 100000 ? (state.position.y / 1000).toFixed(1) + " km" : state.position.y.toFixed(1) + " m";
    drawLine(`CUR: ${currentAlt}`, lineOffset);
    lineOffset += lineHeight;

    // Velocity
    drawLine(`VEL: ${state.velocity.y.toFixed(1)} m/s`, lineOffset);
    lineOffset += lineHeight;

    // Fuel remaining (as percentage)
    const fuelPercent = ((state.fuelMass / rocketConfig.fuelMass) * 100).toFixed(0);
    drawLine(`FUEL: ${fuelPercent}%`, lineOffset);
    lineOffset += lineHeight;

    // Throttle
    drawLine(`THR: ${state.thrustPercentage.toFixed(0)}%`, lineOffset);
    lineOffset += lineHeight;

    // Time elapsed
    const minutes = Math.floor(state.timeElapsed / 60);
    const seconds = (state.timeElapsed % 60).toFixed(1);
    drawLine(`TIME: ${minutes}:${seconds}`, lineOffset);
    lineOffset += lineHeight;

    // Status
    let status = "STANDBY";
    if (state.isFlying) status = "FLYING";
    if (state.hasLanded) status = "LANDED";
    drawLine(`STATUS: ${status}`, lineOffset);
  };

  // === GAME LOOP ===

  /**
   * This runs every frame (60 times per second by default).
   * It's the heart of the simulation.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Track the last frame time for delta time calculation
    let lastFrameTime = Date.now();

    // Main game loop
    const gameLoop = () => {
      // Calculate delta time (seconds since last frame)
      const now = Date.now();
      const deltaTime = Math.min((now - lastFrameTime) / 1000, 0.1); // Cap at 100ms to prevent huge jumps
      lastFrameTime = now;

      // === UPDATE PHYSICS ===

      // Check which inputs are active
      const isSpacebarPressed = keysPressed.current[" "] || keysPressed.current[" "];
      const isClickActive = keysPressed.current["mouseClick"] || false;

      // Apply player controls to the rocket
      applyControls(rocketState, isSpacebarPressed, isClickActive);

      // Clear the click flag so it only triggers once
      keysPressed.current["mouseClick"] = false;

      // Update physics (this is where the rocket actually moves)
      const physicsFrame = updatePhysics(rocketState, {
        gravity: GRAVITY,
        windSpeed: WIND_SPEED,
        dragCoefficient: DRAG_COEFFICIENT,
        rocketRadius: ROCKET_RADIUS,
        timeStep: PHYSICS_TICK_RATE,
      }, deltaTime);

      // If rocket just landed, calculate score
      if (physicsFrame.groundImpact && !landingScore) {
        const score = calculateLandingScore(physicsFrame.state.landingVelocity);
        setLandingScore(score);
      }

      // Update React state so UI updates
      setRocketState({ ...physicsFrame.state });

      // === RENDER ===

      // Clear canvas (fill with space background)
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Draw world
      drawGround(ctx);

      // Draw rocket
      drawRocket(ctx, physicsFrame.state);

      // Draw info panel
      drawInfoPanel(ctx, physicsFrame.state);

      // Draw goal indicator (if set)
      if (selectedGoal || customGoalAltitude) {
        const goalAlt = customGoalAltitude || selectedGoal?.altitude || 0;
        const goalScreenY = CANVAS_HEIGHT - 20 - (goalAlt * PIXELS_PER_METER);

        // Only draw if goal is within view
        if (goalScreenY > 0 && goalScreenY < CANVAS_HEIGHT) {
          ctx.strokeStyle = COLORS.trajectory;
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]); // Dashed line
          ctx.beginPath();
          ctx.moveTo(0, goalScreenY);
          ctx.lineTo(CANVAS_WIDTH, goalScreenY);
          ctx.stroke();
          ctx.setLineDash([]); // Reset line dash

          // Draw goal name
          ctx.fillStyle = COLORS.trajectory;
          ctx.font = `${FONT_SIZE_SMALL}px monospace`;
          ctx.fillText(
            `Goal: ${(selectedGoal?.name || "Custom")} (${(goalAlt / 1000).toFixed(0)}km)`,
            10,
            goalScreenY - 5
          );
        }
      }

      // Continue animation loop
      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };

    // Start the game loop
    animationFrameRef.current = requestAnimationFrame(gameLoop);

    // Cleanup: stop the game loop when component unmounts
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [rocketState, rocketConfig, selectedGoal, customGoalAltitude, landingScore]);

  // === EVENT LISTENERS ===

  // Set up keyboard listeners
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // === RENDER UI ===

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        backgroundColor: COLORS.background,
        fontFamily: "monospace",
        color: COLORS.text,
      }}
    >
      {/* Header */}
      <h1 style={{ marginBottom: "20px" }}>🚀 Rocket Simulator</h1>

      {/* Main canvas */}
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onClick={handleCanvasClick}
        style={{
          border: `2px solid ${COLORS.ui}`,
          cursor: "pointer",
          marginBottom: "20px",
          backgroundColor: COLORS.background,
        }}
      />

      {/* Control instructions */}
      <div style={{ marginBottom: "15px", textAlign: "center" }}>
        <p>SPACEBAR: Hold for continuous thrust | CLICK: Burst thrust</p>
      </div>

      {/* Controls panel */}
      <div
        style={{
          display: "flex",
          gap: "20px",
          marginBottom: "20px",
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        {/* Rocket selector */}
        <div>
          <label style={{ marginRight: "10px" }}>Rocket: </label>
          <select
            value={rocketConfig.name}
            onChange={handleRocketChange}
            style={{
              padding: "8px",
              backgroundColor: COLORS.ui,
              color: COLORS.text,
              border: `1px solid ${COLORS.text}`,
              cursor: "pointer",
            }}
          >
            {AVAILABLE_ROCKETS.map((rocket) => (
              <option key={rocket.name} value={rocket.name}>
                {rocket.name}
              </option>
            ))}
          </select>
        </div>

        {/* Goal selector */}
        <div>
          <label style={{ marginRight: "10px" }}>Goal: </label>
          <select
            value={selectedGoal?.name || "custom"}
            onChange={handleGoalChange}
            style={{
              padding: "8px",
              backgroundColor: COLORS.ui,
              color: COLORS.text,
              border: `1px solid ${COLORS.text}`,
              cursor: "pointer",
            }}
          >
            {ALTITUDE_GOALS.map((goal) => (
              <option key={goal.name} value={goal.name}>
                {goal.name}
              </option>
            ))}
          </select>
        </div>

        {/* Custom goal input */}
        <div>
          <label style={{ marginRight: "10px" }}>Custom (m): </label>
          <input
            type="number"
            value={customGoalAltitude || ""}
            onChange={handleCustomGoal}
            placeholder="Enter altitude"
            style={{
              padding: "8px",
              backgroundColor: COLORS.ui,
              color: COLORS.text,
              border: `1px solid ${COLORS.text}`,
            }}
          />
        </div>

        {/* Reset button */}
        <button
          onClick={handleReset}
          style={{
            padding: "8px 15px",
            backgroundColor: COLORS.ui,
            color: COLORS.text,
            border: `1px solid ${COLORS.text}`,
            cursor: "pointer",
            fontSize: "14px",
          }}
        >
          Reset
        </button>
      </div>

      {/* Landing results */}
      {landingScore !== null && (
        <div
          style={{
            padding: "15px",
            backgroundColor: "rgba(74, 111, 165, 0.3)",
            border: `2px solid ${COLORS.ui}`,
            marginBottom: "20px",
            textAlign: "center",
          }}
        >
          <p>
            Landing Score: <strong>{landingScore.toFixed(0)}/100</strong>
          </p>
          <p>Max Altitude: {(rocketState.maxAltitudeReached / 1000).toFixed(2)} km</p>
          <p>Landing Velocity: {Math.abs(rocketState.landingVelocity).toFixed(2)} m/s</p>
        </div>
      )}

      {/* Debug info */}
      {DEBUG_MODE && (
        <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.5)" }}>
          <p>State: {rocketState.isFlying ? "Flying" : rocketState.hasLanded ? "Landed" : "Ready"}</p>
          <p>Position: ({rocketState.position.x.toFixed(2)}, {rocketState.position.y.toFixed(2)})</p>
        </div>
      )}
    </div>
  );
};