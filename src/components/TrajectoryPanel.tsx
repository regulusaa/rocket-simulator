/**
 * ROCKET SIMULATOR - TRAJECTORY PANEL
 * ===================================
 * This component displays the rocket's flight trajectory (path it took through the air).
 * 
 * Two modes:
 * 1. Mini Panel (bottom-right corner of main canvas): Small preview of trajectory
 * 2. Fullscreen Mode: Large detailed view with live metrics updated every frame
 * 
 * The trajectory is drawn as a line connecting all the positions the rocket has been at.
 * This helps players visualize their flight path and understand rocket behavior.
 */

import React, { useEffect, useRef } from "react";
import type { RocketState } from "../physics/types";
import {
  PIXELS_PER_METER,
  TRAJECTORY_PANEL_WIDTH,
  TRAJECTORY_PANEL_HEIGHT,
  COLORS,
  FONT_SIZE_SMALL,
  INFO_PANEL_MARGIN,
} from "../utils/constants";

/**
 * Props for the TrajectoryPanel component
 */
interface TrajectoryPanelProps {
  rocketState: RocketState; // Current rocket state (for live updates)
  trajectoryHistory: Array<{ x: number; y: number }>; // Array of all positions rocket has been at
  isFullscreen: boolean; // Should we show fullscreen mode?
  onCloseFullscreen: () => void; // Callback to close fullscreen
}

/**
 * TrajectoryPanel component
 * Renders both mini panel and fullscreen trajectory view
 */
