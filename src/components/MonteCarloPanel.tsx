/**
 * MONTE CARLO PANEL
 * =================
 * Full-screen results visualization panel displayed after a Monte Carlo simulation completes.
 *
 * LAYOUT:
 *   ┌─────────────────────────────────────────────────────────────────────────┐
 *   │  HEADER: "Monte Carlo Analysis" + run count + close button              │
 *   ├──────────────┬──────────────┬──────────────┬──────────────────────────  │
 *   │  Mean Alt    │  Success     │  Dispersion  │  95% CI Altitude           │
 *   │  127.3 km    │  Rate 94%    │  ±2.4 km     │  [112, 143] km             │
 *   ├─────────────────────────────────┬─────────────────────────────────────  │
 *   │                                 │  Altitude histogram (bar chart)       │
 *   │   TRAJECTORY ENVELOPE PLOT      │  Landing velocity histogram           │
 *   │   (zoomable/pannable canvas)    │  Outcome pie chart                    │
 *   │                                 │  Best/worst runs table                │
 *   ├─────────────────────────────────┴─────────────────────────────────────  │
 *   │  SCROLLABLE RUN LIST: ID | Alt | Landing V | Score | Outcome | Failure  │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 * The trajectory plot (left 60%) shows all simulation runs overlaid as colored lines.
 * The statistics panel (right 40%) shows histograms and charts built on canvas elements.
 * Clicking a row in the run list highlights that trajectory in the plot.
 *
 * AEROSPACE CONTEXT:
 * This panel mirrors the "Trajectory Dispersion Analysis" reports produced by flight
 * dynamics teams at SpaceX, ULA, and NASA before every mission. Engineers use these
 * visualizations to verify the rocket performs within specifications across thousands
 * of possible environmental and hardware variations.
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';

// Import simulation result interfaces from the Monte Carlo engine
import type {
  SimulationRun,
  MonteCarloResults,
} from '../physics/MonteCarloSimulator';

// Import the canvas-based trajectory visualization component
import { TrajectoryEnvelopePlot } from './TrajectoryEnvelopePlot';

// Import color constants to match the simulator's visual style
import { COLORS } from '../utils/constants';

// ─── PROPS ─────────────────────────────────────────────────────────────────────

/**
 * Props for the MonteCarloPanel component.
 */
interface MonteCarloPanelProps {
  results: MonteCarloResults;                              // All simulation results and statistics
  playerTrajectory?: Array<{ x: number; y: number }>;    // Player's manual flight (gold comparison line)
  onClose: () => void;                                     // Called when user clicks "Close" button
}

// ─── CHART HELPERS ─────────────────────────────────────────────────────────────

/**
 * Draw a bar chart histogram on a canvas element.
 *
 * WHAT IS A HISTOGRAM?
 * A histogram divides a dataset into equal-width "bins" and counts how many
 * values fall in each bin. The height of each bar represents that count.
 * It reveals the SHAPE of the distribution:
 *   - Bell curve (Gaussian): most outcomes near the mean, few extremes
 *   - Skewed left: a few low outliers dragging the tail down
 *   - Bimodal (two humps): two distinct groups (e.g., nominal and failed runs)
 *
 * @param canvas   The canvas element to draw on
 * @param values   The data values to histogram
 * @param bins     Number of bins to divide the range into (default: 10)
 * @param title    Chart title text
 * @param unit     Unit string for axis labels (e.g., "km", "m/s")
 * @param color    Bar fill color
 */
