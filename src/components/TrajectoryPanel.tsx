/**
 * TRAJECTORY PANEL — Flight Path Visualization
 * =============================================
 * Renders the rocket's complete flight path as a 2D plot on a canvas element.
 *
 * TWO DISPLAY MODES:
 *
 *   1. MINI PANEL — always-on small overlay in the bottom-left corner.
 *      Drawn by the main canvas (RocketSimulator) via drawTrajectoryOverlay().
 *      This component renders ONLY the canvas element; the expand button is
 *      rendered by the parent (RocketSimulator.tsx) so it has access to the
 *      isTrajectoryFullscreen state setter.
 *
 *   2. FULLSCREEN — expands to fill the entire viewport.
 *      Shows a large trajectory plot plus a metrics grid below it.
 *      Triggered by clicking the expand button on the mini panel.
 *      Dismissed with ESC key or the "Close" button (both handled in parent).
 *
 * COORDINATE SYSTEM CHALLENGE:
 *   World coordinates: (0, 0) = launch pad. Y increases UPWARD (altitude).
 *   Canvas coordinates: (0, 0) = top-left corner. Y increases DOWNWARD.
 *
 *   To convert world → canvas, we must FLIP the Y axis:
 *     canvasY = canvasHeight - padding - (worldY - minWorldY) × scale
 *
 *   The subtraction of canvasHeight flips up/down; the subtraction of minWorldY
 *   shifts the origin so the lowest trajectory point sits at the canvas bottom.
 *
 * AUTO-SCALING (FIT-TO-VIEW):
 *   The trajectory bounds (minX, maxX, minY, maxY) are computed each render.
 *   Scale factors scaleX and scaleY are computed so the trajectory exactly fills
 *   the canvas width and height respectively (minus padding).
 *   We take Math.min(scaleX, scaleY) — the "uniform fit" scale — so the trajectory
 *   fits without being stretched. This preserves aspect ratio, which matters
 *   because the physical shape of the arc (parabolic vs steep) carries meaning.
 *
 * VISUAL ELEMENTS:
 *   - Dark background (rgba(10, 14, 39, 0.9)) — matches the main HUD aesthetic.
 *   - Subtle grid lines every 50 pixels for spatial reference.
 *   - Cyan trajectory line connecting all recorded world positions.
 *   - Yellow square: launch position (first recorded point).
 *   - Green circle: current position (live, updates every frame).
 *   - Red circle: last recorded position (most recent history point).
 *   - Axis lines with range labels (e.g., "42.3km" along X axis).
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

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Props passed down from RocketSimulator.tsx.
 *
 * rocketState     — Updated every physics tick, drives the live green dot.
 * trajectoryHistory — The full array of {x, y} world positions (grows over time).
 * isFullscreen    — Determines which render mode to use.
 * onCloseFullscreen — Parent callback invoked when the user presses "Close" or ESC.
 */
