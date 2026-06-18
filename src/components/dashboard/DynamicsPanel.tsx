/**
 * DynamicsPanel — Left-sidebar panel displaying real-time flight dynamics.
 *
 * Shows:
 *   • Altitude — large auto-formatted value (m / km) with a vertical
 *     SVG altitude bar showing atmospheric zones (Ground → LEO) and a
 *     moving marker at the current altitude.
 *   • Velocity — speed magnitude with ▲/▼ direction indicator.
 *   • Downrange — horizontal distance from the launch pad.
 *   • Tilt — angle from vertical with a small circular indicator.
 *
 * Subscribes to the `dynamics` slice of the telemetry store.
 */

import React from 'react';
import {
  useTelemetryStore,
  selectDynamics,
} from '../../store/telemetryStore';

// ── Helpers ────────────────────────────────────────────────────

/**
 * Auto-format a distance value: show metres below 1 000 m,
 * otherwise kilometres with 2 decimal places.
 */
const formatDistance = (meters: number): { value: string; unit: string } => {
  const abs = Math.abs(meters);
  if (abs < 1000) {
    return { value: abs.toFixed(0), unit: 'm' };
  }
  return { value: (abs / 1000).toFixed(2), unit: 'km' };
};

/**
 * Auto-format velocity: m/s below 1 000, km/s above.
 */
const formatSpeed = (mps: number): { value: string; unit: string } => {
  const abs = Math.abs(mps);
  if (abs < 1000) {
    return { value: abs.toFixed(1), unit: 'm/s' };
  }
  return { value: (abs / 1000).toFixed(2), unit: 'km/s' };
};

/** Convert radians to degrees. */
const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

// ── Altitude bar constants ─────────────────────────────────────

/** Total visible height of the SVG altitude bar in pixels. */
const BAR_HEIGHT = 140;
/** Width of the SVG altitude bar in pixels. */
const BAR_WIDTH = 18;

/**
 * Atmospheric zone boundaries (in metres) and their display labels.
 * Used to draw zone tick-marks on the altitude bar.
 */
const ALTITUDE_ZONES = [
  { alt: 0,       label: 'GND',    color: '#22aa44' },
  { alt: 12_000,  label: 'TROPO',  color: '#3388cc' },
  { alt: 50_000,  label: 'STRAT',  color: '#5566bb' },
  { alt: 85_000,  label: 'MESO',   color: '#7744aa' },
  { alt: 100_000, label: 'KÁRMÁN', color: '#9933cc' },
  { alt: 400_000, label: 'LEO',    color: '#111122' },
] as const;

/** Maximum altitude represented by the bar (LEO at 400 km). */
const BAR_MAX_ALT = 400_000;

/**
 * Map an altitude value to a Y pixel position on the bar.
 * Uses a logarithmic-ish mapping so lower altitudes get more
 * visual space and LEO doesn't squash everything to the bottom.
 */
const altToY = (alt: number): number => {
  const clamped = Math.max(0, Math.min(alt, BAR_MAX_ALT));
  // Use sqrt mapping for a balanced visual distribution
  const ratio = Math.sqrt(clamped / BAR_MAX_ALT);
  // Y goes top-down: ratio 0 → bottom, ratio 1 → top
  return BAR_HEIGHT - ratio * BAR_HEIGHT;
};

// ── Component ──────────────────────────────────────────────────

