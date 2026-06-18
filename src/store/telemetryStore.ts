/**
 * TELEMETRY STORE — Zustand State Management
 * ============================================
 * Central store for all telemetry data flowing from the game loop
 * to the dashboard UI. Uses Zustand with subscribeWithSelector
 * middleware so each panel can subscribe to only its relevant slice,
 * preventing cascade re-renders.
 *
 * ARCHITECTURE:
 *   Game Loop (rAF) → store.getState().updateX() → React components re-render selectively
 *
 * Five isolated slices:
 *   1. dynamics     — position, velocity, angle (updates every 3 frames)
 *   2. environment  — Mach, Q, temperature (updates every 3 frames)
 *   3. vehicle      — fuel, thrust, structural integrity (updates every 3 frames)
 *   4. mission      — phase, events, MET (updates on events)
 *   5. chartData    — rolling history buffers (updates every 10 frames)
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { DifficultyLevel } from '../physics/EngineFailureSystem';

// ── TYPES ──────────────────────────────────────────────────────

/** Flight phase — determines the header phase badge color and label. */
export type FlightPhase =
  | 'PRELAUNCH'
  | 'IGNITION'
  | 'LIFTOFF'
  | 'ASCENDING'
  | 'MAX_Q'
  | 'COASTING'
  | 'DESCENDING'
  | 'LANDING_BURN'
  | 'LANDED'
  | 'CRASHED'
  | 'STRUCTURAL_FAILURE';

/** Per-stage status — fuel level and separation state. */
export interface StageStatus {
  stageNumber: number;
  name: string;
  fuelPercent: number;       // 0-100
  isActive: boolean;
  isSeparated: boolean;
  isThrusting: boolean;
  thrustPercentage: number;  // 0-100
}

/** Mission event — timestamped flight event for the timeline. */
export interface MissionEvent {
  time: number;       // seconds since launch
  message: string;    // e.g. "IGNITION", "LIFTOFF", "MAX-Q 28.4 kPa"
  type: 'ignition' | 'liftoff' | 'staging' | 'maxq' | 'parachute' | 'landing' | 'failure' | 'info';
}

/** A single data point in the rolling chart buffers. */
export interface ChartPoint {
  t: number;   // time in seconds
  v: number;   // value (velocity, altitude, Q, or G — depends on which buffer)
}

// ── SLICE INTERFACES ───────────────────────────────────────────

export interface DynamicsSlice {
  altitude: number;          // meters
  velocityX: number;         // m/s horizontal
  velocityY: number;         // m/s vertical
  speed: number;             // magnitude m/s
  angle: number;             // radians from vertical
  angularVelocity: number;   // rad/s
  accelerationX: number;     // m/s²
  accelerationY: number;     // m/s²
  maxAltitude: number;       // meters
  isFlying: boolean;
  hasLanded: boolean;
  positionX: number;         // meters horizontal (downrange)
}

export interface EnvironmentSlice {
  machNumber: number;
  dynamicPressureQ: number;     // Pa
  maxQ: number;                 // Pa — peak Q reached
  maxQAltitude: number;         // meters — altitude at peak Q
  stagnationTemp: number;       // K
  currentGForce: number;        // G
}

export interface VehicleSlice {
  structuralIntegrity: number;    // 0-100
  throttlePercent: number;        // 0-100
  stages: StageStatus[];          // per-stage info
  activeStage: number;            // stage number
  totalMass: number;              // kg
  totalThrust: number;            // N
  twr: number;                    // thrust-to-weight ratio
  didBreakApart: boolean;
}

export interface MissionSlice {
  phase: FlightPhase;
  timeElapsed: number;            // seconds
  events: MissionEvent[];
  landingScore: number | null;
  landingQuality: string | null;
  autoFlyEnabled: boolean;
  autoFlyPhase: string;
  difficulty: DifficultyLevel;
  isPaused: boolean;
  timeMultiplier: number;
}

export interface ChartDataSlice {
  velocityHistory: ChartPoint[];
  altitudeHistory: ChartPoint[];
  qHistory: ChartPoint[];
  gHistory: ChartPoint[];
}

// ── FULL STORE INTERFACE ───────────────────────────────────────

export interface TelemetryStore {
  dynamics: DynamicsSlice;
  environment: EnvironmentSlice;
  vehicle: VehicleSlice;
  mission: MissionSlice;
  chartData: ChartDataSlice;