interface TrajectoryPanelProps {
  rocketState: RocketState;
  trajectoryHistory: Array<{ x: number; y: number }>;
  isFullscreen: boolean;
  onCloseFullscreen: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TrajectoryPanel — renders the trajectory canvas in either mini or fullscreen mode.
 *
 * useRef vs useState for the canvas:
 *   We use useRef<HTMLCanvasElement> rather than useState because we don't need
 *   React to re-render when the canvas DOM node is assigned. We just need a stable
 *   handle to the element so useEffect can call getContext("2d") on it.
 *   useRef gives a mutable `.current` property that persists across renders
 *   without triggering a re-render when it changes.
 */
export const TrajectoryPanel: React.FC<TrajectoryPanelProps> = ({
  rocketState,
  trajectoryHistory,
  isFullscreen,
  onCloseFullscreen,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ─────────────────────────────────────────────────────────────────────────
  // DRAWING FUNCTION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Render the trajectory onto a canvas context.
   *
   * @param ctx    2D rendering context to draw into.
   * @param history Array of world-space {x, y} positions (meters).
   * @param canvasW Canvas pixel width.
   * @param canvasH Canvas pixel height.
   * @param _scale  Unused (was the global PIXELS_PER_METER constant) — we compute
   *                our own fit-scale from bounds. Kept in signature for API stability.
   *
   * COORDINATE TRANSFORM WALKTHROUGH:
   *
   *   World space example:
   *     minX = -500m, maxX = 2000m, rangeX = 2500m
   *     minY = 0m, maxY = 80000m, rangeY = 80000m
   *
   *   Canvas size: 400 × 300px, padding = 20px.
   *   Available drawing area: (400 - 40) × (300 - 40) = 360 × 260px.
   *
   *   scaleX = 360 / 2500 = 0.144 px/m
   *   scaleY = 260 / 80000 = 0.00325 px/m
   *   fitScale = min(0.144, 0.00325) = 0.00325 px/m  (Y is the binding constraint)
   *
   *   For a point at (1000m, 40000m):
   *     screenX = 20 + (1000 - (-500)) × 0.00325 = 20 + 4.875 = 24.9 px
   *     screenY = 300 - 20 - (40000 - 0) × 0.00325 = 280 - 130 = 150 px
   *
   *   The Y flip (canvasH - padding - ...) converts world-up to canvas-down.
   */
  const drawTrajectory = (
    ctx: CanvasRenderingContext2D,
    history: Array<{ x: number; y: number }>,
    canvasW: number,
    canvasH: number,
    _scale: number
  ) => {
    if (history.length === 0) return;

    // ── Step 1: Find bounding box of all recorded positions ──────────────
    // We need the extremes to set up the auto-fit scale.
    // Initialize min/max to the first point so we have a valid starting reference.
    let minX = history[0].x;
    let maxX = history[0].x;
    let minY = history[0].y;
    let maxY = history[0].y;

    for (const pos of history) {
      if (pos.x < minX) minX = pos.x;
      if (pos.x > maxX) maxX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.y > maxY) maxY = pos.y;
    }

    const padding = 20; // Pixels of blank space around all four edges

    // `|| 1` prevents division by zero when the rocket hasn't moved yet
    // (all points the same → range = 0 → scale would be Infinity).
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    // ── Step 2: Compute the uniform fit scale ────────────────────────────
    // scaleX: if we used only width, how many px per meter?
    // scaleY: if we used only height, how many px per meter?
    // We take the smaller so the trajectory fits inside BOTH dimensions.
    const scaleX = (canvasW - padding * 2) / rangeX;
    const scaleY = (canvasH - padding * 2) / rangeY;
    const fitScale = Math.min(scaleX, scaleY);

    // ── Step 3: Clear and draw background ───────────────────────────────
    ctx.fillStyle = "rgba(10, 14, 39, 0.9)";
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Subtle grid lines — helps the eye judge scale
    ctx.strokeStyle = "rgba(100, 100, 150, 0.2)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < canvasW; gx += 50) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, canvasH);
      ctx.stroke();
    }
    for (let gy = 0; gy < canvasH; gy += 50) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(canvasW, gy);
      ctx.stroke();
    }

    // ── Step 4: Draw the trajectory line ────────────────────────────────
    // A single continuous path through all recorded positions.
    // Using lineCap="round" and lineJoin="round" avoids sharp angular artifacts
    // where the rocket changed direction quickly.
    ctx.strokeStyle = COLORS.trajectory;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();

    for (let i = 0; i < history.length; i++) {
      const pos = history[i];

      // World → canvas coordinate transform (see function docstring above)
      const screenX = padding + (pos.x - minX) * fitScale;
      const screenY = canvasH - padding - (pos.y - minY) * fitScale;

      if (i === 0) {
        ctx.moveTo(screenX, screenY); // First point: lift pen
      } else {
        ctx.lineTo(screenX, screenY); // Subsequent: draw line segment
      }
    }
    ctx.stroke();

    // ── Step 5: Mark current rocket position (live green dot) ───────────
    // `rocketState.position` is the live position from the physics engine,
    // which may be slightly ahead of the last trajectory history point
    // (history is sampled periodically, position is always current).
    const currentScreenX = padding + (rocketState.position.x - minX) * fitScale;
    const currentScreenY = canvasH - padding - (rocketState.position.y - minY) * fitScale;

    ctx.fillStyle = "#00ff00";
    ctx.beginPath();
    ctx.arc(currentScreenX, currentScreenY, 6, 0, Math.PI * 2);
    ctx.fill();