function drawHistogram(
  canvas: HTMLCanvasElement,
  values: number[],
  bins: number,
  title: string,
  unit: string,
  color: string
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || values.length === 0) return; // Guard: need context and data

  const cw = canvas.width;   // Canvas pixel width
  const ch = canvas.height;  // Canvas pixel height

  // Margins for labels and padding
  const marginLeft   = 36; // Left margin for Y-axis value labels
  const marginBottom = 22; // Bottom margin for X-axis labels
  const marginTop    = 18; // Top margin for chart title
  const marginRight  = 6;  // Small right margin for visual breathing room

  // Plot area dimensions (inside the margins)
  const plotW = cw - marginLeft - marginRight; // Width of the bars area
  const plotH = ch - marginBottom - marginTop; // Height of the bars area

  // ── COMPUTE HISTOGRAM BINS ──────────────────────────────────────────
  const minVal = Math.min(...values); // Lowest data value
  const maxVal = Math.max(...values); // Highest data value
  const range  = maxVal - minVal;      // Total span of the data

  // Handle edge case: all values are identical (zero range)
  if (range === 0) {
    ctx.fillStyle = 'rgba(180, 200, 240, 0.5)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('All identical', cw / 2, ch / 2);
    return;
  }

  const binWidth = range / bins; // World-space width of each bin
  const binCounts = new Array(bins).fill(0); // Count of values in each bin

  for (const v of values) {
    // Compute which bin this value falls into
    // Math.min(bins - 1, ...) ensures the maximum value lands in the last bin
    const idx = Math.min(bins - 1, Math.floor((v - minVal) / binWidth));
    binCounts[idx]++; // Increment this bin's count
  }

  const maxCount = Math.max(...binCounts); // Highest bin count (for Y-axis scaling)

  // ── CLEAR AND BACKGROUND ────────────────────────────────────────────
  ctx.fillStyle = 'rgba(4, 8, 22, 1)'; // Dark background matching the panel
  ctx.fillRect(0, 0, cw, ch);

  // ── DRAW BARS ──────────────────────────────────────────────────────
  const barW = plotW / bins; // Pixel width of each bar (equally divided)

  for (let i = 0; i < bins; i++) {
    // Bar height as a fraction of the maximum count (normalized to plotH)
    const barHeight = (binCounts[i] / maxCount) * plotH;
    // X position: left edge of this bar (left-to-right)
    const barX = marginLeft + i * barW;
    // Y position: top of this bar (canvas Y decreases upward, so subtract from bottom)
    const barY = marginTop + plotH - barHeight;

    // Main bar fill
    ctx.fillStyle = color;
    ctx.fillRect(barX + 1, barY, barW - 2, barHeight); // 1px gap on each side for separation

    // Subtle highlight on bar top edge for visual depth
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(barX + 1, barY, barW - 2, 2); // 2px bright line at top
  }

  // ── AXES ────────────────────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(100, 130, 180, 0.5)'; // Faint blue axis lines
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(marginLeft, marginTop);                    // Y-axis top
  ctx.lineTo(marginLeft, marginTop + plotH);            // Y-axis bottom
  ctx.lineTo(marginLeft + plotW, marginTop + plotH);   // X-axis right
  ctx.stroke();

  // ── X-AXIS LABELS (min and max values) ──────────────────────────────
  ctx.fillStyle = 'rgba(180, 200, 240, 0.7)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  // Format large numbers with appropriate unit (km vs m, etc.)
  const fmtVal = (v: number) => unit === 'km' ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0);
  ctx.fillText(fmtVal(minVal), marginLeft, ch - 4);          // Min value at left
  ctx.textAlign = 'right';
  ctx.fillText(`${fmtVal(maxVal)}${unit}`, cw - marginRight, ch - 4); // Max value with unit at right

  // Middle value label
  ctx.textAlign = 'center';
  ctx.fillText(fmtVal((minVal + maxVal) / 2), cw / 2, ch - 4); // Midpoint

  // ── Y-AXIS LABELS (counts) ────────────────────────────────────────
  ctx.textAlign = 'right';
  ctx.fillText(`${maxCount}`, marginLeft - 2, marginTop + 8);    // Max count at top
  ctx.fillText('0', marginLeft - 2, marginTop + plotH);          // Zero at bottom

  // ── TITLE ────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(200, 220, 255, 0.85)';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(title, cw / 2, marginTop - 4); // Title above the plot area
}

/**
 * Draw a pie chart showing the fraction of nominal, partial_failure, engine_failure,
 * and structural_failure outcomes across all simulation runs.
 *
 * WHAT A PIE CHART SHOWS HERE:
 * The relative proportion of mission outcomes. In real mission analysis:
 *   - > 95% success rate: mission design is robust
 *   - 90-95% success: acceptable with marginal reserve
 *   - < 90% success: dispersion budget exceeded, rocket needs redesign
 *
 * @param canvas  The canvas element to draw on
 * @param runs    All simulation runs with outcome classifications
 */
