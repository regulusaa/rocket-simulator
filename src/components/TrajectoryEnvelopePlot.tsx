/**
 * TRAJECTORY ENVELOPE PLOT
 * ========================
 * A zoomable, pannable canvas visualization that renders all Monte Carlo
 * trajectory runs overlaid on a single 2D plot.
 *
 * WHAT THIS SHOWS:
 * Each simulation run is drawn as a thin semi-transparent line from launch (0,0)
 * to landing. When 50 runs are overlaid:
 *   - Nominal runs form a green "bundle" — the family of expected trajectories
 *   - Failed runs show in red — outliers that diverged from the expected path
 *   - The mean trajectory (white thick line) is the "nominal expected" trajectory
 *   - Cyan dashed lines show the 95th/5th percentile envelope — the tube containing 90% of flights
 *   - Gold line: the player's own manual flight for comparison
 *
 * This is directly inspired by Monte Carlo dispersion plots used at SpaceX and NASA.
 * Reference: https://en.wikipedia.org/wiki/Monte_Carlo_method#Applications_in_aerospace
 *
 * COORDINATE SYSTEMS:
 *   World space: x = meters east, y = meters altitude (positive up)
 *   Screen space: x = canvas pixels (left→right), y = canvas pixels (top→bottom, Y-FLIPPED)
 *
 * Y-FLIP: canvas.y = canvasHeight - world.y * scale (flips so altitude grows upward)
 *
 * ZOOM/PAN:
 *   panX, panY: world-space offset (which world point is at canvas bottom-left)
 *   scale: pixels per meter
 *   Mouse wheel: zoom in/out centered on cursor position
 *   Mouse drag: pan the view
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';

// Import the interfaces that describe simulation results
import type { SimulationRun, MonteCarloResults } from '../physics/MonteCarloSimulator';

// ─── PROPS ─────────────────────────────────────────────────────────────────────

/**
 * Props for the TrajectoryEnvelopePlot component.
 * All data is computed externally (in MonteCarloSimulator) and passed in.
 */
interface TrajectoryEnvelopePlotProps {
  runs: SimulationRun[];                                  // All simulation runs to draw
  envelope: MonteCarloResults['trajectoryEnvelope'];      // Upper/lower/mean envelope curves
  playerTrajectory?: Array<{ x: number; y: number }>;    // Player's manual flight (gold line)
  selectedRunId?: number | null;                          // Run to highlight (clicked in table)
  onRunSelect?: (id: number) => void;                     // Called when user clicks near a run
}

// ─── POLYFILL ──────────────────────────────────────────────────────────────────

/**
 * Cross-browser rounded-rectangle path builder.
 * ctx.roundRect() only exists in Chrome 99+/Firefox 112+/Safari 15.4+.
 * Falls back to arcTo() on older browsers so the tooltip renders everywhere.
 */
function roundRectPathLocal(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); return; }
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

// ─── COLORS ────────────────────────────────────────────────────────────────────

// Color palette for the trajectory plot — matches reference Monte Carlo dispersion images
const NOMINAL_COLOR       = 'rgba(0, 200, 80, 0.25)';    // Semi-transparent green: nominal runs
const NOMINAL_SELECTED    = 'rgba(0, 255, 100, 0.85)';   // Bright green: selected nominal run
const FAILURE_COLOR       = 'rgba(255, 60, 60, 0.25)';   // Semi-transparent red: failed runs
const FAILURE_SELECTED    = 'rgba(255, 80, 80, 0.85)';   // Bright red: selected failed run
const MEAN_COLOR          = 'rgba(255, 255, 255, 0.9)';  // White: mean trajectory (thick)
const ENVELOPE_COLOR      = 'rgba(0, 220, 255, 0.8)';    // Cyan: 95% confidence envelope bounds
const PLAYER_COLOR        = 'rgba(255, 200, 50, 0.95)';  // Gold: player's manual flight
const GRID_COLOR          = 'rgba(100, 120, 160, 0.2)';  // Faint blue-gray: reference grid
const AXIS_COLOR          = 'rgba(180, 200, 240, 0.7)';  // Light blue: axis labels and tick marks
const BACKGROUND          = 'rgba(4, 6, 20, 1)';         // Near-black space background

// ─── COMPONENT ─────────────────────────────────────────────────────────────────

/**
 * TrajectoryEnvelopePlot — interactive canvas showing all Monte Carlo trajectories.
 * Supports zoom (mouse wheel), pan (drag), hover tooltips, and PNG export.
 */