export const TrajectoryPanel: React.FC<TrajectoryPanelProps> = ({
  rocketState,
  trajectoryHistory,
  isFullscreen,
  onCloseFullscreen,
}) => {
  // Reference to canvas for drawing
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * Draw the trajectory line on a canvas.
   * Converts world coordinates to screen coordinates and connects them with lines.
   * 
   * @param ctx - Canvas context to draw on
   * @param history - Array of rocket positions throughout flight
   * @param canvasW - Width of the canvas to draw on
   * @param canvasH - Height of the canvas to draw on
   * @param scale - How many pixels per meter (for scaling the view)
   */
  const drawTrajectory = (
    ctx: CanvasRenderingContext2D,
    history: Array<{ x: number; y: number }>,
    canvasW: number,
    canvasH: number,
    _scale: number
  ) => {
    // Do nothing if trajectory is empty
    if (history.length === 0) return;

    // === FIND BOUNDS OF TRAJECTORY ===
    // We need to know the min/max X and Y to scale the view properly
    let minX = history[0].x;
    let maxX = history[0].x;
    let minY = history[0].y;
    let maxY = history[0].y;

    // Loop through all positions and find extremes
    for (const pos of history) {
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }

    // Add padding so trajectory doesn't touch edges
    const padding = 20;
    const rangeX = maxX - minX || 1; // Prevent division by zero
    const rangeY = maxY - minY || 1;

    // Calculate scale factors to fit trajectory in view
    const scaleX = (canvasW - padding * 2) / rangeX;
    const scaleY = (canvasH - padding * 2) / rangeY;

    // Use the smaller scale so everything fits
    const fitScale = Math.min(scaleX, scaleY);

    // === DRAW BACKGROUND ===
    // Dark background for visibility
    ctx.fillStyle = "rgba(10, 14, 39, 0.9)";
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Draw grid for reference
    ctx.strokeStyle = "rgba(100, 100, 150, 0.2)";
    ctx.lineWidth = 1;
    for (let i = 0; i < canvasW; i += 50) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, canvasH);
      ctx.stroke();
    }
    for (let i = 0; i < canvasH; i += 50) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(canvasW, i);
      ctx.stroke();
    }

    // === DRAW TRAJECTORY LINE ===
    ctx.strokeStyle = COLORS.trajectory;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();

    // Draw line connecting all trajectory points
    for (let i = 0; i < history.length; i++) {
      const pos = history[i];

      // Convert world coordinates to screen coordinates
      // Center the view on the trajectory
      const screenX = padding + (pos.x - minX) * fitScale;
      const screenY = canvasH - padding - (pos.y - minY) * fitScale;

      if (i === 0) {
        // Start the path
        ctx.moveTo(screenX, screenY);
      } else {
        // Continue the path
        ctx.lineTo(screenX, screenY);
      }
    }

    ctx.stroke();

    // === DRAW CURRENT POSITION ===
    // Mark where the rocket currently is on the trajectory
    const currentScreenX = padding + (rocketState.position.x - minX) * fitScale;
    const currentScreenY =
      canvasH - padding - (rocketState.position.y - minY) * fitScale;

    // Draw a circle at current position
    ctx.fillStyle = "#00ff00"; // Green
    ctx.beginPath();
    ctx.arc(currentScreenX, currentScreenY, 6, 0, Math.PI * 2);
    ctx.fill();

    // === DRAW START AND END POINTS ===
    // Start point (ground level, first position)
    const startScreenX = padding + (history[0].x - minX) * fitScale;
    const startScreenY = canvasH - padding - (history[0].y - minY) * fitScale;

    ctx.fillStyle = "#ffff00"; // Yellow
    ctx.fillRect(startScreenX - 5, startScreenY - 5, 10, 10); // Square for start

    // End point (last position in trajectory)
    const lastPos = history[history.length - 1];
    const endScreenX = padding + (lastPos.x - minX) * fitScale;
    const endScreenY = canvasH - padding - (lastPos.y - minY) * fitScale;

    ctx.fillStyle = "#ff0000"; // Red
    ctx.beginPath();
    ctx.arc(endScreenX, endScreenY, 5, 0, Math.PI * 2);
    ctx.fill();

    // === DRAW AXES ===
    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);

    // X axis (horizontal)
    ctx.beginPath();
    ctx.moveTo(padding, canvasH - padding);
    ctx.lineTo(canvasW - padding, canvasH - padding);
    ctx.stroke();

    // Y axis (vertical)
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, canvasH - padding);
    ctx.stroke();

    ctx.setLineDash([]); // Reset dash pattern

    // === DRAW LABELS ===
    ctx.fillStyle = COLORS.text;
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;

    // X axis label (distance/range)
    ctx.fillText(
      `${(rangeX / 1000).toFixed(1)}km`,
      canvasW - padding - 50,
      canvasH - padding + 20
    );

    // Y axis label (altitude)
    ctx.save();
    ctx.translate(padding - 20, canvasH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${(rangeY / 1000).toFixed(1)}km`, -25, 0);
    ctx.restore();

    // Legend
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;
    ctx.fillText("█ Start", padding, 20);
    ctx.fillStyle = "#00ff00";
    ctx.fillText("● Current", padding + 90, 20);
    ctx.fillStyle = "#ff0000";
    ctx.fillText("● End", padding + 210, 20);
  };

  /**
   * Animation loop for the canvas rendering
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Determine canvas size based on mode
    const canvasW = isFullscreen ? window.innerWidth - 40 : TRAJECTORY_PANEL_WIDTH;
    const canvasH = isFullscreen
      ? window.innerHeight - 120
      : TRAJECTORY_PANEL_HEIGHT;

    // Set canvas size
    canvas.width = canvasW;
    canvas.height = canvasH;

    // Draw trajectory
    drawTrajectory(ctx, trajectoryHistory, canvasW, canvasH, PIXELS_PER_METER);

    // Only update continuously if fullscreen (otherwise it's just static in mini panel)
    if (isFullscreen) {
      const animationFrame = requestAnimationFrame(() => {});
      return () => cancelAnimationFrame(animationFrame);
    }
  }, [trajectoryHistory, rocketState, isFullscreen]);

  // === MINI PANEL MODE ===
  if (!isFullscreen) {
    return (
      <div
        style={{
          position: "absolute",
          bottom: INFO_PANEL_MARGIN,
          left: INFO_PANEL_MARGIN,
          width: TRAJECTORY_PANEL_WIDTH,
          height: TRAJECTORY_PANEL_HEIGHT,
          border: `2px solid ${COLORS.ui}`,
          backgroundColor: "rgba(0, 0, 0, 0.7)",
          borderRadius: "4px",
          overflow: "hidden",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
          }}
        />
        <button
          onClick={() => {
            /* This would be handled by parent */
          }}
          style={{
            position: "absolute",
            top: "5px",
            right: "5px",
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
    );
  }

  // === FULLSCREEN MODE ===
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: COLORS.background,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "15px",
          borderBottom: `2px solid ${COLORS.ui}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2>Flight Trajectory Analysis</h2>
        <button
          onClick={onCloseFullscreen}
          style={{
            padding: "8px 15px",
            backgroundColor: COLORS.ui,
            color: COLORS.text,
            border: `1px solid ${COLORS.text}`,
            cursor: "pointer",
            fontSize: "14px",
            borderRadius: "3px",
          }}
        >
          Close (ESC)
        </button>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <canvas
          ref={canvasRef}
          style={{
            display: "block",
            margin: "20px auto",
            border: `1px solid ${COLORS.ui}`,
          }}
        />
      </div>

      {/* Metrics panel */}
      <div
        style={{
          padding: "15px",
          borderTop: `2px solid ${COLORS.ui}`,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "20px",
          backgroundColor: "rgba(0, 0, 0, 0.5)",
        }}
      >
        <MetricDisplay
          label="Max Altitude"
          value={(rocketState.maxAltitudeReached / 1000).toFixed(2)}
          unit="km"
        />
        <MetricDisplay
          label="Flight Time"
          value={Math.floor(rocketState.timeElapsed / 60)}
          unit={`m ${(rocketState.timeElapsed % 60).toFixed(0)}s`}
        />
        <MetricDisplay
          label="Max Velocity"
          value="—"
          unit="m/s"
        />
        <MetricDisplay
          label="Range"
          value={(Math.abs(rocketState.position.x) / 1000).toFixed(2)}
          unit="km"
        />
        <MetricDisplay
          label="Current Altitude"
          value={(rocketState.position.y / 1000).toFixed(2)}
          unit="km"
        />
        <MetricDisplay
          label="Status"
          value={rocketState.hasLanded ? "LANDED" : "FLYING"}
          unit=""
        />
      </div>
    </div>
  );
};

/**
 * Helper component to display a metric in a nice formatted way
 */
interface MetricDisplayProps {
  label: string;
  value: string | number;
  unit: string;
}

const MetricDisplay: React.FC<MetricDisplayProps> = ({ label, value, unit }) => (
  <div
    style={{
      padding: "10px",
      backgroundColor: "rgba(74, 111, 165, 0.2)",
      border: `1px solid ${COLORS.ui}`,
      borderRadius: "3px",
    }}
  >
    <div
      style={{
        fontSize: "12px",
        color: "rgba(255, 255, 255, 0.7)",
        marginBottom: "5px",
      }}
    >
      {label}
    </div>
    <div style={{ fontSize: "18px", fontWeight: "bold" }}>
      {value} <span style={{ fontSize: "12px" }}>{unit}</span>
    </div>
  </div>
);