function drawPieChart(canvas: HTMLCanvasElement, runs: SimulationRun[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || runs.length === 0) return; // Guard: need context and data

  const cw = canvas.width;
  const ch = canvas.height;

  // Center and radius of the pie chart
  const cx = cw / 2;       // Horizontal center
  const cy = ch / 2 - 8;  // Vertical center (shifted up slightly to leave room for legend)
  const r  = Math.min(cw, ch) * 0.32; // Radius: 32% of the smaller dimension

  // Count each outcome category
  const counts = {
    nominal:            runs.filter(run => run.outcome === 'nominal').length,
    partial_failure:    runs.filter(run => run.outcome === 'partial_failure').length,
    engine_failure:     runs.filter(run => run.outcome === 'engine_failure').length,
    structural_failure: runs.filter(run => run.outcome === 'structural_failure').length,
  };

  const total = runs.length; // Total runs for percentage computation

  // Pie segments: label, count, color
  const segments: Array<{ label: string; count: number; color: string }> = [
    { label: 'Nominal',     count: counts.nominal,            color: 'rgba(0, 200, 80, 0.85)'   },
    { label: 'Partial Fail',count: counts.partial_failure,    color: 'rgba(255, 180, 0, 0.85)'  },
    { label: 'Engine Fail', count: counts.engine_failure,     color: 'rgba(255, 100, 30, 0.85)' },
    { label: 'Structural',  count: counts.structural_failure, color: 'rgba(255, 50, 50, 0.85)'  },
  ].filter(seg => seg.count > 0); // Only draw segments with at least one run

  // ── CLEAR BACKGROUND ────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(4, 8, 22, 1)';
  ctx.fillRect(0, 0, cw, ch);

  // ── DRAW PIE SLICES ──────────────────────────────────────────────────
  let currentAngle = -Math.PI / 2; // Start at the top (12 o'clock position)

  for (const seg of segments) {
    if (seg.count === 0) continue; // Skip empty segments

    // Arc angle proportional to this segment's fraction of total
    const sliceAngle = (seg.count / total) * (Math.PI * 2);

    ctx.fillStyle = seg.color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);                           // Center of pie
    ctx.arc(cx, cy, r, currentAngle, currentAngle + sliceAngle); // Arc
    ctx.closePath();                               // Line back to center
    ctx.fill();

    // Thin separator lines between slices for clarity
    ctx.strokeStyle = 'rgba(4, 8, 22, 0.7)'; // Background color separator
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Percentage label inside the slice (if large enough to fit)
    const pct = (seg.count / total * 100);
    if (pct > 6) { // Only label slices wider than 6% (otherwise too cramped)
      const labelAngle = currentAngle + sliceAngle / 2; // Middle of this arc
      const labelR = r * 0.65; // 65% of radius from center
      const labelX = cx + Math.cos(labelAngle) * labelR;
      const labelY = cy + Math.sin(labelAngle) * labelR;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'; // White percentage labels
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${pct.toFixed(0)}%`, labelX, labelY + 3);
    }

    currentAngle += sliceAngle; // Advance to the next slice starting angle
  }

  // ── LEGEND ──────────────────────────────────────────────────────────
  const legendY = cy + r + 8; // Below the pie circle
  let legendX = 8;             // Start from left edge

  for (const seg of segments) {
    if (seg.count === 0) continue;
    // Color swatch
    ctx.fillStyle = seg.color;
    ctx.fillRect(legendX, legendY, 10, 10); // 10×10 color square
    // Label text
    ctx.fillStyle = 'rgba(180, 200, 240, 0.8)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${seg.label} (${seg.count})`, legendX + 12, legendY + 9);
    legendX += ctx.measureText(`${seg.label} (${seg.count})`).width + 18; // Advance right
  }

  // ── TITLE ────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(200, 220, 255, 0.85)';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Mission Outcome Distribution', cw / 2, 12); // Top of canvas
}

// ─── COMPONENT ─────────────────────────────────────────────────────────────────

