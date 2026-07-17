/**
 * AttitudeIndicator — SVG Artificial Horizon Instrument
 * =====================================================
 * Displays rocket attitude as a traditional artificial horizon gauge.
 * The horizon line tilts opposite to the rocket's angle (pilot's
 * perspective: when the rocket tilts right, the horizon tilts left).
 *
 * - 140×140px circular SVG, clipped to a circle
 * - Sky gradient (dark→lighter blue) upper half
 * - Ground color (dark brown) lower half
 * - Fixed center crosshair
 * - Degree tick marks on the rim at 15° intervals
 * - Bank indicator triangle at top
 * - Current angle readout below the gauge
 *
 * Subscribes to `selectDynamics` for the `angle` field (radians from vertical).
 */

import React from 'react';
import { useTelemetryStore, selectDynamics } from '../../store/telemetryStore';

/** Convert radians to degrees. */
const RAD_TO_DEG = 180 / Math.PI;

/** Gauge diameter in pixels. */
const SIZE = 140;
const CX = SIZE / 2;
const CY = SIZE / 2;
const RADIUS = SIZE / 2 - 2; // 2px inset for stroke

/** Tick marks at these degree values on each side. */
const TICK_DEGREES = [0, 15, 30, 45, 60];

export const AttitudeIndicator: React.FC = () => {
  const dynamics = useTelemetryStore(selectDynamics);

  // Angle from store is radians from vertical. Convert to degrees.
  const angleDeg = dynamics.angle * RAD_TO_DEG;

  // Horizon rolls opposite: negate the angle for pilot perspective.
  const horizonRotation = -angleDeg;

  return (
    <div className="panel">
      {/* Panel header */}
      <div className="panel__header">
        <span className="panel__title">Attitude</span>
      </div>

      {/* Gauge SVG */}
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{ display: 'block', margin: '0 auto' }}
      >
        <defs>
          {/* Circular clip path */}
          <clipPath id="attitude-clip">
            <circle cx={CX} cy={CY} r={RADIUS} />
          </clipPath>

          {/* Sky gradient — top half */}
          <linearGradient id="sky-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1a3a6a" />
            <stop offset="100%" stopColor="#2a5a9a" />
          </linearGradient>

          {/* Ground gradient — bottom half */}
          <linearGradient id="ground-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4a3020" />
            <stop offset="100%" stopColor="#2a1a10" />
          </linearGradient>
        </defs>

        {/* Outer rim circle */}
        <circle
          cx={CX}
          cy={CY}
          r={RADIUS}
          fill="none"
          stroke="rgba(255,255,255,0.16)"
          strokeWidth="1.5"
        />

        {/* Clipped rotating group — sky & ground */}
        <g clipPath="url(#attitude-clip)">
          <g
            style={{
              transform: `rotate(${horizonRotation}deg)`,
              transformOrigin: `${CX}px ${CY}px`,
            }}
          >
            {/* Sky — upper half (extends well beyond bounds for rotation) */}
            <rect
              x={-SIZE}
              y={-SIZE}
              width={SIZE * 3}
              height={SIZE * 2 + CY}
              fill="url(#sky-gradient)"
            />

            {/* Ground — lower half */}
            <rect
              x={-SIZE}
              y={CY}
              width={SIZE * 3}
              height={SIZE * 2}
              fill="url(#ground-gradient)"
            />

            {/* Horizon line */}
            <line
              x1={-SIZE}
              y1={CY}
              x2={SIZE * 3}
              y2={CY}
              stroke="#ffffff"
              strokeWidth="1.5"
              strokeOpacity="0.7"
            />

            {/* Pitch reference lines (subtle, above and below center) */}
            {[-20, -10, 10, 20].map((offset) => (
              <line
                key={offset}
                x1={CX - 18}
                y1={CY + offset}
                x2={CX + 18}
                y2={CY + offset}
                stroke="#ffffff"
                strokeWidth="0.8"
                strokeOpacity="0.3"
              />
            ))}
          </g>
        </g>

        {/* Fixed center crosshair */}
        <g stroke="#ffffff" strokeWidth="2" strokeLinecap="round">
          {/* Horizontal arms */}
          <line x1={CX - 22} y1={CY} x2={CX - 8} y2={CY} />
          <line x1={CX + 8} y1={CY} x2={CX + 22} y2={CY} />
          {/* Vertical arms */}
          <line x1={CX} y1={CY - 22} x2={CX} y2={CY - 8} />
          <line x1={CX} y1={CY + 8} x2={CX} y2={CY + 22} />
          {/* Center dot */}
          <circle cx={CX} cy={CY} r="2" fill="#ffffff" stroke="none" />
        </g>

        {/* Degree tick marks on the rim */}
        {TICK_DEGREES.map((deg) =>
          [deg, -deg].map((d) => {
            if (deg === 0 && d < 0) return null; // avoid duplicate 0°
            const angleRad = (d * Math.PI) / 180 - Math.PI / 2; // -90° offset so 0 is top
            const outerR = RADIUS;
            const innerR = RADIUS - (deg === 0 ? 10 : deg % 30 === 0 ? 8 : 5);
            const x1 = CX + Math.cos(angleRad) * innerR;
            const y1 = CY + Math.sin(angleRad) * innerR;
            const x2 = CX + Math.cos(angleRad) * outerR;
            const y2 = CY + Math.sin(angleRad) * outerR;
            return (
              <line
                key={`tick-${d}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="rgba(255,255,255,0.5)"
                strokeWidth="1"
              />
            );
          })
        )}

        {/* Bank indicator triangle at top center */}
        <polygon
          points={`${CX},${CY - RADIUS + 3} ${CX - 5},${CY - RADIUS - 5} ${CX + 5},${CY - RADIUS - 5}`}
          fill="#ffffff"
          fillOpacity="0.85"
        />
      </svg>

      {/* Angle readout below gauge */}
      <div className="telem-row" style={{ justifyContent: 'center', marginTop: '4px' }}>
        <span className="telem-value telem-value--cyan">
          {angleDeg.toFixed(1)}°
        </span>
      </div>
    </div>
  );
};
