/**
 * GMeter — SVG arc gauge displaying current G-force.
 *
 * Layout:
 *  - 180° sweep arc from 0G (left) to 10G (right)
 *  - Color-segmented arc: green 0-3G, yellow 3-5G, orange 5-7G, red 7-10G
 *  - Red dashed radial line at 7G (MAX_ACCELERATION_G structural limit)
 *  - Animated needle pointing to current G value
 *  - Large numeric readout centered below the arc
 *  - Scale markings at 0, 2, 4, 6, 8, 10
 *
 * Subscribes to `selectEnvironment` from the telemetry store.
 */

import React from 'react';
import { useTelemetryStore, selectEnvironment } from '../../store/telemetryStore';

// ── Constants ──────────────────────────────────────────────────

const MAX_G = 10;
const STRUCTURAL_LIMIT_G = 7;

const SVG_W = 240;
const SVG_H = 130;
const CX = SVG_W / 2;           // 120
const CY = 105;                  // Arc center Y — low so the arc sits in the view
const R_OUTER = 88;              // Main arc radius
const R_TICK = R_OUTER + 6;      // Tick marks outer
const R_LABEL = R_OUTER + 18;   // Label position
const R_NEEDLE = R_OUTER - 4;   // Needle tip
const ARC_STROKE = 10;

// ── Geometry helpers ───────────────────────────────────────────

/** Convert a G value (0-10) to an angle in degrees.
 *  0G = 180° (left), 10G = 0° (right). */
const gToAngle = (g: number): number => 180 - (g / MAX_G) * 180;

/** Polar → Cartesian (y-axis up). */
const polarToXY = (angleDeg: number, r: number): [number, number] => {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY - r * Math.sin(rad)];
};

/** SVG arc path between two angles (degrees, math convention). */
const arcPath = (startDeg: number, endDeg: number, r: number): string => {
  const [x1, y1] = polarToXY(startDeg, r);
  const [x2, y2] = polarToXY(endDeg, r);
  const largeArc = Math.abs(startDeg - endDeg) > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 0 ${x2} ${y2}`;
};

// ── Arc Segments ───────────────────────────────────────────────

interface ArcSegment {
  gStart: number;
  gEnd: number;
  color: string;
}

const SEGMENTS: ArcSegment[] = [
  { gStart: 0, gEnd: 3, color: 'var(--accent-green)' },
  { gStart: 3, gEnd: 5, color: 'var(--accent-yellow)' },
  { gStart: 5, gEnd: 7, color: 'var(--accent-orange)' },
  { gStart: 7, gEnd: 10, color: 'var(--accent-red)' },
];

// ── Scale markings ─────────────────────────────────────────────

const SCALE_VALUES = [0, 2, 4, 6, 8, 10];

// ── Component ──────────────────────────────────────────────────

export const GMeter: React.FC = () => {
  const environment = useTelemetryStore(selectEnvironment);
  const currentG = Math.max(0, Math.min(MAX_G, environment.currentGForce));

  // Needle rotation: 0G = pointing left (180°), 10G = pointing right (0°).
  // CSS rotation is clockwise from top, so we convert:
  //   CSS angle = 270° - mathAngle   (for y-up → CSS-clockwise mapping)
  // But it's cleaner to use transform-origin and compute directly:
  const needleAngleDeg = gToAngle(currentG);
  // SVG-space rotation for the needle line from CX,CY outward
  const [needleTipX, needleTipY] = polarToXY(needleAngleDeg, R_NEEDLE);
  const [needleBaseX1, needleBaseY1] = polarToXY(needleAngleDeg + 90, 3);
  const [needleBaseX2, needleBaseY2] = polarToXY(needleAngleDeg - 90, 3);

  // Structural limit radial line at 7G
  const limitAngle = gToAngle(STRUCTURAL_LIMIT_G);
  const [limInnerX, limInnerY] = polarToXY(limitAngle, R_OUTER - ARC_STROKE / 2 - 2);
  const [limOuterX, limOuterY] = polarToXY(limitAngle, R_OUTER + ARC_STROKE / 2 + 4);

  // Color for the readout text
  const readoutColor =
    currentG < 3
      ? 'var(--accent-green)'
      : currentG < 5
        ? 'var(--accent-yellow)'
        : currentG < 7
          ? 'var(--accent-orange)'
          : 'var(--accent-red)';

  return (
    <div className="panel">
      {/* Header */}
      <div className="panel__header">
        <span className="panel__title">G-Force</span>
      </div>

      <svg
        width={SVG_W}
        height={SVG_H}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        style={{ display: 'block', margin: '0 auto' }}
      >
        {/* ── Color-coded arc segments ────────────────── */}
        {SEGMENTS.map((seg) => (
          <path
            key={seg.gStart}
            d={arcPath(gToAngle(seg.gStart), gToAngle(seg.gEnd), R_OUTER)}
            fill="none"
            stroke={seg.color}
            strokeWidth={ARC_STROKE}
            strokeLinecap="butt"
            opacity={0.55}
          />
        ))}

        {/* ── Scale ticks and labels ──────────────────── */}
        {SCALE_VALUES.map((g) => {
          const angle = gToAngle(g);
          const [tx1, ty1] = polarToXY(angle, R_OUTER + ARC_STROKE / 2);
          const [tx2, ty2] = polarToXY(angle, R_TICK);
          const [lx, ly] = polarToXY(angle, R_LABEL);
          return (
            <g key={g}>
              <line
                x1={tx1}
                y1={ty1}
                x2={tx2}
                y2={ty2}
                stroke="var(--text-tertiary)"
                strokeWidth={1.2}
              />
              <text
                x={lx}
                y={ly}
                textAnchor="middle"
                dominantBaseline="central"
                fill="var(--text-secondary)"
                fontFamily="var(--font-mono)"
                fontSize="9"
                fontWeight="600"
              >
                {g}
              </text>
            </g>
          );
        })}

        {/* ── 7G structural limit line (dashed, red) ── */}
        <line
          x1={limInnerX}
          y1={limInnerY}
          x2={limOuterX}
          y2={limOuterY}
          stroke="var(--accent-red)"
          strokeWidth={1.5}
          strokeDasharray="3 2"
          opacity={0.9}
        />

        {/* ── Needle (triangle pointer) ──────────────── */}
        <polygon
          points={`${needleTipX},${needleTipY} ${needleBaseX1},${needleBaseY1} ${needleBaseX2},${needleBaseY2}`}
          fill="var(--text-value)"
          style={{ transition: 'all 0.15s ease-out' }}
        />
        {/* Needle center dot */}
        <circle cx={CX} cy={CY} r={4} fill="var(--text-value)" />
        <circle cx={CX} cy={CY} r={2} fill="var(--bg-primary)" />

        {/* ── Large center readout ────────────────────── */}
        <text
          x={CX}
          y={CY - 18}
          textAnchor="middle"
          fill={readoutColor}
          fontFamily="var(--font-mono)"
          fontSize="22"
          fontWeight="700"
        >
          {currentG.toFixed(1)}G
        </text>
      </svg>
    </div>
  );
};
