/**
 * VehicleHealthPanel — Right sidebar panel displaying vehicle health telemetry.
 *
 * Sections:
 *  1. Per-stage fuel gauges with separation badges
 *  2. Throttle 180° arc SVG gauge
 *  3. Structural integrity horizontal bar
 *  4. Mass and TWR summary row
 *
 * Subscribes to `selectVehicle` from the telemetry store.
 */

import React from 'react';
import { useTelemetryStore, selectVehicle } from '../../store/telemetryStore';
import type { StageStatus } from '../../store/telemetryStore';

// ── Helpers ────────────────────────────────────────────────────

/** Return the fuel-bar fill color class based on fuel percentage. */
const fuelColorClass = (pct: number): string => {
  if (pct > 50) return 'fuel-bar__fill--green';
  if (pct >= 20) return 'fuel-bar__fill--yellow';
  return 'fuel-bar__fill--red';
};

/** Return the integrity bar color class based on structural integrity. */
const integrityColorClass = (pct: number): string => {
  if (pct > 60) return 'fuel-bar__fill--green';
  if (pct >= 30) return 'fuel-bar__fill--yellow';
  return 'fuel-bar__fill--red';
};

/** Format mass: show tonnes if ≥1000 kg, otherwise kg. */
const formatMass = (kg: number): string => {
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  return `${kg.toFixed(0)} kg`;
};

// ── Throttle Arc Gauge (SVG) ───────────────────────────────────

/** Describe a 180° arc path from startAngle to endAngle (degrees). */
const describeArc = (
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const x1 = cx + r * Math.cos(toRad(startDeg));
  const y1 = cy - r * Math.sin(toRad(startDeg));
  const x2 = cx + r * Math.cos(toRad(endDeg));
  const y2 = cy - r * Math.sin(toRad(endDeg));
  const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  // Sweep flag 0 because we go from left (180°) toward right (0°) with y-up math
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 0 ${x2} ${y2}`;
};

const THROTTLE_CX = 60;
const THROTTLE_CY = 60;
const THROTTLE_R = 46;

const ThrottleGauge: React.FC<{ percent: number }> = ({ percent }) => {
  const clamped = Math.max(0, Math.min(100, percent));
  // Full background arc: 180° → 0°
  const bgPath = describeArc(THROTTLE_CX, THROTTLE_CY, THROTTLE_R, 180, 0);
  // Filled arc: 180° → (180 - 180 * pct/100)°
  const endAngle = 180 - (180 * clamped) / 100;
  const fillPath =
    clamped > 0
      ? describeArc(THROTTLE_CX, THROTTLE_CY, THROTTLE_R, 180, endAngle)
      : '';

  return (
    <svg
      width={120}
      height={70}
      viewBox="0 0 120 70"
      style={{ display: 'block', margin: '0 auto' }}
    >
      <defs>
        <linearGradient id="throttle-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent-cyan)" />
          <stop offset="100%" stopColor="var(--accent-green)" />
        </linearGradient>
      </defs>
      {/* Background arc */}
      <path
        d={bgPath}
        fill="none"
        stroke="rgba(255, 255, 255, 0.1)"
        strokeWidth={7}
        strokeLinecap="round"
      />
      {/* Filled arc */}
      {clamped > 0 && (
        <path
          d={fillPath}
          fill="none"
          stroke="url(#throttle-grad)"
          strokeWidth={7}
          strokeLinecap="round"
        />
      )}
      {/* Percentage text */}
      <text
        x={THROTTLE_CX}
        y={THROTTLE_CY + 2}
        textAnchor="middle"
        fill="var(--text-value)"
        fontFamily="var(--font-mono)"
        fontSize="14"
        fontWeight="700"
      >
        {clamped.toFixed(0)}%
      </text>
    </svg>
  );
};

// ── Stage Fuel Row ─────────────────────────────────────────────

const StageFuelRow: React.FC<{ stage: StageStatus }> = ({ stage }) => {
  const separated = stage.isSeparated;
  const pct = Math.max(0, Math.min(100, stage.fuelPercent));

  return (
    <div
      style={{
        opacity: separated ? 0.35 : 1,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 0',
      }}
    >
      {/* Stage label */}
      <span
        className="telem-label"
        style={{ minWidth: '22px', textAlign: 'center' }}
      >
        S{stage.stageNumber}
      </span>

      {/* Fuel bar */}
      <div className="fuel-bar" style={{ flex: 1 }}>
        <div
          className={`fuel-bar__fill ${fuelColorClass(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Percentage value */}
      <span
        className="telem-value"
        style={{ minWidth: '36px', fontSize: 'var(--fs-sm)', textAlign: 'right' }}
      >
        {pct.toFixed(0)}%
      </span>

      {/* SEP badge when separated */}
      {separated && (
        <span
          className="panel__badge"
          style={{
            background: 'rgba(255, 255, 255, 0.08)',
            color: 'var(--text-tertiary)',
            fontSize: '7px',
          }}
        >
          SEP
        </span>
      )}
    </div>
  );
};

