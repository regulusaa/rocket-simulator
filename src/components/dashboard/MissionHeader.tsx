/**
 * MissionHeader — Top header bar for the rocket simulator dashboard.
 *
 * Displays the Mission Elapsed Time (MET) clock, rocket name, current
 * flight phase badge, structural-integrity status dot, and the full
 * controls cluster (rocket selector, goal selector, difficulty,
 * time-warp buttons, audio controls, and keyboard-help shortcut).
 *
 * All interactive state is owned by the parent — this component is
 * fully controlled via props and never manages internal state.
 */

import React from 'react';
import {
  useTelemetryStore,
  selectMission,
  selectVehicle,
  type FlightPhase,
} from '../../store/telemetryStore';

// ── Props ──────────────────────────────────────────────────────

interface MissionHeaderProps {
  rocketName: string;
  onReset: () => void;
  onToggleAutoFly: () => void;
  onSetTimeMultiplier: (m: number) => void;
  onTogglePause: () => void;
  onToggleMute: () => void;
  onVolumeChange: (v: number) => void;
  audioMuted: boolean;
  masterVolume: number;
  onGoalChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onCustomGoalChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  selectedGoalName: string;
  customGoalAltitude: number | null;
  altitudeGoals: Array<{ name: string }>;
  onRocketChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  selectedRocketKey: string;
  savedCustomRockets: Array<{ id: string; name: string }>;
  onShowSaveManager: () => void;
  difficulty: string;
  onDifficultyChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onShowKeyboardHelp: () => void;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Format seconds into a MET string: `T+MM:SS.S` for < 1 hour,
 * or `T+H:MM:SS` for ≥ 1 hour.
 */
const formatMET = (seconds: number): string => {
  const totalSeconds = Math.max(0, seconds);

  if (totalSeconds >= 3600) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `T+${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `T+${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};

/** Map FlightPhase enum values to a CSS modifier and human-readable label. */
const PHASE_MAP: Record<FlightPhase, { css: string; label: string }> = {
  PRELAUNCH:          { css: 'header__phase--prelaunch',  label: 'Pre-Launch' },
  IGNITION:           { css: 'header__phase--ascending',  label: 'Ignition' },
  LIFTOFF:            { css: 'header__phase--ascending',  label: 'Liftoff' },
  ASCENDING:          { css: 'header__phase--ascending',  label: 'Ascending' },
  MAX_Q:              { css: 'header__phase--maxq',       label: 'Max Q' },
  COASTING:           { css: 'header__phase--coasting',   label: 'Coasting' },
  DESCENDING:         { css: 'header__phase--descending', label: 'Descending' },
  LANDING_BURN:       { css: 'header__phase--descending', label: 'Landing Burn' },
  LANDED:             { css: 'header__phase--landed',     label: 'Landed' },
  CRASHED:            { css: 'header__phase--crashed',    label: 'Crashed' },
  STRUCTURAL_FAILURE: { css: 'header__phase--failure',    label: 'Failure' },
};

/** Time-warp multiplier options shown as buttons. */
const TIME_MULTIPLIERS = [1, 2, 5, 10] as const;

// ── Component ──────────────────────────────────────────────────

export const MissionHeader: React.FC<MissionHeaderProps> = ({
  rocketName,
  onReset,
  onToggleAutoFly,
  onSetTimeMultiplier,
  onTogglePause,
  onToggleMute,
  onVolumeChange,
  audioMuted,
  masterVolume,
  onGoalChange,
  onCustomGoalChange,
  selectedGoalName,
  customGoalAltitude,
  altitudeGoals,
  onRocketChange,
  selectedRocketKey,
  savedCustomRockets,
  onShowSaveManager,
  difficulty,
  onDifficultyChange,
  onShowKeyboardHelp,
}) => {
  const mission = useTelemetryStore(selectMission);
  const vehicle = useTelemetryStore(selectVehicle);

  // Structural integrity → status dot
  const integrity = vehicle.structuralIntegrity;
  const statusDotClass =
    integrity > 80
      ? 'header__status-dot header__status-dot--nominal'
      : integrity >= 50
        ? 'header__status-dot header__status-dot--caution'
        : 'header__status-dot header__status-dot--warning';

  // Flight phase → badge
  const phaseInfo = PHASE_MAP[mission.phase] ?? PHASE_MAP.PRELAUNCH;

  return (
    <header className="header">
      {/* ── MET Clock ─────────────────────────────────────────── */}
      <span className="header__met">{formatMET(mission.timeElapsed)}</span>

      {/* ── Rocket name ───────────────────────────────────────── */}
      <span className="header__rocket-name">{rocketName}</span>

      {/* ── Phase badge ───────────────────────────────────────── */}
      <span className={`header__phase ${phaseInfo.css}`}>{phaseInfo.label}</span>

      {/* ── Status dot ────────────────────────────────────────── */}
      <span className={statusDotClass} title={`Structural integrity: ${integrity.toFixed(0)}%`} />

      {/* ── Controls cluster (pushed right via margin-left:auto) */}
      <div className="header__controls">
        {/* Rocket selector */}
        <select
          className="input input--select"
          value={selectedRocketKey}
          onChange={onRocketChange}
          title="Select rocket"
        >
          <option value="Simple Two-Stage">Simple Two-Stage</option>
          <option value="Falcon 9 Inspired">Falcon 9 Inspired</option>
          <option value="Three-Stage Heavy">Three-Stage Heavy</option>
          <option value="Build Custom">⚒ Build Custom</option>
          {savedCustomRockets.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        <button className="btn btn--sm" onClick={onShowSaveManager} title="Manage saved rockets">
          💾
        </button>

        <div className="header__separator" />

        {/* Goal selector */}
        <select
          className="input input--select"
          value={selectedGoalName}
          onChange={onGoalChange}
          title="Altitude goal"
        >
          {altitudeGoals.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name}
            </option>
          ))}
          <option value="Custom">Custom</option>
        </select>

        {/* Custom altitude input — visible only when "Custom" selected */}
        {selectedGoalName === 'Custom' && (
          <input
            className="input"
            type="number"
            min={0}
            placeholder="Alt (m)"
            value={customGoalAltitude ?? ''}
            onChange={onCustomGoalChange}
            title="Custom altitude goal in meters"
            style={{ width: 72 }}
          />
        )}

        <div className="header__separator" />

        {/* Difficulty selector */}
        <select
          className="input input--select"
          value={difficulty}
          onChange={onDifficultyChange}
          title="Difficulty"
        >
          <option value="easy">Easy</option>
          <option value="normal">Normal</option>
          <option value="hard">Hard</option>
          <option value="realistic">Realistic</option>
        </select>

        <div className="header__separator" />

        {/* Reset */}
        <button className="btn btn--sm" onClick={onReset} title="Reset simulation">
          ↻ Reset
        </button>

        {/* Auto-fly toggle */}
        <button
          className={`btn btn--sm ${mission.autoFlyEnabled ? 'btn--active' : ''}`}
          onClick={onToggleAutoFly}
          title={mission.autoFlyEnabled ? 'Disable auto-fly' : 'Enable auto-fly'}
        >
          🤖 Auto
        </button>

        <div className="header__separator" />

        {/* Time controls — Pause + multiplier buttons */}
        <button
          className={`btn btn--sm ${mission.isPaused ? 'btn--active' : ''}`}
          onClick={onTogglePause}
          title={mission.isPaused ? 'Resume' : 'Pause'}
        >
          {mission.isPaused ? '▶' : '⏸'}
        </button>

        {TIME_MULTIPLIERS.map((m) => (
          <button
            key={m}
            className={`btn btn--sm ${!mission.isPaused && mission.timeMultiplier === m ? 'btn--active' : ''}`}
            onClick={() => onSetTimeMultiplier(m)}
            title={`${m}× speed`}
          >
            {m}×
          </button>
        ))}

        <div className="header__separator" />

        {/* Audio controls */}
        <button
          className={`btn btn--sm ${audioMuted ? 'btn--active' : ''}`}
          onClick={onToggleMute}
          title={audioMuted ? 'Unmute' : 'Mute'}
        >
          {audioMuted ? '🔇' : '🔊'}
        </button>

        <input
          type="range"
          className="range-slider"
          min={0}
          max={1}
          step={0.05}
          value={audioMuted ? 0 : masterVolume}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
          title={`Volume: ${Math.round(masterVolume * 100)}%`}
        />

        <div className="header__separator" />

        {/* Keyboard help */}
        <button className="btn btn--sm" onClick={onShowKeyboardHelp} title="Keyboard shortcuts">
          ⌨
        </button>
      </div>
    </header>
  );
};