    // ── Step 6: Mark launch position (yellow square) ─────────────────────
    const startScreenX = padding + (history[0].x - minX) * fitScale;
    const startScreenY = canvasH - padding - (history[0].y - minY) * fitScale;

    ctx.fillStyle = "#ffff00";
    ctx.fillRect(startScreenX - 5, startScreenY - 5, 10, 10);

    // ── Step 7: Mark last recorded position (red dot) ────────────────────
    const lastPos = history[history.length - 1];
    const endScreenX = padding + (lastPos.x - minX) * fitScale;
    const endScreenY = canvasH - padding - (lastPos.y - minY) * fitScale;

    ctx.fillStyle = "#ff0000";
    ctx.beginPath();
    ctx.arc(endScreenX, endScreenY, 5, 0, Math.PI * 2);
    ctx.fill();

    // ── Step 8: Draw axes and range labels ───────────────────────────────
    // Dashed lines along the bottom and left edges serve as axis references.
    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]); // 2px dash, 2px gap

    ctx.beginPath();
    ctx.moveTo(padding, canvasH - padding);
    ctx.lineTo(canvasW - padding, canvasH - padding);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, canvasH - padding);
    ctx.stroke();

    ctx.setLineDash([]); // Reset to solid lines

    // Range labels: show the total span in km (÷1000 to convert meters → km)
    ctx.fillStyle = COLORS.text;
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;

    ctx.fillText(
      `${(rangeX / 1000).toFixed(1)}km`,
      canvasW - padding - 50,
      canvasH - padding + 20
    );

    // Y-axis label drawn rotated 90° — save/restore preserves the transform state
    ctx.save();
    ctx.translate(padding - 20, canvasH / 2);
    ctx.rotate(-Math.PI / 2); // -90 degrees (counter-clockwise)
    ctx.fillText(`${(rangeY / 1000).toFixed(1)}km`, -25, 0);
    ctx.restore(); // Undo the translate + rotate

    // ── Step 9: Legend ────────────────────────────────────────────────────
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;
    ctx.fillText("█ Start", padding, 20);

    ctx.fillStyle = "#00ff00";
    ctx.fillText("● Current", padding + 90, 20);

    ctx.fillStyle = "#ff0000";
    ctx.fillText("● End", padding + 210, 20);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // EFFECT: RE-DRAW WHEN DATA CHANGES
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * useEffect runs AFTER every render where one of the dependencies changed.
   *
   * Dependencies: [trajectoryHistory, rocketState, isFullscreen]
   *   - trajectoryHistory: new points added → need to redraw the line.
   *   - rocketState: position changed → need to move the green dot.
   *   - isFullscreen: mode changed → canvas size changes, need full redraw.
   *
   * WHY WE RESIZE THE CANVAS HERE:
   *   Setting canvas.width or canvas.height resets the canvas buffer and
   *   clears all content. So we must call drawTrajectory() AFTER resizing,
   *   not before. The effect body runs sequentially top-to-bottom, so
   *   resize → draw is guaranteed.
   *
   * CLEANUP RETURN VALUE:
   *   React runs the returned function when the component unmounts or before
   *   the next run of this effect. For the fullscreen requestAnimationFrame
   *   (the `animationFrame` variable), we cancel it in cleanup to prevent
   *   a stale loop continuing after the component is gone.
   *   Note: the current requestAnimationFrame callback is empty (`() => {}`)
   *   because this effect simply redraws on React render, not on a rAF loop.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Size the canvas to match its display container
    const canvasW = isFullscreen ? window.innerWidth - 40 : TRAJECTORY_PANEL_WIDTH;
    const canvasH = isFullscreen ? window.innerHeight - 120 : TRAJECTORY_PANEL_HEIGHT;

    canvas.width = canvasW;
    canvas.height = canvasH;

    drawTrajectory(ctx, trajectoryHistory, canvasW, canvasH, PIXELS_PER_METER);

    if (isFullscreen) {
      // The fullscreen panel can request an animation frame for future live updates.
      // For now we just redraw on React state changes (which are driven by the
      // parent's game loop), so this is a placeholder cleanup.
      const animationFrame = requestAnimationFrame(() => {});
      return () => cancelAnimationFrame(animationFrame);
    }
  }, [trajectoryHistory, rocketState, isFullscreen]);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER — MINI PANEL MODE
  // ─────────────────────────────────────────────────────────────────────────

  if (!isFullscreen) {
    // The parent (RocketSimulator.tsx) renders a separate expand button ON TOP
    // of this div via its own absolute-positioned button. We do NOT render
    // a button here — a previous version had one with an empty onClick that
    // did nothing, which confused users clicking it and expecting fullscreen.
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
          // pointer-events: none is NOT set here — the expand button (rendered
          // by the parent, absolutely positioned over this div) needs to receive clicks.
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
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER — FULLSCREEN MODE
  // ─────────────────────────────────────────────────────────────────────────

  // Fixed overlay covering the full viewport (position: fixed, z-index: 1000)
  // so it sits above everything including the main game canvas.
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
      {/* Header bar with title and close button */}
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

      {/* Main canvas area — scrollable if trajectory extends beyond viewport */}
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

      {/* Metrics grid — auto-sized columns so it adapts to window width */}
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
        {/*
         * maxAltitudeReached is tracked on the RocketState object — the physics
         * engine updates it whenever position.y exceeds the previous maximum.
         * Dividing by 1000 converts meters → kilometers for the display.
         */}
        <MetricDisplay
          label="Max Altitude"
          value={(rocketState.maxAltitudeReached / 1000).toFixed(2)}
          unit="km"
        />

        {/*
         * timeElapsed is total simulation time in seconds since launch.
         * We convert to minutes + seconds for readability:
         *   Math.floor(t / 60) → whole minutes
         *   t % 60             → remaining seconds
         */}
        <MetricDisplay
          label="Flight Time"
          value={Math.floor(rocketState.timeElapsed / 60)}
          unit={`m ${(rocketState.timeElapsed % 60).toFixed(0)}s`}
        />

        {/*
         * Max velocity is not stored on RocketState (only current velocity is).
         * A future improvement would track maxVelocityReached like maxAltitudeReached.
         */}
        <MetricDisplay label="Max Velocity" value="—" unit="m/s" />

        {/*
         * Horizontal range: how far from the launch pad did the rocket travel?
         * Math.abs() handles negative X (rockets that drift left of the pad).
         */}
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

        {/*
         * hasLanded is set by the landing detection logic in the physics engine.
         * It becomes true when the rocket touches ground (position.y ≤ groundLevel)
         * with downward velocity (velocity.y < 0).
         */}
        <MetricDisplay
          label="Status"
          value={rocketState.hasLanded ? "LANDED" : "FLYING"}
          unit=""
        />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// METRIC DISPLAY HELPER COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Props for a single metric card.
 */
interface MetricDisplayProps {
  label: string;       // e.g. "Max Altitude"
  value: string | number; // e.g. "82.34" or 82.34
  unit: string;        // e.g. "km"
}

/**
 * Renders a small labeled metric card in the fullscreen panel footer.
 *
 * Styled as a translucent box with a subtle blue border — consistent with
 * the mission control HUD aesthetic across the rest of the simulator.
 *
 * Arrow function component syntax (instead of `function MetricDisplay(...)`)
 * is idiomatic React for small presentational components with no state.
 * The `React.FC<>` generic ensures TypeScript validates the props shape.
 */
const MetricDisplay: React.FC<MetricDisplayProps> = ({ label, value, unit }) => (
  <div
    style={{
      padding: "10px",
      backgroundColor: "rgba(74, 111, 165, 0.2)",
      border: `1px solid ${COLORS.ui}`,
      borderRadius: "3px",
    }}
  >
    {/* Dimmed label above the value — smaller font, lower contrast */}
    <div
      style={{
        fontSize: "12px",
        color: "rgba(255, 255, 255, 0.7)",
        marginBottom: "5px",
      }}
    >
      {label}
    </div>

    {/* Large bold value with a small inline unit suffix */}
    <div style={{ fontSize: "18px", fontWeight: "bold" }}>
      {value} <span style={{ fontSize: "12px" }}>{unit}</span>
    </div>
  </div>
);