export const TrajectoryEnvelopePlot: React.FC<TrajectoryEnvelopePlotProps> = ({
  runs,
  envelope,
  playerTrajectory,
  selectedRunId,
  onRunSelect,
}) => {
  // Reference to the canvas DOM element for direct 2D context access
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Reference to the container div — used to read its dimensions for canvas sizing
  const containerRef = useRef<HTMLDivElement>(null);

  // ── TRANSFORM STATE (stored in refs for performance — no React re-renders on zoom/pan) ──
  // Using refs instead of state so zoom/pan interactions don't cause React re-renders.
  // We manually call drawCanvas() after each transform change instead.

  // Scale: pixels per meter of world space
  // Higher scale = zoomed in (fewer meters visible), lower scale = zoomed out
  const scaleRef = useRef<number>(1);

  // Pan: world-space coordinates at the canvas bottom-left corner
  // panX = worldX that appears at canvas left edge; panY = worldY at canvas bottom edge
  const panXRef  = useRef<number>(0); // Horizontal pan offset (world meters)
  const panYRef  = useRef<number>(0); // Vertical pan offset (world meters)

  // ── INTERACTION STATE ──────────────────────────────────────────────────────
  // isDragging: true while mouse button is held down for panning
  const isDraggingRef  = useRef<boolean>(false);
  // Last mouse position (screen pixels) for computing pan delta during drag
  const lastMouseRef   = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Hovered run: the run ID nearest to the current mouse cursor (for tooltip)
  const [hoveredRunId, setHoveredRunId] = useState<number | null>(null);
  // Tooltip position (screen pixels) and content
  const [tooltip, setTooltip] = useState<{
    sx: number;  // Screen x position of tooltip anchor
    sy: number;  // Screen y position
    run: SimulationRun;  // The run to show info for
  } | null>(null);

  // ── COORDINATE TRANSFORMS ──────────────────────────────────────────────────

  /**
   * Convert world coordinates (meters) to canvas screen coordinates (pixels).
   * X: world.x = 0 at launch pad, positive right → screen left to right
   * Y: world.y = 0 at ground, positive up → screen BOTTOM to TOP (canvas Y is flipped)
   *
   * @param wx  World x position (meters east of launch pad)
   * @param wy  World y altitude (meters above ground)
   * @param cw  Canvas width in pixels
   * @param ch  Canvas height in pixels
   */
  const worldToScreen = useCallback(
    // _cw is intentionally unused — the horizontal transform only needs panX and scale,
    // not the canvas width.  The parameter is kept so call-sites can pass (wx, wy, cw, ch)
    // uniformly and the screenToWorld inverse has a symmetric signature.
    (wx: number, wy: number, _cw: number, ch: number) => ({
      sx: (wx - panXRef.current) * scaleRef.current,            // Horizontal: just scale and offset
      sy: ch - (wy - panYRef.current) * scaleRef.current,       // Vertical: flip Y axis
    }),
    [] // No deps — reads refs directly, which always have current values
  );

  /**
   * Convert screen coordinates (pixels) back to world coordinates (meters).
   * Inverse of worldToScreen — used for mouse hover detection.
   */
  const screenToWorld = useCallback(
    (sx: number, sy: number, ch: number) => ({
      wx: sx / scaleRef.current + panXRef.current,               // Reverse horizontal transform
      wy: (ch - sy) / scaleRef.current + panYRef.current,       // Reverse vertical + flip
    }),
    []
  );

  // ── AUTO-FIT COMPUTATION ───────────────────────────────────────────────────

  /**
   * Compute scale and pan values that fit ALL trajectories within the canvas bounds.
   * Called once when data first arrives and when the container resizes.
   *
   * Algorithm:
   *   1. Find the world-space bounding box of all trajectory points
   *   2. Add 15% margin on all sides
   *   3. Compute scale = canvas_size / world_size (take the smaller to fit both axes)
   *   4. Compute pan = world_min - margin (so world_min shows at canvas edge)
   */
  const computeAutoFit = useCallback((cw: number, ch: number) => {
    if (runs.length === 0) return; // Nothing to fit if no runs

    // Gather ALL x and y values from ALL trajectories (including player trajectory)
    const allX: number[] = [];
    const allY: number[] = [];

    for (const run of runs) {
      for (const pt of run.trajectoryHistory) {
        allX.push(pt.x); // Collect all horizontal positions
        allY.push(pt.y); // Collect all altitudes
      }
    }

    // Also include player trajectory if provided
    if (playerTrajectory) {
      for (const pt of playerTrajectory) {
        allX.push(pt.x);
        allY.push(pt.y);
      }
    }

    if (allX.length === 0) return; // Guard: no data points

    // Bounding box in world space
    const minX = Math.min(0, ...allX); // Include launch pad (0,0) in bounds
    const maxX = Math.max(...allX);
    const minY = 0;                    // Always show from ground level
    const maxY = Math.max(...allY);

    // World-space extents
    const worldW = Math.max(maxX - minX, 1); // Prevent division by zero on degenerate data
    const worldH = Math.max(maxY - minY, 1);

    // Margins: 12% of the world extent on each side
    const marginX = worldW * 0.12;
    const marginY = worldH * 0.12;

    // Scale: fit both axes, take the smaller (so nothing is clipped)
    // Left 50px and bottom 40px reserved for axis labels
    const scaleX = (cw - 50) / (worldW + 2 * marginX);
    const scaleY = (ch - 40) / (worldH + 2 * marginY);
    const fitScale = Math.min(scaleX, scaleY); // Choose limiting axis

    // Pan: world coordinates at the canvas bottom-left corner
    // canvas_left shows world (minX - marginX), canvas_bottom shows world (minY - marginY)
    scaleRef.current = fitScale;
    panXRef.current  = minX - marginX;  // World X at left edge of canvas
    panYRef.current  = minY - marginY;  // World Y at bottom edge of canvas
  }, [runs, playerTrajectory]);

  // ── CANVAS DRAWING ─────────────────────────────────────────────────────────

  /**
   * Main drawing function — renders everything on the canvas.
   * Called after every zoom/pan change and when data changes.
   *
   * Drawing order (back to front for proper layering):
   *   1. Background
   *   2. Grid lines
   *   3. Nominal (green) run trajectories
   *   4. Failed (red) run trajectories
   *   5. 95% envelope bounds (cyan dashed)
   *   6. Mean trajectory (white thick)
   *   7. Player trajectory (gold)
   *   8. Selected/highlighted run (bright overlay)
   *   9. Hover tooltip
   *   10. Axis labels and legend
   */
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cw = canvas.width;  // Current canvas width in pixels
    const ch = canvas.height; // Current canvas height in pixels

    // ── BACKGROUND ──────────────────────────────────────────────────────
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, cw, ch); // Fill entire canvas with space-black background

    if (runs.length === 0) {
      // No data yet — show placeholder message centered on canvas
      ctx.fillStyle = 'rgba(180, 200, 240, 0.5)';
      ctx.font = '16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No simulation data', cw / 2, ch / 2);
      return; // Nothing else to draw
    }

    // ── HELPER: DRAW A TRAJECTORY ──────────────────────────────────────
    // Draws a sequence of (x,y) world points as a polyline on the canvas.
    // The drawLine helper avoids code duplication for each trajectory type.
    const drawPolyline = (
      points: Array<{ x: number; y: number }>,
      color: string,
      lineWidth: number,
      dashed: boolean = false
    ) => {
      if (points.length < 2) return; // Need at least 2 points for a line

      ctx.strokeStyle = color;   // Set stroke color
      ctx.lineWidth   = lineWidth; // Set stroke width (pixels)

      // Set or clear dash pattern: dashed lines for envelope bounds
      if (dashed) ctx.setLineDash([8, 5]); // 8px dash, 5px gap — readable but clearly dashed
      else ctx.setLineDash([]);            // Solid line

      ctx.beginPath(); // Start a new path (prevents connection to previous drawing)

      // Move to the first point without drawing (lift pen)
      const first = worldToScreen(points[0].x, points[0].y, cw, ch);
      ctx.moveTo(first.sx, first.sy);

      // Draw a line to each subsequent point
      for (let i = 1; i < points.length; i++) {
        const pt = worldToScreen(points[i].x, points[i].y, cw, ch);
        ctx.lineTo(pt.sx, pt.sy); // Draw line segment to this point
      }

      ctx.stroke(); // Render the path onto the canvas
      ctx.setLineDash([]); // Reset dash pattern so subsequent draws aren't affected
    };

    // ── GRID LINES ─────────────────────────────────────────────────────
    // Draw a reference grid every N meters in world space.
    // Choose grid spacing based on how much world space is visible (zoom-responsive).
    const visibleWorldH = ch / scaleRef.current; // Total altitude visible in current view (meters)
    // Grid spacing: pick a "round" number that gives ~6-10 grid lines on screen
    // We use a sequence of multiples of 1, 2, 5 to get nice round numbers
    const rawSpacing = visibleWorldH / 8; // Aim for 8 grid lines vertically
    const magnitude  = Math.pow(10, Math.floor(Math.log10(rawSpacing))); // Order of magnitude
    const normalized = rawSpacing / magnitude; // Normalized to 1-10 range
    const gridSpacing = magnitude * (normalized < 2 ? 1 : normalized < 5 ? 2 : 5); // Round up

    // Horizontal grid lines (constant altitude)
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([]); // Solid grid lines

    // Find first grid line above panY (world bottom) and draw upward
    const firstGridY = Math.ceil(panYRef.current / gridSpacing) * gridSpacing;
    for (let wy = firstGridY; wy < panYRef.current + visibleWorldH + gridSpacing; wy += gridSpacing) {
      const { sy } = worldToScreen(0, wy, cw, ch); // Screen Y position of this world altitude
      if (sy < -10 || sy > ch + 10) continue; // Skip lines outside the visible area (with margin)
      ctx.beginPath();
      ctx.moveTo(50, sy);  // Start at left margin (50px for axis labels)
      ctx.lineTo(cw, sy);  // Extend to right edge
      ctx.stroke();

      // Altitude label on the left axis
      ctx.fillStyle = AXIS_COLOR;
      ctx.font      = '10px monospace';
      ctx.textAlign = 'right';
      // Format: km if ≥ 1000m, meters otherwise
      const label = wy >= 1000 ? `${(wy / 1000).toFixed(1)}km` : `${wy.toFixed(0)}m`;
      ctx.fillText(label, 46, sy + 3); // Slightly below the grid line for readability
    }

    // Vertical grid lines (constant horizontal distance)
    const visibleWorldW = cw / scaleRef.current; // Total horizontal range visible (meters)
    const rawSpacingX   = visibleWorldW / 6;     // Aim for 6 grid lines horizontally
    const magX          = Math.pow(10, Math.floor(Math.log10(Math.abs(rawSpacingX) + 1)));
    const normX         = rawSpacingX / magX;
    const gridSpacingX  = magX * (normX < 2 ? 1 : normX < 5 ? 2 : 5);

    const firstGridX = Math.ceil(panXRef.current / gridSpacingX) * gridSpacingX;
    for (let wx = firstGridX; wx < panXRef.current + visibleWorldW + gridSpacingX; wx += gridSpacingX) {
      const { sx } = worldToScreen(wx, 0, cw, ch); // Screen X for this world X
      if (sx < 50 || sx > cw + 10) continue; // Skip lines outside visible area
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, 0);       // Top of canvas
      ctx.lineTo(sx, ch - 30); // Bottom, leaving 30px for X-axis labels
      ctx.stroke();

      // Horizontal distance label on the bottom axis
      ctx.fillStyle = AXIS_COLOR;
      ctx.font      = '10px monospace';
      ctx.textAlign = 'center';
      const labelX = Math.abs(wx) >= 1000 ? `${(wx / 1000).toFixed(1)}km` : `${wx.toFixed(0)}m`;
      ctx.fillText(labelX, sx, ch - 8); // Just above canvas bottom edge
    }

    // Ground line (y = 0 in world space — the launch pad level)
    ctx.strokeStyle = 'rgba(50, 150, 50, 0.6)'; // Dark green: represents Earth's surface
    ctx.lineWidth   = 1.5;
    const { sy: groundSy } = worldToScreen(0, 0, cw, ch); // Screen Y of y=0 world
    ctx.beginPath();
    ctx.moveTo(50, groundSy);
    ctx.lineTo(cw, groundSy);
    ctx.stroke();

    // ── NOMINAL (GREEN) TRAJECTORIES ──────────────────────────────────
    // Draw all nominal runs first (behind failure runs and envelope)
    // Semi-transparent so individual runs are visible but bundle has density
    for (const run of runs) {
      if (run.outcome !== 'nominal') continue; // Skip failed runs (drawn separately below)
      if (run.id === selectedRunId) continue;  // Skip selected run (drawn last for emphasis)
      drawPolyline(run.trajectoryHistory, NOMINAL_COLOR, 1); // Thin semi-transparent green
    }

    // ── FAILED (RED) TRAJECTORIES ─────────────────────────────────────
    // Drawn on top of nominal runs so failures are visible through the green bundle
    for (const run of runs) {
      if (run.outcome === 'nominal') continue; // Skip nominal runs (already drawn)
      if (run.id === selectedRunId) continue;  // Skip selected run
      drawPolyline(run.trajectoryHistory, FAILURE_COLOR, 1); // Thin semi-transparent red
    }

    // ── ENVELOPE BOUNDS (CYAN DASHED) ─────────────────────────────────
    // 95th percentile (upper bound): 95% of runs stay BELOW this curve
    drawPolyline(envelope.upper, ENVELOPE_COLOR, 1.5, true); // Dashed cyan, slightly thicker
    // 5th percentile (lower bound): 95% of runs reach ABOVE this curve
    drawPolyline(envelope.lower, ENVELOPE_COLOR, 1.5, true);

    // ── MEAN TRAJECTORY (WHITE THICK) ──────────────────────────────────
    // The statistical "expected" trajectory — average position at each time point
    // Drawn thicker (2.5px) so it stands out as the centerline of the bundle
    drawPolyline(envelope.mean, MEAN_COLOR, 2.5);

    // ── PLAYER TRAJECTORY (GOLD) ───────────────────────────────────────
    // The player's manual flight — shown for comparison against the MC bundle
    // Gold color (distinct from all other lines) draws attention to the comparison
    if (playerTrajectory && playerTrajectory.length >= 2) {
      drawPolyline(playerTrajectory, PLAYER_COLOR, 2.5); // Same thickness as mean
      // Draw a gold dot at the player's launch position (launch pad marker)
      const { sx: psx, sy: psy } = worldToScreen(playerTrajectory[0].x, playerTrajectory[0].y, cw, ch);
      ctx.fillStyle = PLAYER_COLOR;
      ctx.beginPath();
      ctx.arc(psx, psy, 4, 0, Math.PI * 2); // 4px radius dot
      ctx.fill();
    }

    // ── SELECTED/HIGHLIGHTED RUN ────────────────────────────────────────
    // The run the user clicked on in the table — drawn last so it's on top
    if (selectedRunId !== null && selectedRunId !== undefined) {
      const selectedRun = runs.find(r => r.id === selectedRunId);
      if (selectedRun) {
        // Use bright opaque color depending on outcome
        const highlightColor = selectedRun.outcome === 'nominal'
          ? NOMINAL_SELECTED  // Bright green for nominal
          : FAILURE_SELECTED; // Bright red for failures
        drawPolyline(selectedRun.trajectoryHistory, highlightColor, 2.5); // Thicker highlighted line

        // Draw a dot at the peak altitude of the selected run (visual emphasis)
        // Find the trajectory point with maximum altitude
        const peakPoint = selectedRun.trajectoryHistory.reduce(
          (best, pt) => pt.y > best.y ? pt : best,
          selectedRun.trajectoryHistory[0]
        );
        if (peakPoint) {
          const { sx: peakSx, sy: peakSy } = worldToScreen(peakPoint.x, peakPoint.y, cw, ch);
          ctx.fillStyle = highlightColor;
          ctx.beginPath();
          ctx.arc(peakSx, peakSy, 5, 0, Math.PI * 2); // 5px dot at peak altitude
          ctx.fill();
        }
      }
    }

    // ── HOVER TOOLTIP BACKGROUND ────────────────────────────────────────
    // Drawn last so it appears on top of all trajectories
    if (tooltip) {
      const tw = 200; // Tooltip box width in pixels
      const th = 80;  // Tooltip box height in pixels
      // Position tooltip: shift left if too close to right edge
      const tx = tooltip.sx + tw > cw ? tooltip.sx - tw - 10 : tooltip.sx + 10;
      const ty = tooltip.sy - th / 2; // Center vertically on mouse position

      // Tooltip background box — use the cross-browser rounded-rect helper.
      // ctx.roundRect() is only available in Chrome 99+/Firefox 112+/Safari 15.4+;
      // the helper falls back to arcTo() on older browsers.
      ctx.fillStyle = 'rgba(5, 10, 30, 0.92)'; // Near-opaque dark background
      ctx.strokeStyle = 'rgba(0, 200, 80, 0.8)'; // Green border for nominal
      ctx.lineWidth = 1;
      roundRectPathLocal(ctx, tx, ty, tw, th, 4); // Fill path
      ctx.fill();
      roundRectPathLocal(ctx, tx, ty, tw, th, 4); // Re-path for stroke
      ctx.stroke();

      // Tooltip text
      const run = tooltip.run;
      ctx.fillStyle = '#ffffff'; // White text
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`Run #${run.id + 1}`, tx + 8, ty + 16);                              // Run ID (1-based for display)
      ctx.fillText(`Max Alt: ${(run.maxAltitude / 1000).toFixed(2)} km`, tx + 8, ty + 30); // Peak altitude
      ctx.fillText(`Landing: ${run.landingVelocity.toFixed(1)} m/s`, tx + 8, ty + 44);   // Landing speed
      ctx.fillText(`Score: ${run.landingScore}/100`, tx + 8, ty + 58);                    // Quality score
      // Outcome label with color coding
      ctx.fillStyle = run.outcome === 'nominal' ? '#00ff88' : '#ff6666'; // Green/red based on outcome
      ctx.fillText(run.outcome.replace('_', ' ').toUpperCase(), tx + 8, ty + 72); // Human-readable status
    }

    // ── AXIS LABELS ─────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(200, 220, 255, 0.7)'; // Light blue axis labels
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Alt.', 2, 12); // Y-axis title (abbreviated for space)
    ctx.textAlign = 'center';
    ctx.fillText('Horizontal Distance', cw / 2, ch - 18); // X-axis title

    // ── LEGEND ──────────────────────────────────────────────────────────
    // Color legend in the top-right corner explaining what each line means
    const legendX = cw - 170; // Right-aligned legend
    const legendY = 12;        // Top of legend

    // Legend background box
    ctx.fillStyle = 'rgba(4, 6, 20, 0.85)'; // Match background
    ctx.fillRect(legendX - 8, legendY - 6, 178, playerTrajectory ? 110 : 95);

    // Legend entries: colored line sample + label text
    const legendItems: Array<{ color: string; label: string; dashed?: boolean; width?: number }> = [
      { color: 'rgba(0, 200, 80, 0.6)',  label: `Nominal (${runs.filter(r => r.outcome === 'nominal').length})`, width: 2 },
      { color: 'rgba(255, 60, 60, 0.6)', label: `Failed (${runs.filter(r => r.outcome !== 'nominal').length})`, width: 2 },
      { color: MEAN_COLOR,               label: 'Mean trajectory', width: 2.5 },
      { color: ENVELOPE_COLOR,           label: '95% CI envelope', dashed: true, width: 1.5 },
      { color: PLAYER_COLOR,             label: 'Your flight', width: 2.5 },
    ];

    legendItems.forEach((item, i) => {
      if (item.label.startsWith('Your') && !playerTrajectory) return; // Skip player line if no data
      const ly = legendY + i * 18; // Vertical position for this legend entry

      // Draw sample line
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.width ?? 1.5;
      if (item.dashed) ctx.setLineDash([5, 3]); // Dashed sample for envelope
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(legendX, ly + 4);          // Start of sample line
      ctx.lineTo(legendX + 24, ly + 4);     // End of sample line (24px long)
      ctx.stroke();
      ctx.setLineDash([]); // Reset after drawing

      // Label text
      ctx.fillStyle = 'rgba(200, 220, 255, 0.85)'; // Light blue label text
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(item.label, legendX + 28, ly + 7); // Text right of the sample line
    });

    // ── LAUNCH PAD MARKER ────────────────────────────────────────────────
    // Mark the origin (0,0) with a small launch pad icon
    const { sx: padSx, sy: padSy } = worldToScreen(0, 0, cw, ch);
    ctx.fillStyle = 'rgba(255, 200, 100, 0.8)'; // Orange-yellow launch pad indicator
    ctx.fillRect(padSx - 4, padSy - 1, 8, 2);   // Horizontal launch pad line
    ctx.fillRect(padSx - 1, padSy - 6, 2, 6);   // Vertical pad tower

  }, [runs, envelope, playerTrajectory, selectedRunId, tooltip, worldToScreen]);

  // ── INITIAL AUTO-FIT ────────────────────────────────────────────────────
  // When runs data arrives, compute the auto-fit transform and do the first draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || runs.length === 0) return;

    // Set canvas dimensions to match the container (CSS fill)
    canvas.width  = container.clientWidth;  // Canvas buffer width = container pixel width
    canvas.height = container.clientHeight; // Canvas buffer height = container pixel height

    // Compute the auto-fit transform (scale and pan to show all trajectories)
    computeAutoFit(canvas.width, canvas.height);
    // Draw the canvas with the new transform
    drawCanvas();
  }, [runs, computeAutoFit, drawCanvas]); // Re-run whenever runs data changes

  // ── REDRAW WHEN SELECTED RUN OR TOOLTIP CHANGES ────────────────────────
  // React state changes for hoveredRunId/tooltip don't need auto-fit, just a redraw
  useEffect(() => {
    drawCanvas();
  }, [selectedRunId, tooltip, drawCanvas]);

  // ── RESIZE HANDLER ────────────────────────────────────────────────────
  // When the container resizes (e.g., user resizes window), update canvas size and redraw
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ResizeObserver fires whenever the container element's size changes
    const observer = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width  = container.clientWidth;  // Update canvas buffer width
      canvas.height = container.clientHeight; // Update canvas buffer height
      computeAutoFit(canvas.width, canvas.height); // Recompute transform for new size
      drawCanvas(); // Redraw at new size
    });

    observer.observe(container); // Watch this container for size changes
    return () => observer.disconnect(); // Cleanup: stop watching on unmount
  }, [computeAutoFit, drawCanvas]);

  // ── MOUSE WHEEL (ZOOM) ──────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault(); // Prevent page scrolling while zooming the canvas

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ch = canvas.height;

    // Mouse position in screen pixels (relative to canvas top-left)
    const mouseScreenX = e.clientX - canvas.getBoundingClientRect().left;
    const mouseScreenY = e.clientY - canvas.getBoundingClientRect().top;

    // Convert mouse screen position to world position (before zoom)
    // This world position should STAY FIXED as we zoom — zoom is centered on cursor
    const mouseWorldX = mouseScreenX / scaleRef.current + panXRef.current;
    const mouseWorldY = (ch - mouseScreenY) / scaleRef.current + panYRef.current;

    // Zoom factor: 1.1 per wheel tick (zoom in on scroll up, zoom out on scroll down)
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.91; // 1/1.1 ≈ 0.91 for symmetric zoom
    const newScale = Math.max(0.0001, Math.min(10, scaleRef.current * zoomFactor));
    // Clamp scale: min 0.0001 (very zoomed out), max 10 (very zoomed in)

    // Adjust pan so the world point under the cursor stays at the same screen position
    // Before: mouseScreenX = (mouseWorldX - panX) * oldScale → panX = mouseWorldX - mouseScreenX / oldScale
    // After:  mouseScreenX = (mouseWorldX - newPanX) * newScale → newPanX = mouseWorldX - mouseScreenX / newScale
    const newPanX = mouseWorldX - mouseScreenX / newScale;
    const newPanY = mouseWorldY - (ch - mouseScreenY) / newScale;

    scaleRef.current = newScale; // Apply new scale
    panXRef.current  = newPanX; // Apply adjusted pan to keep cursor point fixed
    panYRef.current  = newPanY;

    drawCanvas(); // Redraw with new transform
  }, [drawCanvas]);

  // ── MOUSE DOWN (PAN START) ──────────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return; // Only handle left mouse button
    isDraggingRef.current = true; // Begin drag mode
    // Record starting mouse position (in screen pixels)
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.style.cursor = 'grabbing'; // Visual feedback: change cursor to closed hand
  }, []);

  // ── MOUSE MOVE (PAN AND HOVER) ──────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ch = canvas.height;

    // ── PANNING ────────────────────────────────────────────────────
    if (isDraggingRef.current) {
      // Compute how far the mouse moved in screen pixels since last event
      const dx = e.clientX - lastMouseRef.current.x; // Pixels moved right (positive = right)
      const dy = e.clientY - lastMouseRef.current.y; // Pixels moved down (positive = down)

      // Convert screen pixel delta to world-space delta and adjust pan
      // Moving mouse right (dx > 0) should pan the view LEFT (decrease panX to show more to the right)
      panXRef.current -= dx / scaleRef.current; // Convert pixels to meters and invert
      // Moving mouse down (dy > 0) should pan view DOWN in screen space = UP in world space
      // In world space, Y is up; moving the canvas view down means panY should decrease
      panYRef.current += dy / scaleRef.current; // Convert pixels to meters (Y is already correct direction)

      lastMouseRef.current = { x: e.clientX, y: e.clientY }; // Update last position
      drawCanvas(); // Redraw panned view
      return; // Skip hover detection during panning (performance optimization)
    }

    // ── HOVER DETECTION ────────────────────────────────────────────
    // When not dragging, check if mouse is near any trajectory for tooltip display

    // Mouse position in screen pixels relative to canvas
    const mouseScreenX = e.clientX - canvas.getBoundingClientRect().left;
    const mouseScreenY = e.clientY - canvas.getBoundingClientRect().top;

    // Convert to world coordinates for distance comparisons
    const { wx: mouseWorldX, wy: mouseWorldY } = screenToWorld(mouseScreenX, mouseScreenY, ch);

    // Hover detection threshold: 15 meters in world space
    // At typical zoom (say 0.01 px/m), 15m = 0.15 screen pixels — too small
    // Better to use SCREEN pixels threshold and convert to world units
    const hoverThresholdPixels = 10; // Within 10 pixels = "near" a trajectory
    const hoverThresholdWorld  = hoverThresholdPixels / scaleRef.current; // In world meters

    let closestRun: SimulationRun | null = null;
    let closestDist = Infinity; // Track the nearest distance found so far

    for (const run of runs) {
      // Check each segment of this run's trajectory for proximity to mouse
      for (let i = 0; i < run.trajectoryHistory.length - 1; i++) {
        const p0 = run.trajectoryHistory[i];
        const p1 = run.trajectoryHistory[i + 1];

        // Point-to-line-segment distance in world space
        // Project mouse point onto the segment and clamp to [0,1]
        const segDx = p1.x - p0.x;
        const segDy = p1.y - p0.y;
        const segLen2 = segDx * segDx + segDy * segDy; // Segment length squared
        if (segLen2 === 0) continue; // Skip degenerate zero-length segments

        // Parameter t in [0,1] for the closest point on the segment
        const t = Math.max(0, Math.min(1,
          ((mouseWorldX - p0.x) * segDx + (mouseWorldY - p0.y) * segDy) / segLen2
        ));
        // Closest point on segment
        const closestX = p0.x + t * segDx;
        const closestY = p0.y + t * segDy;
        // Distance from mouse to closest point on segment
        const dist = Math.sqrt(
          (mouseWorldX - closestX) * (mouseWorldX - closestX) +
          (mouseWorldY - closestY) * (mouseWorldY - closestY)
        );

        if (dist < closestDist) {
          closestDist = dist; // New closest segment found
          closestRun  = run;  // This run is currently the closest
        }
      }
    }

    // If mouse is within the hover threshold of any trajectory, show tooltip
    if (closestRun && closestDist < hoverThresholdWorld) {
      setHoveredRunId(closestRun.id); // Set hovered run ID for visual highlighting
      setTooltip({
        sx: mouseScreenX, // Screen position for tooltip placement
        sy: mouseScreenY,
        run: closestRun,
      });
    } else {
      // Mouse is not near any trajectory — clear tooltip
      setHoveredRunId(null);
      setTooltip(null);
    }
  }, [runs, drawCanvas, screenToWorld]);

  // ── MOUSE UP (PAN END) ──────────────────────────────────────────────────
  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return; // Nothing to do if not currently panning
    isDraggingRef.current = false; // End drag mode
    e.currentTarget.style.cursor = 'grab'; // Restore grab cursor

    // If the mouse barely moved (< 5 pixels), treat as a click for run selection
    const totalMoved = Math.abs(e.clientX - lastMouseRef.current.x) +
                       Math.abs(e.clientY - lastMouseRef.current.y);
    if (totalMoved < 5 && hoveredRunId !== null && onRunSelect) {
      onRunSelect(hoveredRunId); // Notify parent component of run selection
    }
  }, [hoveredRunId, onRunSelect]);

  // ── MOUSE LEAVE ──────────────────────────────────────────────────────────
  const handleMouseLeave = useCallback(() => {
    isDraggingRef.current = false; // Cancel panning if mouse leaves canvas
    setHoveredRunId(null);         // Clear hover state
    setTooltip(null);              // Hide tooltip
  }, []);

  // ── RESET VIEW BUTTON ────────────────────────────────────────────────────
  const handleResetView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    computeAutoFit(canvas.width, canvas.height); // Recompute auto-fit transform
    drawCanvas(); // Redraw at auto-fit view
  }, [computeAutoFit, drawCanvas]);

  // ── EXPORT PNG ───────────────────────────────────────────────────────────
  const handleExportPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create a temporary <a> element to trigger the browser download
    const link = document.createElement('a');
    link.download = `monte-carlo-trajectories-${Date.now()}.png`; // Filename with timestamp
    link.href = canvas.toDataURL('image/png'); // Convert canvas to base64 PNG data URL
    link.click(); // Programmatically click to trigger download
    link.remove(); // Clean up the temporary element
  }, []);

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    // Container div fills its parent (MonteCarloPanel determines the actual size)
    <div
      ref={containerRef}
      style={{
        position: 'relative', // Relative so buttons can be absolutely positioned inside
        width: '100%',        // Fill available width from parent
        height: '100%',       // Fill available height from parent
        overflow: 'hidden',   // Clip canvas at container boundary
      }}
    >
      {/* Canvas element: fills the container, sized to match clientWidth/clientHeight */}
      <canvas
        ref={canvasRef}
        onWheel={handleWheel}          // Zoom on mouse wheel scroll
        onMouseDown={handleMouseDown}   // Begin pan drag
        onMouseMove={handleMouseMove}   // Update pan / hover detection
        onMouseUp={handleMouseUp}       // End pan drag
        onMouseLeave={handleMouseLeave} // Cancel interaction if mouse exits canvas
        style={{
          display: 'block',   // Remove default inline gap below canvas
          width: '100%',      // CSS size = 100% of container (matches buffer size)
          height: '100%',
          cursor: 'grab',     // Default cursor: open hand (indicates draggable)
        }}
      />

      {/* Control buttons: overlaid in top-left corner of the plot */}
      <div
        style={{
          position: 'absolute', // Float over the canvas
          top: 8,               // 8px from top edge
          left: 56,             // 56px from left (past the axis labels)
          display: 'flex',
          gap: 6,               // 6px spacing between buttons
        }}
      >
        {/* Reset view button: returns to auto-fit zoom/pan */}
        <button
          onClick={handleResetView}
          style={{
            padding: '3px 8px',
            fontSize: '11px',
            fontFamily: 'monospace',
            backgroundColor: 'rgba(10, 20, 50, 0.85)',
            color: 'rgba(180, 210, 255, 0.9)',
            border: '1px solid rgba(80, 120, 200, 0.5)',
            borderRadius: 3,
            cursor: 'pointer',
          }}
          title="Reset zoom/pan to fit all trajectories"
        >
          ⊡ Fit
        </button>

        {/* Export PNG button: saves the current canvas view as a PNG file */}
        <button
          onClick={handleExportPng}
          style={{
            padding: '3px 8px',
            fontSize: '11px',
            fontFamily: 'monospace',
            backgroundColor: 'rgba(10, 20, 50, 0.85)',
            color: 'rgba(180, 210, 255, 0.9)',
            border: '1px solid rgba(80, 120, 200, 0.5)',
            borderRadius: 3,
            cursor: 'pointer',
          }}
          title="Export current view as PNG image"
        >
          ⬇ PNG
        </button>
      </div>

      {/* Scroll hint text: appears in bottom-right when no data */}
      {runs.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: 36,           // Above the x-axis label area
            right: 8,
            fontSize: '9px',
            fontFamily: 'monospace',
            color: 'rgba(100, 130, 180, 0.6)',
            pointerEvents: 'none', // Don't block mouse events on canvas
          }}
        >
          scroll to zoom · drag to pan
        </div>
      )}
    </div>
  );
};
