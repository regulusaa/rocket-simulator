/**
 * AnnunciatorPanel — Right sidebar subsystem status lights.
 *
 * Displays 6 status lights in a 3×2 grid:
 *   PROP   — propellant levels across active stages
 *   STRUCT — structural integrity
 *   AERO   — dynamic pressure (Q) relative to limits
 *   THERM  — stagnation temperature
 *   GNC    — guidance, navigation & control mode
 *   ENG    — engine status
 *
 * Each light shows GO (green), CAUTION (yellow), or WARNING (red).
 *
 * Subscribes to `selectVehicle`, `selectEnvironment`, and `selectMission`.
 */

import React from 'react';
import {
  useTelemetryStore,
  selectVehicle,
  selectEnvironment,
  selectMission,
} from '../../store/telemetryStore';
import type {
  VehicleSlice,
  EnvironmentSlice,
  MissionSlice,
} from '../../store/telemetryStore';

// ── Types ──────────────────────────────────────────────────────

type LightStatus = 'go' | 'caution' | 'warning';

interface LightDef {
  label: string;
  status: LightStatus;
  value: string;
}

// ── Status derivation logic ────────────────────────────────────

/**
 * PROP — Propellant.
 * Green: any active stage has fuel >20%.
 * Yellow: any active stage <20%.
 * Red: all stages empty or 0%.
 */
const deriveProp = (vehicle: VehicleSlice): LightDef => {
  const activeStages = vehicle.stages.filter((s) => !s.isSeparated);
  if (activeStages.length === 0) {
    return { label: 'PROP', status: 'warning', value: 'EMPTY' };
  }
  const allEmpty = activeStages.every((s) => s.fuelPercent <= 0);
  if (allEmpty) {
    return { label: 'PROP', status: 'warning', value: 'EMPTY' };
  }
  const anyLow = activeStages.some((s) => s.fuelPercent < 20);
  if (anyLow) {
    return { label: 'PROP', status: 'caution', value: 'LOW' };
  }
  return { label: 'PROP', status: 'go', value: 'GO' };
};

/**
 * STRUCT — Structural integrity.
 * Green: >80%. Yellow: 50-80%. Red: <50%.
 */
const deriveStruct = (vehicle: VehicleSlice): LightDef => {
  const si = vehicle.structuralIntegrity;
  if (si < 50) return { label: 'STRUCT', status: 'warning', value: 'CRIT' };
  if (si < 80) return { label: 'STRUCT', status: 'caution', value: 'WARN' };
  return { label: 'STRUCT', status: 'go', value: 'GO' };
};

/**
 * AERO — Aerodynamic pressure.
 * Green: Q < 25000 Pa. Yellow: 25000–33000 Pa. Red: >33000 Pa.
 */
const deriveAero = (env: EnvironmentSlice): LightDef => {
  const q = env.dynamicPressureQ;
  if (q > 33000) return { label: 'AERO', status: 'warning', value: 'MAXQ' };
  if (q >= 25000) return { label: 'AERO', status: 'caution', value: 'HIGH' };
  return { label: 'AERO', status: 'go', value: 'GO' };
};

/**
 * THERM — Thermal.
 * Green: <1500K. Yellow: 1500–2500K. Red: >2500K.
 */
const deriveTherm = (env: EnvironmentSlice): LightDef => {
  const t = env.stagnationTemp;
  if (t > 2500) return { label: 'THERM', status: 'warning', value: 'CRIT' };
  if (t >= 1500) return { label: 'THERM', status: 'caution', value: 'HOT' };
  return { label: 'THERM', status: 'go', value: 'GO' };
};

/**
 * GNC — Guidance, Navigation & Control.
 * Green: autoFly enabled. Yellow: manual mode. Red: structural failure.
 */
const deriveGnc = (
  mission: MissionSlice,
  vehicle: VehicleSlice,
): LightDef => {
  if (vehicle.didBreakApart || mission.phase === 'STRUCTURAL_FAILURE') {
    return { label: 'GNC', status: 'warning', value: 'FAIL' };
  }
  if (mission.autoFlyEnabled) {
    return { label: 'GNC', status: 'go', value: 'AUTO' };
  }
  return { label: 'GNC', status: 'caution', value: 'MAN' };
};

/**
 * ENG — Engine status.
 * Green: throttle >0 and stages active.
 * Yellow: throttle 0 while flying.
 * Red: didBreakApart.
 */
const deriveEng = (
  vehicle: VehicleSlice,
  mission: MissionSlice,
): LightDef => {
  if (vehicle.didBreakApart) {
    return { label: 'ENG', status: 'warning', value: 'FAIL' };
  }
  const isFlying =
    mission.phase !== 'PRELAUNCH' &&
    mission.phase !== 'LANDED' &&
    mission.phase !== 'CRASHED' &&
    mission.phase !== 'STRUCTURAL_FAILURE';
  const hasActiveStages = vehicle.stages.some((s) => !s.isSeparated);
  if (vehicle.throttlePercent > 0 && hasActiveStages) {
    return { label: 'ENG', status: 'go', value: 'GO' };
  }
  if (isFlying && vehicle.throttlePercent <= 0) {
    return { label: 'ENG', status: 'caution', value: 'IDLE' };
  }
  return { label: 'ENG', status: 'go', value: 'STBY' };
};

// ── Status dot modifier class ──────────────────────────────────

const dotClass = (status: LightStatus): string => {
  switch (status) {
    case 'go':
      return 'status-light__dot status-light__dot--go';
    case 'caution':
      return 'status-light__dot status-light__dot--caution';
    case 'warning':
      return 'status-light__dot status-light__dot--warning';
  }
};

const valueColor = (status: LightStatus): string => {
  switch (status) {
    case 'go':
      return 'var(--accent-green)';
    case 'caution':
      return 'var(--accent-yellow)';
    case 'warning':
      return 'var(--accent-red)';
  }
};

// ── Single Light ───────────────────────────────────────────────

const StatusLight: React.FC<{ def: LightDef }> = ({ def }) => (
  <div className="status-light">
    <div className={dotClass(def.status)} />
    <span className="status-light__label">{def.label}</span>
    <span
      className="status-light__value"
      style={{ color: valueColor(def.status) }}
    >
      {def.value}
    </span>
  </div>
);

// ── Main Component ─────────────────────────────────────────────

export const AnnunciatorPanel: React.FC = () => {
  const vehicle = useTelemetryStore(selectVehicle);
  const environment = useTelemetryStore(selectEnvironment);
  const mission = useTelemetryStore(selectMission);

  const lights: LightDef[] = [
    deriveProp(vehicle),
    deriveStruct(vehicle),
    deriveAero(environment),
    deriveTherm(environment),
    deriveGnc(mission, vehicle),
    deriveEng(vehicle, mission),
  ];

  return (
    <div className="panel">
      {/* Header */}
      <div className="panel__header">
        <span className="panel__title">Subsystems</span>
      </div>

      {/* 3×2 grid of status lights */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 'var(--space-sm)',
        }}
      >
        {lights.map((light) => (
          <StatusLight key={light.label} def={light} />
        ))}
      </div>
    </div>
  );
};
