/**
 * TelemetryDashboard — Master Layout Wrapper
 * ===========================================
 * Top-level component that composes all dashboard panels into the
 * CSS Grid layout defined in dashboard.css. Imports and positions:
 *
 *   - Header:   MissionHeader (receives all control props)
 *   - Left:     DynamicsPanel → AttitudeIndicator → EnvironmentPanel
 *   - Viewport: children (3D canvas / simulation view)
 *   - Right:    VehicleHealthPanel → GMeter → AnnunciatorPanel
 *   - Footer:   MissionTimeline → FlightGraph
 *
 * Grid areas are defined in dashboard.css:
 *   "header header header"
 *   "left   viewport right"
 *   "footer footer   footer"
 */

import React from 'react';
import '../../styles/dashboard.css';

// Dashboard panel components
import { MissionHeader } from './MissionHeader';
import { DynamicsPanel } from './DynamicsPanel';
import { AttitudeIndicator } from './AttitudeIndicator';
import { EnvironmentPanel } from './EnvironmentPanel';
import { VehicleHealthPanel } from './VehicleHealthPanel';
import { GMeter } from './GMeter';
import { AnnunciatorPanel } from './AnnunciatorPanel';
import { MissionTimeline } from './MissionTimeline';
import { FlightGraph } from './FlightGraph';

export interface TelemetryDashboardProps {
  /** Display name of the active rocket configuration. */
  rocketName: string;
  /** Reset simulation to initial state. */
  onReset: () => void;
  /** Toggle autonomous flight controller. */
  onToggleAutoFly: () => void;
  /** Set simulation time multiplier (1x, 2x, etc.). */
  onSetTimeMultiplier: (m: number) => void;
  /** Pause / unpause simulation. */
  onTogglePause: () => void;
  /** Mute / unmute audio. */
  onToggleMute: () => void;
  /** Adjust master audio volume (0–1). */
  onVolumeChange: (v: number) => void;
  /** Whether audio is currently muted. */
  audioMuted: boolean;
  /** Current master audio volume (0–1). */
  masterVolume: number;
  /** Handler for altitude goal selection. */
  onGoalChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  /** Handler for custom altitude goal input. */
  onCustomGoalChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Name of the currently selected altitude goal. */
  selectedGoalName: string;
  /** Custom altitude goal value (null if not using custom). */
  customGoalAltitude: number | null;
  /** Available preset altitude goals. */
  altitudeGoals: Array<{ name: string }>;
  /** Handler for rocket configuration selection. */
  onRocketChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  /** Key of the currently selected rocket. */
  selectedRocketKey: string;
  /** User-saved custom rocket configurations. */
  savedCustomRockets: Array<{ id: string; name: string }>;
  /** Open the save/load manager dialog. */
  onShowSaveManager: () => void;
  /** Current difficulty setting. */
  difficulty: string;
  /** Handler for difficulty level selection. */
  onDifficultyChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  /** Show keyboard shortcuts help overlay. */
  onShowKeyboardHelp: () => void;
  /** Canvas or simulation viewport content. */
  children?: React.ReactNode;
}

export const TelemetryDashboard: React.FC<TelemetryDashboardProps> = ({
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
  children,
}) => {
  return (
    <div className="dashboard">
      {/* ── HEADER ─────────────────────────────────── grid-area: header */}
      <MissionHeader
        rocketName={rocketName}
        onReset={onReset}
        onToggleAutoFly={onToggleAutoFly}
        onSetTimeMultiplier={onSetTimeMultiplier}
        onTogglePause={onTogglePause}
        onToggleMute={onToggleMute}
        onVolumeChange={onVolumeChange}
        audioMuted={audioMuted}
        masterVolume={masterVolume}
        onGoalChange={onGoalChange}
        onCustomGoalChange={onCustomGoalChange}
        selectedGoalName={selectedGoalName}
        customGoalAltitude={customGoalAltitude}
        altitudeGoals={altitudeGoals}
        onRocketChange={onRocketChange}
        selectedRocketKey={selectedRocketKey}
        savedCustomRockets={savedCustomRockets}
        onShowSaveManager={onShowSaveManager}
        difficulty={difficulty}
        onDifficultyChange={onDifficultyChange}
        onShowKeyboardHelp={onShowKeyboardHelp}
      />

      {/* ── LEFT SIDEBAR ──────────────────────────── grid-area: left */}
      <div className="sidebar sidebar--left">
        <DynamicsPanel />
        <AttitudeIndicator />
        <EnvironmentPanel />
      </div>

      {/* ── VIEWPORT ──────────────────────────────── grid-area: viewport */}
      <div className="dashboard__viewport">
        {children}
      </div>

      {/* ── RIGHT SIDEBAR ─────────────────────────── grid-area: right */}
      <div className="sidebar sidebar--right">
        <VehicleHealthPanel />
        <GMeter />
        <AnnunciatorPanel />
      </div>

      {/* ── FOOTER ────────────────────────────────── grid-area: footer */}
      <div className="footer">
        <MissionTimeline />
        <FlightGraph />
      </div>
    </div>
  );
};