  // Actions — called from the game loop
  updateDynamics: (data: Partial<DynamicsSlice>) => void;
  updateEnvironment: (data: Partial<EnvironmentSlice>) => void;
  updateVehicle: (data: Partial<VehicleSlice>) => void;
  updateMission: (data: Partial<MissionSlice>) => void;
  pushChartPoint: (t: number, v: number, alt: number, q: number, g: number) => void;
  addMissionEvent: (event: MissionEvent) => void;
  resetAll: () => void;
}

// ── INITIAL STATE ──────────────────────────────────────────────

const MAX_CHART_POINTS = 720; // 120 seconds at 6Hz

const initialDynamics: DynamicsSlice = {
  altitude: 0,
  velocityX: 0,
  velocityY: 0,
  speed: 0,
  angle: 0,
  angularVelocity: 0,
  accelerationX: 0,
  accelerationY: 0,
  maxAltitude: 0,
  isFlying: false,
  hasLanded: false,
  positionX: 0,
};

const initialEnvironment: EnvironmentSlice = {
  machNumber: 0,
  dynamicPressureQ: 0,
  maxQ: 0,
  maxQAltitude: 0,
  stagnationTemp: 288,
  currentGForce: 0,
};

const initialVehicle: VehicleSlice = {
  structuralIntegrity: 100,
  throttlePercent: 0,
  stages: [],
  activeStage: 0,
  totalMass: 0,
  totalThrust: 0,
  twr: 0,
  didBreakApart: false,
};

const initialMission: MissionSlice = {
  phase: 'PRELAUNCH',
  timeElapsed: 0,
  events: [],
  landingScore: null,
  landingQuality: null,
  autoFlyEnabled: false,
  autoFlyPhase: 'MANUAL',
  difficulty: 'normal',
  isPaused: false,
  timeMultiplier: 1,
};

const initialChartData: ChartDataSlice = {
  velocityHistory: [],
  altitudeHistory: [],
  qHistory: [],
  gHistory: [],
};

// ── STORE CREATION ─────────────────────────────────────────────

export const useTelemetryStore = create<TelemetryStore>()(
  subscribeWithSelector((set) => ({
    dynamics: { ...initialDynamics },
    environment: { ...initialEnvironment },
    vehicle: { ...initialVehicle },
    mission: { ...initialMission },
    chartData: { ...initialChartData },

    updateDynamics: (data) =>
      set((state) => ({
        dynamics: { ...state.dynamics, ...data },
      })),

    updateEnvironment: (data) =>
      set((state) => ({
        environment: { ...state.environment, ...data },
      })),

    updateVehicle: (data) =>
      set((state) => ({
        vehicle: { ...state.vehicle, ...data },
      })),

    updateMission: (data) =>
      set((state) => ({
        mission: { ...state.mission, ...data },
      })),

    pushChartPoint: (t, v, alt, q, g) =>
      set((state) => {
        const trimToMax = (arr: ChartPoint[], newPoint: ChartPoint) => {
          const result = [...arr, newPoint];
          return result.length > MAX_CHART_POINTS
            ? result.slice(result.length - MAX_CHART_POINTS)
            : result;
        };
        return {
          chartData: {
            velocityHistory: trimToMax(state.chartData.velocityHistory, { t, v }),
            altitudeHistory: trimToMax(state.chartData.altitudeHistory, { t, v: alt }),
            qHistory: trimToMax(state.chartData.qHistory, { t, v: q }),
            gHistory: trimToMax(state.chartData.gHistory, { t, v: g }),
          },
        };
      }),

    addMissionEvent: (event) =>
      set((state) => ({
        mission: {
          ...state.mission,
          events: [...state.mission.events, event].slice(-20), // Cap at 20 events
        },
      })),

    resetAll: () =>
      set({
        dynamics: { ...initialDynamics },
        environment: { ...initialEnvironment },
        vehicle: { ...initialVehicle },
        mission: { ...initialMission },
        chartData: { ...initialChartData },
      }),
  }))
);

// ── SELECTOR HOOKS ─────────────────────────────────────────────
// Pre-defined selectors for common use cases. Using these instead of
// inline selectors prevents creating new function references each render.

export const selectDynamics = (s: TelemetryStore) => s.dynamics;
export const selectEnvironment = (s: TelemetryStore) => s.environment;
export const selectVehicle = (s: TelemetryStore) => s.vehicle;
export const selectMission = (s: TelemetryStore) => s.mission;
export const selectChartData = (s: TelemetryStore) => s.chartData;