export const DynamicsPanel: React.FC = () => {
  const d = useTelemetryStore(selectDynamics);

  const alt = formatDistance(d.altitude);
  const vel = formatSpeed(d.speed);
  const dr = formatDistance(Math.abs(d.positionX));
  const tiltDeg = radToDeg(d.angle);

  // Direction arrow based on vertical velocity
  const dirArrow = d.velocityY >= 0 ? '▲' : '▼';
  const dirColor = d.velocityY >= 0 ? 'telem-value--green' : 'telem-value--orange';

  // Tilt indicator: offset a small dot on a 14 px-radius circle
  const tiltRadius = 14;
  const tiltX = Math.sin(d.angle) * tiltRadius;
  const tiltY = -Math.cos(d.angle) * tiltRadius;

  return (
    <div className="panel">
      {/* ── Panel header ──────────────────────────────────────── */}
      <div className="panel__header">
        <span className="panel__title">Dynamics</span>
      </div>

      {/* ── Altitude row + SVG bar ────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 6 }}>
        {/* Altitude bar (SVG) */}
        <svg
          width={BAR_WIDTH + 44}
          height={BAR_HEIGHT}
          style={{ flexShrink: 0 }}
          aria-label="Altitude zone bar"
        >
          <defs>
            <linearGradient id="altGrad" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%"   stopColor="#22aa44" />
              <stop offset="20%"  stopColor="#3388cc" />
              <stop offset="50%"  stopColor="#5566bb" />
              <stop offset="75%"  stopColor="#7744aa" />
              <stop offset="90%"  stopColor="#9933cc" />
              <stop offset="100%" stopColor="#111122" />
            </linearGradient>
          </defs>

          {/* Bar background */}
          <rect
            x={0}
            y={0}
            width={BAR_WIDTH}
            height={BAR_HEIGHT}
            rx={3}
            fill="url(#altGrad)"
            opacity={0.55}
          />

          {/* Zone tick marks and labels */}
          {ALTITUDE_ZONES.map((zone) => {
            const y = altToY(zone.alt);
            return (
              <g key={zone.label}>
                <line
                  x1={0}
                  y1={y}
                  x2={BAR_WIDTH}
                  y2={y}
                  stroke="rgba(255,255,255,0.25)"
                  strokeWidth={0.5}
                />
                <text
                  x={BAR_WIDTH + 3}
                  y={y + 3}
                  fill="#556688"
                  fontSize={7}
                  fontFamily="var(--font-mono)"
                >
                  {zone.label}
                </text>
              </g>
            );
          })}

          {/* Current altitude marker */}
          <polygon
            points={`${BAR_WIDTH + 1},${altToY(d.altitude) - 4} ${BAR_WIDTH + 1},${altToY(d.altitude) + 4} ${BAR_WIDTH - 5},${altToY(d.altitude)}`}
            fill="var(--accent-cyan)"
          />
          <line
            x1={0}
            y1={altToY(d.altitude)}
            x2={BAR_WIDTH}
            y2={altToY(d.altitude)}
            stroke="var(--accent-cyan)"
            strokeWidth={1.5}
            opacity={0.9}
          />
        </svg>

        {/* Altitude value */}
        <div style={{ flex: 1 }}>
          <div className="telem-label">Altitude</div>
          <div>
            <span className="telem-value telem-value--lg telem-value--cyan">{alt.value}</span>
            <span className="telem-unit">{alt.unit}</span>
          </div>
          <div style={{ marginTop: 2 }}>
            <span className="telem-label" style={{ fontSize: 9 }}>Peak </span>
            <span className="telem-value" style={{ fontSize: 11 }}>
              {d.maxAltitude < 1000
                ? `${d.maxAltitude.toFixed(0)} m`
                : `${(d.maxAltitude / 1000).toFixed(2)} km`}
            </span>
          </div>
        </div>
      </div>

      {/* ── Velocity ──────────────────────────────────────────── */}
      <div className="telem-row">
        <span className="telem-label">Velocity</span>
        <span>
          <span className={`telem-value ${dirColor}`} style={{ fontSize: 11, marginRight: 3 }}>
            {dirArrow}
          </span>
          <span className="telem-value">{vel.value}</span>
          <span className="telem-unit">{vel.unit}</span>
        </span>
      </div>

      {/* ── Downrange ─────────────────────────────────────────── */}
      <div className="telem-row">
        <span className="telem-label">Downrange</span>
        <span>
          <span className="telem-value">{dr.value}</span>
          <span className="telem-unit">{dr.unit}</span>
        </span>
      </div>

      {/* ── Tilt ──────────────────────────────────────────────── */}
      <div className="telem-row">
        <span className="telem-label">Tilt</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {/* Circular tilt indicator */}
          <svg width={32} height={32} viewBox="-16 -16 32 32" aria-label="Tilt indicator">
            <circle cx={0} cy={0} r={14} fill="none" stroke="rgba(50,90,160,0.3)" strokeWidth={1} />
            {/* Center cross */}
            <line x1={0} y1={-3} x2={0} y2={3} stroke="rgba(136,153,187,0.4)" strokeWidth={0.5} />
            <line x1={-3} y1={0} x2={3} y2={0} stroke="rgba(136,153,187,0.4)" strokeWidth={0.5} />
            {/* Tilt dot */}
            <circle
              cx={tiltX}
              cy={tiltY}
              r={3}
              fill={Math.abs(tiltDeg) > 30 ? 'var(--accent-orange)' : 'var(--accent-cyan)'}
            />
          </svg>
          <span className="telem-value">{tiltDeg.toFixed(1)}</span>
          <span className="telem-unit">°</span>
        </span>
      </div>
    </div>
  );
};
