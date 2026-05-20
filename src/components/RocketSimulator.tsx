/**
 * ROCKET SIMULATOR - MAIN COMPONENT (UPDATED)
 * ============================================
 * Enhanced version with trajectory tracking and trajectory panel integration.
 * Now records the rocket's position every frame so we can visualize the flight path.
 * 
 * New features:
 * - Trajectory history tracking (all positions rocket has been at)
 * - Mini trajectory panel in bottom-left
 * - Fullscreen trajectory view with detailed metrics
 * - ESC key to close fullscreen
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
import { TrajectoryPanel } from "./TrajectoryPanel";
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
 */
export const RocketSimulator: React.FC = () => {
  // === REFS (persistent across renders) ===

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const keysPressed = useRef<{ [key: string]: boolean }>({});

  // === STATE (triggers re-renders) ===

  // Rocket state and configuration
  const [rocketState, setRocketState] = useState<RocketState>(() =>
    createRocket(ROCKET_SMALL)
  );
  const [rocketConfig, setRocketConfig] = useState<RocketConfig>(ROCKET_SMALL);

  // Goals
  const [selectedGoal, setSelectedGoal] = useState<AltitudeGoal | null>(
    ALTITUDE_GOALS[0]
  );
  const [customGoalAltitude, setCustomGoalAltitude] = useState<number | null>(
    null
  );

  // Landing and trajectory
  const [landingScore, setLandingScore] = useState<number | null>(null);
  const [showFullscreenTrajectory, setShowFullscreenTrajectory] =
    useState(false);

  // NEW: Trajectory history - records every position the rocket has been at
  // This is used to draw the flight path visualization
  const [trajectoryHistory, setTrajectoryHistory] = useState<
    Array<{ x: number; y: number }>
  >([]);

  // === EVENT HANDLERS ===

  const handleKeyDown = (e: KeyboardEvent) => {
    keysPressed.current[e.key.toLowerCase()] = true;

    // NEW: ESC key closes fullscreen trajectory
    if (e.key === "Escape") {
      setShowFullscreenTrajectory(false);
    }

    if (e.key === " ") {
      e.preventDefault();
    }
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    keysPressed.current[e.key.toLowerCase()] = false;
  };

  const handleCanvasClick = () => {
    keysPressed.current["mouseClick"] = true;
  };

  const handleRocketChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedName = e.target.value;
    const rocket = AVAILABLE_ROCKETS.find((r) => r.name === selectedName);

    if (rocket) {
      const newState = createRocket(rocket);
      setRocketState(newState);
      setRocketConfig(rocket);
      setLandingScore(null);
      // Reset trajectory when changing rockets
      setTrajectoryHistory([]);
    }
  };

  const handleGoalChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const goalName = e.target.value;
    const goal = ALTITUDE_GOALS.find((g) => g.name === goalName);
    if (goal) {
      setSelectedGoal(goal);
      setCustomGoalAltitude(null);
    }
  };

  const handleCustomGoal = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "") {
      setCustomGoalAltitude(null);
      setSelectedGoal(ALTITUDE_GOALS[0]);
    } else {
      const altitude = parseFloat(value);
      if (!isNaN(altitude) && altitude > 0) {
        setCustomGoalAltitude(altitude);
        setSelectedGoal(null);
      }
    }
  };

  const handleReset = () => {
    resetRocket(rocketState, rocketConfig);
    setRocketState({ ...rocketState });
    setLandingScore(null);
    setShowFullscreenTrajectory(false);
    // Reset trajectory history
    setTrajectoryHistory([]);
  };

  // === DRAWING FUNCTIONS ===

  const drawGround = (ctx: CanvasRenderingContext2D) => {
    const groundY = CANVAS_HEIGHT - 20;

    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, groundY, CANVAS_WIDTH, 20);

    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(CANVAS_WIDTH, groundY);
    ctx.stroke();
  };

  const drawRocket = (ctx: CanvasRenderingContext2D, state: RocketState) => {
    const screenX = (CANVAS_WIDTH / 2) + (state.position.x * PIXELS_PER_METER);
    const screenY = CANVAS_HEIGHT - 20 - (state.position.y * PIXELS_PER_METER);

    // Body
    ctx.fillStyle = COLORS.rocket;
    ctx.fillRect(
      screenX - ROCKET_BODY_WIDTH / 2,
      screenY,
      ROCKET_BODY_WIDTH,
      ROCKET_BODY_HEIGHT
    );

    // Nose
    ctx.fillStyle = COLORS.rocketNose;
    ctx.beginPath();
    ctx.moveTo(screenX, screenY - ROCKET_NOSE_HEIGHT);
    ctx.lineTo(screenX - ROCKET_BODY_WIDTH / 2, screenY);
    ctx.lineTo(screenX + ROCKET_BODY_WIDTH / 2, screenY);
    ctx.closePath();
    ctx.fill();

    // Flame (if thrusting)
    if (state.isThrusting && state.fuelMass > 0) {
      const flameHeight =
        ROCKET_FLAME_HEIGHT_MIN +
        ((ROCKET_FLAME_HEIGHT_MAX - ROCKET_FLAME_HEIGHT_MIN) *
          (state.thrustPercentage / 100));

      ctx.fillStyle = COLORS.flame;
      ctx.beginPath();
      ctx.moveTo(screenX, screenY + ROCKET_BODY_HEIGHT);
      ctx.lineTo(screenX - ROCKET_BODY_WIDTH / 1.5, screenY + ROCKET_BODY_HEIGHT + flameHeight);
      ctx.lineTo(screenX + ROCKET_BODY_WIDTH / 1.5, screenY + ROCKET_BODY_HEIGHT + flameHeight);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "rgba(255, 200, 0, 0.7)";
      ctx.beginPath();
      ctx.moveTo(screenX, screenY + ROCKET_BODY_HEIGHT);
      ctx.lineTo(screenX - ROCKET_BODY_WIDTH / 2.5, screenY + ROCKET_BODY_HEIGHT + flameHeight * 0.6);
      ctx.lineTo(screenX + ROCKET_BODY_WIDTH / 2.5, screenY + ROCKET_BODY_HEIGHT + flameHeight * 0.6);
      ctx.closePath();
      ctx.fill();
    }

    // Landing legs
    if (state.position.y <= 1) {
      ctx.strokeStyle = COLORS.rocket;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(screenX - ROCKET_BODY_WIDTH / 2, screenY + ROCKET_BODY_HEIGHT);
      ctx.lineTo(screenX - ROCKET_BODY_WIDTH - 10, screenY + ROCKET_BODY_HEIGHT + 15);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(screenX + ROCKET_BODY_WIDTH / 2, screenY + ROCKET_BODY_HEIGHT);
      ctx.lineTo(screenX + ROCKET_BODY_WIDTH + 10, screenY + ROCKET_BODY_HEIGHT + 15);
      ctx.stroke();
    }
  };

  const drawInfoPanel = (ctx: CanvasRenderingContext2D, state: RocketState) => {
    const panelX = CANVAS_WIDTH - INFO_PANEL_WIDTH - INFO_PANEL_MARGIN;
    const panelY = CANVAS_HEIGHT - INFO_PANEL_HEIGHT - INFO_PANEL_MARGIN;

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(panelX, panelY, INFO_PANEL_WIDTH, INFO_PANEL_HEIGHT);

    ctx.strokeStyle = COLORS.ui;
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX, panelY, INFO_PANEL_WIDTH, INFO_PANEL_HEIGHT);

    ctx.fillStyle = COLORS.text;
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;

    const drawLine = (text: string, yOffset: number) => {
      ctx.fillText(text, panelX + 10, panelY + 25 + yOffset);
    };

    let lineOffset = 0;
    const lineHeight = 20;

    ctx.font = `bold ${FONT_SIZE_MEDIUM}px monospace`;
    drawLine("TELEMETRY", lineOffset);
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;
    lineOffset += lineHeight + 5;

    ctx.strokeStyle = COLORS.ui;
    ctx.beginPath();
    ctx.moveTo(panelX + 10, panelY + 35);
    ctx.lineTo(panelX + INFO_PANEL_WIDTH - 10, panelY + 35);
    ctx.stroke();
    lineOffset += 10;

    const altitudeDisplay =
      state.maxAltitudeReached > 100000
        ? (state.maxAltitudeReached / 1000).toFixed(0) + " km"
        : state.maxAltitudeReached.toFixed(0) + " m";
    drawLine(`ALT: ${altitudeDisplay}`, lineOffset);
    lineOffset += lineHeight;

    const currentAlt = state.position.y > 100000 ? (state.position.y / 1000).toFixed(1) + " km" : state.position.y.toFixed(1) + " m";
    drawLine(`CUR: ${currentAlt}`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`VEL: ${state.velocity.y.toFixed(1)} m/s`, lineOffset);
    lineOffset += lineHeight;

    const fuelPercent = ((state.fuelMass / rocketConfig.fuelMass) * 100).toFixed(0);
    drawLine(`FUEL: ${fuelPercent}%`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`THR: ${state.thrustPercentage.toFixed(0)}%`, lineOffset);
    lineOffset += lineHeight;

    const minutes = Math.floor(state.timeElapsed / 60);
    const seconds = (state.timeElapsed % 60).toFixed(1);
    drawLine(`TIME: ${minutes}:${seconds}`, lineOffset);
    lineOffset += lineHeight;

    let status = "STANDBY";
    if (state.isFlying) status = "FLYING";
    if (state.hasLanded) status = "LANDED";
    drawLine(`STATUS: ${status}`, lineOffset);
  };

  // === GAME LOOP ===

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let lastFrameTime = Date.now();

    const gameLoop = () => {
      const now = Date.now();
      const deltaTime = Math.min((now - lastFrameTime) / 1000, 0.1);
      lastFrameTime = now;

      // === PHYSICS UPDATE ===
      const isSpacebarPressed = keysPressed.current[" "];
      const isClickActive = keysPressed.current["mouseClick"] || false;

      applyControls(rocketState, isSpacebarPressed, isClickActive);
      keysPressed.current["mouseClick"] = false;

      const physicsFrame = updatePhysics(rocketState, {
        gravity: GRAVITY,
        windSpeed: WIND_SPEED,
        dragCoefficient: DRAG_COEFFICIENT,
        rocketRadius: ROCKET_RADIUS,
        timeStep: PHYSICS_TICK_RATE,
      }, deltaTime);

      // NEW: Record current position to trajectory history
      // Add the rocket's current position to our history
      setTrajectoryHistory((prev) => [
        ...prev,
        {
          x: physicsFrame.state.position.x,
          y: physicsFrame.state.position.y,
        },
      ]);

      if (physicsFrame.groundImpact && !landingScore) {
        const score = calculateLandingScore(physicsFrame.state.landingVelocity);
        setLandingScore(score);
      }

      setRocketState({ ...physicsFrame.state });

      // === RENDER ===
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      drawGround(ctx);
      drawRocket(ctx, physicsFrame.state);
      drawInfoPanel(ctx, physicsFrame.state);

      // Draw goal indicator
      if (selectedGoal || customGoalAltitude) {
        const goalAlt = customGoalAltitude || selectedGoal?.altitude || 0;
        const goalScreenY = CANVAS_HEIGHT - 20 - (goalAlt * PIXELS_PER_METER);

        if (goalScreenY > 0 && goalScreenY < CANVAS_HEIGHT) {
          ctx.strokeStyle = COLORS.trajectory;
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(0, goalScreenY);
          ctx.lineTo(CANVAS_WIDTH, goalScreenY);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = COLORS.trajectory;
          ctx.font = `${FONT_SIZE_SMALL}px monospace`;
          ctx.fillText(
            `Goal: ${(selectedGoal?.name || "Custom")} (${(goalAlt / 1000).toFixed(0)}km)`,
            10,
            goalScreenY - 5
          );
        }
      }

      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };

    animationFrameRef.current = requestAnimationFrame(gameLoop);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [rocketState, rocketConfig, selectedGoal, customGoalAltitude, landingScore]);

  // === EVENT LISTENERS ===

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
      {/* Show fullscreen trajectory if enabled */}
      {showFullscreenTrajectory && (
        <TrajectoryPanel
          rocketState={rocketState}
          trajectoryHistory={trajectoryHistory}
          isFullscreen={true}
          onCloseFullscreen={() => setShowFullscreenTrajectory(false)}
        />
      )}

      {/* Main UI (hidden when fullscreen) */}
      {!showFullscreenTrajectory && (
        <>
          <h1 style={{ marginBottom: "20px" }}>🚀 Rocket Simulator</h1>

          <div style={{ position: "relative" }}>
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

            {/* Mini trajectory panel (bottom-left) */}
            <div style={{ position: "absolute", bottom: "20px", left: "20px" }}>
              <TrajectoryPanel
                rocketState={rocketState}
                trajectoryHistory={trajectoryHistory}
                isFullscreen={false}
                onCloseFullscreen={() => {}}
              />
              {/* Button to expand trajectory to fullscreen */}
              <button
                onClick={() => setShowFullscreenTrajectory(true)}
                style={{
                  position: "absolute",
                  bottom: "10px",
                  right: "10px",
                  padding: "4px 8px",
                  fontSize: "12px",
                  backgroundColor: COLORS.ui,
                  color: COLORS.text,
                  border: `1px solid ${COLORS.text}`,
                  cursor: "pointer",
                  borderRadius: "3px",
                }}
                title="Expand to fullscreen"
              >
                ⛶
              </button>
            </div>
          </div>

          <div style={{ marginBottom: "15px", textAlign: "center" }}>
            <p>SPACEBAR: Hold for continuous thrust | CLICK: Burst thrust</p>
          </div>

          <div
            style={{
              display: "flex",
              gap: "20px",
              marginBottom: "20px",
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
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

          {DEBUG_MODE && (
            <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.5)" }}>
              <p>State: {rocketState.isFlying ? "Flying" : rocketState.hasLanded ? "Landed" : "Ready"}</p>
              <p>Trajectory points: {trajectoryHistory.length}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
};