/**
 * MonteCarloPanel — full-screen overlay displaying all Monte Carlo analysis results.
 * This is the "mission analysis report" view that appears after simulations complete.
 */
export const MonteCarloPanel: React.FC<MonteCarloPanelProps> = ({
  results,
  playerTrajectory,
  onClose,
}) => {
  // ── RUN LIST SELECTION STATE ─────────────────────────────────────────────
  // When the user clicks a row in the run list, we highlight that trajectory.
  // null = no selection; a run ID = that run is highlighted in the plot.
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  // ── CHART CANVAS REFS ────────────────────────────────────────────────────
  // Each chart is drawn on its own <canvas> element.
  // We use refs to access the DOM elements for drawing after mount.
  const altHistRef       = useRef<HTMLCanvasElement>(null); // Max altitude histogram
  const velHistRef       = useRef<HTMLCanvasElement>(null); // Landing velocity histogram
  const pieChartRef      = useRef<HTMLCanvasElement>(null); // Outcome pie chart

  // ── DRAW CHARTS ON MOUNT AND WHEN RESULTS CHANGE ────────────────────────
  useEffect(() => {
    // Draw altitude distribution histogram
    if (altHistRef.current) {
      drawHistogram(
        altHistRef.current,
        results.runs.map(r => r.maxAltitude),   // Array of all peak altitudes (meters)
        10,                                       // 10 bins: enough granularity at 50 runs
        'Max Altitude Distribution',              // Chart title
        'km',                                     // Unit label for X-axis
        'rgba(0, 200, 80, 0.75)'                  // Green bars (matches nominal trajectory color)
      );
    }

    // Draw landing velocity distribution histogram
    if (velHistRef.current) {
      drawHistogram(
        velHistRef.current,
        results.runs.map(r => r.landingVelocity), // Array of landing impact speeds (m/s)
        10,                                         // 10 bins
        'Landing Velocity Distribution',            // Chart title
        'm/s',                                      // Unit label
        'rgba(50, 150, 255, 0.75)'                  // Blue bars (neutral color, not success/fail)
      );
    }

    // Draw outcome pie chart
    if (pieChartRef.current) {
      drawPieChart(pieChartRef.current, results.runs);
    }
  }, [results]); // Re-draw whenever results data changes

  // ── SHORTHAND STATS ─────────────────────────────────────────────────────
  // Extract frequently-used statistics to local variables for cleaner JSX
  const stats = results.statistics;

  // Format altitude nicely: if ≥ 1km show in km, otherwise in meters
  const fmtAlt = useCallback((meters: number) =>
    meters >= 1000
      ? `${(meters / 1000).toFixed(1)} km`  // Show as km with 1 decimal
      : `${meters.toFixed(0)} m`,            // Show as whole meters
  []);

  // ── SORT RUNS FOR THE TOP/BOTTOM TABLE ───────────────────────────────────
  // Sort all runs by max altitude to show best and worst flights
  const sortedByAlt = [...results.runs].sort((a, b) => b.maxAltitude - a.maxAltitude);
  // Top 5 best runs (highest altitude)
  const topRuns     = sortedByAlt.slice(0, 5);
  // Bottom 5 worst runs (lowest altitude — failures tend to be here)
  const bottomRuns  = sortedByAlt.slice(-5).reverse(); // Reverse to show worst-first

  // ── OUTCOME COLOR HELPER ─────────────────────────────────────────────────
  // Color-code outcome labels for visual scanning in the run list
  const outcomeColor = (outcome: SimulationRun['outcome']) => {
    switch (outcome) {
      case 'nominal':            return '#44ff88'; // Bright green: full success
      case 'partial_failure':    return '#ffaa00'; // Orange: degraded but flew
      case 'engine_failure':     return '#ff6622'; // Orange-red: engine problem
      case 'structural_failure': return '#ff3333'; // Red: catastrophic failure
    }
  };

  // ── OUTCOME DISPLAY HELPER ──────────────────────────────────────────────
  // Human-readable outcome labels (replaces underscores with spaces, proper case)
  const outcomeLabel = (outcome: SimulationRun['outcome']) => {
    switch (outcome) {
      case 'nominal':            return 'Nominal';
      case 'partial_failure':    return 'Partial Fail';
      case 'engine_failure':     return 'Engine Fail';
      case 'structural_failure': return 'Structural';
    }
  };

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    // Root overlay: covers entire viewport with a dark, near-opaque background
    <div
      style={{
        position:        'fixed',             // Fixed positioning: covers the full viewport
        inset:           0,                   // top/right/bottom/left = 0: full coverage
        backgroundColor: 'rgba(3, 5, 18, 0.97)', // Very dark, near-opaque space background
        zIndex:          50,                  // On top of everything including landing modal
        display:         'flex',
        flexDirection:   'column',
        fontFamily:      'monospace',
        color:           '#e0e8ff',           // Light blue-white text for space theme
        overflow:        'hidden',            // Prevent outer scroll (inner areas scroll)
      }}
    >

      {/* ── HEADER BAR ────────────────────────────────────────────────────── */}
      <div
        style={{
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'space-between',
          padding:         '8px 16px',
          backgroundColor: 'rgba(5, 10, 30, 0.9)',
          borderBottom:    `1px solid ${COLORS.ui}`,
          flexShrink:      0, // Header doesn't shrink when content below grows
        }}
      >
        {/* Panel title and run count */}
        <div>
          <span style={{ fontSize: 16, fontWeight: 'bold', color: COLORS.trajectory }}>
            Monte Carlo Trajectory Analysis
          </span>
          <span style={{ marginLeft: 12, fontSize: 12, opacity: 0.6 }}>
            {/* Run count summary */}
            {results.runs.length} simulations · {results.runs.filter(r => r.outcome === 'nominal').length} nominal
            {results.runs.length !== results.runs.filter(r => r.outcome === 'nominal').length &&
              ` · ${results.runs.length - results.runs.filter(r => r.outcome === 'nominal').length} failures`
            }
          </span>
        </div>

        {/* Close button: returns to manual flight view */}
        <button
          onClick={onClose} // Notify parent to hide this panel
          style={{
            padding:         '5px 14px',
            backgroundColor: 'rgba(30, 20, 50, 0.9)',
            color:           '#ff8888',
            border:          '1px solid rgba(255, 100, 100, 0.4)',
            borderRadius:    3,
            cursor:          'pointer',
            fontSize:        12,
            fontFamily:      'monospace',
          }}
        >
          ✕ Close
        </button>
      </div>

      {/* ── SUMMARY STATISTICS BAR ─────────────────────────────────────────── */}
      {/* Four key statistics shown prominently at the top for quick assessment */}
      <div
        style={{
          display:         'flex',
          gap:             2,
          padding:         '6px 8px',
          backgroundColor: 'rgba(4, 8, 22, 0.8)',
          borderBottom:    '1px solid rgba(74, 111, 165, 0.3)',
          flexShrink:      0, // Summary bar stays fixed height
        }}
      >
        {/* Summary stat card helper: renders a labeled metric in a small card */}
        {([
          // Stat 1: Mean maximum altitude (the "expected" peak altitude)
          {
            label: 'Mean Max Altitude',
            value: fmtAlt(stats.meanMaxAltitude),
            sub:   `σ = ${fmtAlt(stats.stdDevAltitude)}`, // Standard deviation subtitle
            color: '#44ff88', // Green for positive metric
          },
          // Stat 2: Mission success rate (fraction of nominal outcomes)
          {
            label: 'Success Rate',
            value: `${(stats.successRate * 100).toFixed(1)}%`,
            sub:   `${results.runs.filter(r => r.outcome === 'nominal').length}/${results.runs.length} nominal`,
            color: stats.successRate >= 0.95 ? '#44ff88' : stats.successRate >= 0.85 ? '#ffaa00' : '#ff4444',
            // Color: green ≥ 95%, orange ≥ 85%, red < 85% — matches aerospace success criteria
          },
          // Stat 3: Landing dispersion radius (how scattered landing zones are)
          {
            label: 'Landing Dispersion',
            value: fmtAlt(stats.landingDispersionRadius),
            sub:   '1σ radius from mean landing', // 1-sigma interpretation
            color: '#aaddff', // Light blue for neutral metric
          },
          // Stat 4: 95% confidence interval on max altitude
          {
            label: '95% Alt. Envelope',
            value: `${fmtAlt(stats.altitudeConfidenceInterval95.low)} – ${fmtAlt(stats.altitudeConfidenceInterval95.high)}`,
            sub:   'p5 to p95 max altitude range', // Percentile interpretation
            color: '#00ccff', // Cyan — matches envelope line color in plot
          },
          // Stat 5: Median flight time
          {
            label: 'Median Flight Time',
            value: `${stats.medianFlightTime.toFixed(0)} s`,
            sub:   `${(stats.medianFlightTime / 60).toFixed(1)} minutes`,
            color: '#ddbbff', // Light purple: distinct from other colors
          },
        ] as Array<{ label: string; value: string; sub: string; color: string }>).map((stat) => (
          // Each statistic rendered as a bordered card
          <div
            key={stat.label}
            style={{
              flex:            1,                          // Equal width cards
              padding:         '5px 8px',
              backgroundColor: 'rgba(5, 12, 35, 0.7)',
              border:          `1px solid rgba(74, 111, 165, 0.3)`,
              borderRadius:    3,
              minWidth:        0,                          // Allow flex shrinking
            }}
          >
            {/* Metric label (small, dim) */}
            <div style={{ fontSize: 9, opacity: 0.6, marginBottom: 2 }}>{stat.label}</div>
            {/* Metric value (large, colored) */}
            <div style={{ fontSize: 14, fontWeight: 'bold', color: stat.color, lineHeight: 1 }}>
              {stat.value}
            </div>
            {/* Sub-label (small, dim) */}
            <div style={{ fontSize: 9, opacity: 0.5, marginTop: 2 }}>{stat.sub}</div>
          </div>
        ))}
      </div>

      {/* ── MAIN CONTENT AREA ──────────────────────────────────────────────── */}
      {/* Flex row containing the trajectory plot (left) and stats panel (right) */}
      <div
        style={{
          flex:    1,          // Fills all remaining vertical space
          display: 'flex',
          minHeight: 0,        // Required for flex children to properly size in a flex column
        }}
      >

        {/* ── LEFT: TRAJECTORY ENVELOPE PLOT (60% width) ─────────────────── */}
        <div
          style={{
            flex:         '0 0 60%',              // Fixed at 60% of available width
            position:     'relative',
            borderRight:  `1px solid rgba(74, 111, 165, 0.3)`,
            display:      'flex',
            flexDirection:'column',
          }}
        >
          {/* Plot title */}
          <div
            style={{
              padding:         '4px 12px',
              fontSize:        11,
              opacity:         0.6,
              backgroundColor: 'rgba(4, 8, 22, 0.5)',
              borderBottom:    '1px solid rgba(74, 111, 165, 0.2)',
              flexShrink:      0,
            }}
          >
            Trajectory Overlay (X = horizontal distance, Y = altitude)
            {/* Brief explanation of the color scheme for first-time viewers */}
            &nbsp;·&nbsp;
            <span style={{ color: 'rgba(0, 200, 80, 0.8)' }}>green = nominal</span>
            &nbsp;·&nbsp;
            <span style={{ color: 'rgba(255, 60, 60, 0.8)' }}>red = failure</span>
            &nbsp;·&nbsp;
            <span style={{ color: 'white' }}>white = mean</span>
            &nbsp;·&nbsp;
            <span style={{ color: '#00ccff' }}>cyan = 95% CI</span>
            {playerTrajectory && (
              <>&nbsp;·&nbsp;<span style={{ color: 'rgba(255, 200, 50, 0.9)' }}>gold = your flight</span></>
            )}
          </div>

          {/* The actual trajectory plot canvas component */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <TrajectoryEnvelopePlot
              runs={results.runs}                       // All simulation run data
              envelope={results.trajectoryEnvelope}    // Pre-computed envelope curves
              playerTrajectory={playerTrajectory}       // Player's manual flight (if any)
              selectedRunId={selectedRunId}             // Which run to highlight
              onRunSelect={setSelectedRunId}            // Handle run selection from hover/click
            />
          </div>
        </div>

        {/* ── RIGHT: STATISTICS PANEL (40% width) ────────────────────────── */}
        <div
          style={{
            flex:          '0 0 40%',             // Fixed at 40% of available width
            display:       'flex',
            flexDirection: 'column',
            overflow:      'hidden',              // Clip if charts overflow
            gap:           0,
          }}
        >
          {/* ── ALTITUDE HISTOGRAM ──────────────────────────────────────── */}
          <div style={{ flex: '0 0 28%', padding: 4, borderBottom: '1px solid rgba(74,111,165,0.2)' }}>
            <canvas
              ref={altHistRef}
              style={{ width: '100%', height: '100%', display: 'block' }}
              // Note: actual pixel dimensions are set in the drawHistogram() call below
              // via the useEffect — the CSS size stretches/shrinks the canvas element
              // but the drawing resolution is set by canvas.width/canvas.height attributes.
              // We don't set width/height here because drawHistogram reads them at draw time.
            />
          </div>

          {/* ── LANDING VELOCITY HISTOGRAM ─────────────────────────────── */}
          <div style={{ flex: '0 0 28%', padding: 4, borderBottom: '1px solid rgba(74,111,165,0.2)' }}>
            <canvas
              ref={velHistRef}
              style={{ width: '100%', height: '100%', display: 'block' }}
            />
          </div>

          {/* ── PIE CHART ───────────────────────────────────────────────── */}
          <div style={{ flex: '0 0 22%', padding: 4, borderBottom: '1px solid rgba(74,111,165,0.2)' }}>
            <canvas
              ref={pieChartRef}
              style={{ width: '100%', height: '100%', display: 'block' }}
            />
          </div>

          {/* ── TOP/BOTTOM RUNS TABLE ───────────────────────────────────── */}
          {/* Shows the 5 best and 5 worst runs for quick comparison */}
          <div
            style={{
              flex:       '1 1 0',
              overflow:   'auto',      // Scrollable if content overflows
              padding:    '4px 6px',
              fontSize:   10,
            }}
          >
            {/* Best runs section */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 'bold', color: '#44ff88', marginBottom: 3 }}>
                ▲ Top 5 Runs (by altitude)
              </div>
              {topRuns.map(run => (
                <div
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id === selectedRunId ? null : run.id)}
                  style={{
                    display:         'flex',
                    justifyContent:  'space-between',
                    padding:         '2px 4px',
                    marginBottom:    1,
                    backgroundColor: run.id === selectedRunId
                      ? 'rgba(0, 150, 80, 0.25)' // Highlighted background for selected run
                      : 'rgba(5, 12, 30, 0.4)',  // Normal dim background
                    borderRadius:    2,
                    cursor:          'pointer',   // Indicate clickable row
                    border:          run.id === selectedRunId
                      ? '1px solid rgba(0, 200, 80, 0.5)'
                      : '1px solid transparent',
                  }}
                >
                  {/* Run index (1-based for human readability) */}
                  <span style={{ opacity: 0.6, minWidth: 30 }}>#{run.id + 1}</span>
                  {/* Peak altitude */}
                  <span style={{ color: '#88ffcc' }}>{fmtAlt(run.maxAltitude)}</span>
                  {/* Landing speed */}
                  <span style={{ opacity: 0.7 }}>{run.landingVelocity.toFixed(0)} m/s</span>
                  {/* Outcome label with color coding */}
                  <span style={{ color: outcomeColor(run.outcome), minWidth: 60, textAlign: 'right' }}>
                    {outcomeLabel(run.outcome)}
                  </span>
                </div>
              ))}
            </div>

            {/* Worst runs section */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 'bold', color: '#ff6666', marginBottom: 3 }}>
                ▼ Bottom 5 Runs (by altitude)
              </div>
              {bottomRuns.map(run => (
                <div
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id === selectedRunId ? null : run.id)}
                  style={{
                    display:         'flex',
                    justifyContent:  'space-between',
                    padding:         '2px 4px',
                    marginBottom:    1,
                    backgroundColor: run.id === selectedRunId
                      ? 'rgba(150, 30, 30, 0.25)' // Red highlight for selected failure run
                      : 'rgba(5, 12, 30, 0.4)',
                    borderRadius:    2,
                    cursor:          'pointer',
                    border:          run.id === selectedRunId
                      ? '1px solid rgba(200, 50, 50, 0.5)'
                      : '1px solid transparent',
                  }}
                >
                  <span style={{ opacity: 0.6, minWidth: 30 }}>#{run.id + 1}</span>
                  <span style={{ color: '#ffaaaa' }}>{fmtAlt(run.maxAltitude)}</span>
                  <span style={{ opacity: 0.7 }}>{run.landingVelocity.toFixed(0)} m/s</span>
                  <span style={{ color: outcomeColor(run.outcome), minWidth: 60, textAlign: 'right' }}>
                    {outcomeLabel(run.outcome)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── BOTTOM: FULL RUN DETAILS TABLE ─────────────────────────────────── */}
      {/* Scrollable list of ALL runs with full details — useful for finding specific runs */}
      <div
        style={{
          height:          '28%',           // Bottom 28% of the panel
          borderTop:       `1px solid ${COLORS.ui}`,
          display:         'flex',
          flexDirection:   'column',
          flexShrink:      0,
        }}
      >
        {/* Table header */}
        <div
          style={{
            display:         'grid',
            // Column widths: ID | MaxAlt | LandVel | Score | FlightTime | Outcome | Failure
            gridTemplateColumns: '40px 1fr 80px 60px 80px 100px 1fr',
            padding:         '4px 8px',
            backgroundColor: 'rgba(5, 12, 35, 0.9)',
            borderBottom:    '1px solid rgba(74,111,165,0.3)',
            fontSize:        10,
            fontWeight:      'bold',
            color:           'rgba(180, 200, 255, 0.7)',
            flexShrink:      0,
          }}
        >
          <span>Run</span>
          <span>Max Altitude</span>
          <span>Land. Vel.</span>
          <span>Score</span>
          <span>Flight Time</span>
          <span>Outcome</span>
          <span>Failure Description</span>
        </div>

        {/* Scrollable run rows */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {results.runs.map(run => (
            // Each run rendered as a grid row matching the header columns
            <div
              key={run.id}
              onClick={() => setSelectedRunId(run.id === selectedRunId ? null : run.id)}
              style={{
                display:         'grid',
                gridTemplateColumns: '40px 1fr 80px 60px 80px 100px 1fr',
                padding:         '3px 8px',
                fontSize:        10,
                cursor:          'pointer', // Clickable: selects this run in the trajectory plot
                backgroundColor: run.id === selectedRunId
                  ? 'rgba(50, 100, 200, 0.2)'  // Highlight color when selected
                  : run.outcome !== 'nominal'
                  ? 'rgba(80, 15, 15, 0.25)'   // Subtle red tint for failed runs
                  : 'transparent',              // Normal background for nominal runs
                borderBottom:    '1px solid rgba(50, 70, 120, 0.2)',
                color:           run.id === selectedRunId ? '#ffffff' : 'rgba(200, 215, 255, 0.8)',
              }}
            >
              {/* Run ID (1-based) */}
              <span style={{ opacity: 0.6 }}>#{run.id + 1}</span>

              {/* Max altitude — formatted with units */}
              <span style={{ color: '#88ffcc' }}>{fmtAlt(run.maxAltitude)}</span>

              {/* Landing velocity */}
              <span>{run.landingVelocity.toFixed(1)} m/s</span>

              {/* Landing quality score (0-100) with color coding */}
              <span style={{
                color: run.landingScore >= 80 ? '#44ff44'
                      : run.landingScore >= 50 ? '#ffaa00'
                      : '#ff4444',
                fontWeight: 'bold',
              }}>
                {run.landingScore}/100
              </span>

              {/* Total flight time */}
              <span style={{ opacity: 0.7 }}>{run.flightTime.toFixed(1)} s</span>

              {/* Outcome label with color */}
              <span style={{ color: outcomeColor(run.outcome), fontWeight: 'bold' }}>
                {outcomeLabel(run.outcome)}
              </span>

              {/* Failure description (empty for nominal runs) */}
              <span style={{ opacity: 0.6, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {run.failureDescription ?? '—'} {/* Em dash when no failure */}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
