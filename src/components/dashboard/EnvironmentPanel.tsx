/**
 * EnvironmentPanel — Left-sidebar panel displaying atmospheric environment data.
 *
 * Shows:
 *   • Mach Number — large value with a colour-coded regime badge
 *     (Subsonic, Transonic, Supersonic, Hypersonic).
 *   • Dynamic Pressure (Q) — value in kPa with a horizontal bar
 *     that changes colour as Q approaches the 33 kPa structural limit.
 *   • Max Q — peak dynamic pressure recorded, annotated with the
 *     altitude at which it occurred.
 *   • Stagnation Temperature — value in Kelvin with colour coding
 *     that shifts from white → yellow → orange → red as temp increases.
 *
 * Subscribes to the `environment` slice of the telemetry store.
 */

import React from 'react';
import {
  useTelemetryStore,
  selectEnvironment,
} from '../../store/telemetryStore';

// ── Mach regime thresholds & display config ────────────────────

interface MachRegime {
  label: string;
  bg: string;
  color: string;
}

/**
 * Determine the Mach flight regime from the current Mach number.
 */
const getMachRegime = (mach: number): MachRegime => {
  if (mach < 0.8)  return { label: 'SUBSONIC',    bg: 'rgba(100,120,160,0.3)', color: '#8899bb' };
  if (mach <= 1.2) return { label: 'TRANSONIC',   bg: 'rgba(255,208,0,0.2)',   color: 'var(--accent-yellow)' };
  if (mach <= 5.0) return { label: 'SUPERSONIC',  bg: 'rgba(255,140,0,0.2)',   color: 'var(--accent-orange)' };
  return                   { label: 'HYPERSONIC',  bg: 'rgba(255,48,64,0.2)',   color: 'var(--accent-red)' };
};

// ── Q-bar limits ───────────────────────────────────────────────

/** Structural dynamic-pressure limit in Pascals (33 kPa). */
const Q_LIMIT_PA = 33_000;

/**
 * Return a CSS colour for the Q-bar fill based on the percentage of
 * the structural limit: green (nominal), orange (caution), red (danger).
 */
const getQBarColor = (percent: number): string => {
  if (percent > 90) return 'var(--accent-red)';
  if (percent > 70) return 'var(--accent-orange)';
  return 'var(--accent-green)';
};

// ── Stagnation temp colour mapping ─────────────────────────────

/**
 * Map stagnation temperature to a text colour:
 *   < 500 K  → white (nominal)
 *   500–1500 → yellow (warm)
 *   1500–2500 → orange (hot)
 *   > 2500   → red (critical)
 */
const getStagTempClass = (temp: number): string => {
  if (temp >= 2500) return 'telem-value--red';
  if (temp >= 1500) return 'telem-value--orange';
  if (temp >= 500)  return 'telem-value--yellow';
  return '';
};

// ── Component ──────────────────────────────────────────────────

export const EnvironmentPanel: React.FC = () => {
  const env = useTelemetryStore(selectEnvironment);

  const regime = getMachRegime(env.machNumber);
  const qKpa = env.dynamicPressureQ / 1000;
  const qPercent = Math.min((env.dynamicPressureQ / Q_LIMIT_PA) * 100, 100);
  const maxQKpa = env.maxQ / 1000;
  const maxQAltKm = env.maxQAltitude / 1000;
  const stagTempClass = getStagTempClass(env.stagnationTemp);

  return (
    <div className="panel">
      {/* ── Panel header ──────────────────────────────────────── */}
      <div className="panel__header">
        <span className="panel__title">Environment</span>
      </div>

      {/* ── Mach Number ───────────────────────────────────────── */}
      <div className="telem-row">
        <span className="telem-label">Mach</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="telem-value telem-value--lg">{env.machNumber.toFixed(2)}</span>
          <span
            className="panel__badge"
            style={{ background: regime.bg, color: regime.color }}
          >
            {regime.label}
          </span>
        </span>
      </div>

      {/* ── Dynamic Pressure Q ────────────────────────────────── */}
      <div style={{ marginTop: 4 }}>
        <div className="telem-row">
          <span className="telem-label">Q (dyn. press.)</span>
          <span>
            <span className="telem-value">{qKpa.toFixed(1)}</span>
            <span className="telem-unit">kPa</span>
          </span>
        </div>
        {/* Q-bar */}
        <div className="q-bar">
          <div
            className="q-bar__fill"
            style={{
              width: `${qPercent}%`,
              background: getQBarColor(qPercent),
            }}
          />
        </div>
      </div>

      {/* ── Max Q ─────────────────────────────────────────────── */}
      <div className="telem-row" style={{ marginTop: 2 }}>
        <span className="telem-label">Max Q</span>
        <span>
          <span className="telem-value">{maxQKpa.toFixed(1)}</span>
          <span className="telem-unit">kPa</span>
          {env.maxQ > 0 && (
            <span className="telem-unit"> @ {maxQAltKm.toFixed(1)} km</span>
          )}
        </span>
      </div>

      {/* ── Stagnation Temperature ────────────────────────────── */}
      <div className="telem-row">
        <span className="telem-label">Stag. Temp</span>
        <span>
          <span className={`telem-value ${stagTempClass}`}>
            {env.stagnationTemp.toFixed(0)}
          </span>
          <span className="telem-unit">K</span>
        </span>
      </div>
    </div>
  );
};