// ── Main Panel Component ───────────────────────────────────────

export const VehicleHealthPanel: React.FC = () => {
  const vehicle = useTelemetryStore(selectVehicle);
  const integrityPct = Math.max(0, Math.min(100, vehicle.structuralIntegrity));
  const isPulsing = integrityPct < 50;

  return (
    <div className="panel">
      {/* Header */}
      <div className="panel__header">
        <span className="panel__title">Vehicle Health</span>
      </div>

      {/* ── Per-Stage Fuel Gauges ─────────────────────── */}
      <div style={{ marginBottom: 'var(--space-md)' }}>
        {vehicle.stages.length > 0 ? (
          vehicle.stages.map((stage) => (
            <StageFuelRow key={stage.stageNumber} stage={stage} />
          ))
        ) : (
          <div className="telem-row">
            <span className="telem-label">Fuel</span>
            <span className="telem-value" style={{ color: 'var(--text-tertiary)' }}>
              —
            </span>
          </div>
        )}
      </div>

      {/* ── Throttle Arc Gauge ────────────────────────── */}
      <div style={{ marginBottom: 'var(--space-md)' }}>
        <div className="telem-row" style={{ marginBottom: '2px' }}>
          <span className="telem-label">Throttle</span>
        </div>
        <ThrottleGauge percent={vehicle.throttlePercent} />
      </div>

      {/* ── Structural Integrity ──────────────────────── */}
      <div style={{ marginBottom: 'var(--space-md)' }}>
        <div className="telem-row">
          <span className="telem-label">Struct</span>
          <span
            className={`telem-value${isPulsing ? ' telem-value--pulsing' : ''}`}
            style={{
              color:
                integrityPct > 60
                  ? 'var(--accent-green)'
                  : integrityPct >= 30
                    ? 'var(--accent-yellow)'
                    : 'var(--accent-red)',
            }}
          >
            {integrityPct.toFixed(0)}%
          </span>
        </div>
        <div className="fuel-bar" style={{ marginTop: '3px' }}>
          <div
            className={`fuel-bar__fill ${integrityColorClass(integrityPct)}`}
            style={{ width: `${integrityPct}%` }}
          />
        </div>
      </div>

      {/* ── Mass / TWR Row ────────────────────────────── */}
      <div className="telem-row">
        <span className="telem-label">Mass</span>
        <span className="telem-value">{formatMass(vehicle.totalMass)}</span>
      </div>
      <div className="telem-row">
        <span className="telem-label">TWR</span>
        <span
          className={`telem-value ${
            vehicle.twr >= 1.0 ? 'telem-value--green' : 'telem-value--orange'
          }`}
        >
          {vehicle.twr.toFixed(2)}
        </span>
      </div>
    </div>
  );
};
