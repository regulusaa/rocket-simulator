import sys

with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

def get_block(start_str, end_str=None, end_offset=0):
    start_idx = -1
    for i, l in enumerate(lines):
        if start_str in l:
            start_idx = i
            break
    if start_idx == -1: return -1, -1
    
    end_idx = start_idx
    if end_str:
        for i in range(start_idx, len(lines)):
            if end_str in lines[i]:
                end_idx = i + end_offset
                break
    return start_idx, end_idx

# 1. Imports
start_idx, end_idx = get_block("createMultiStageRocket,", "} from \"../physics/engine\";")
new_imports = """  createMultiStageRocket,
  updatePhysics,
  applyControls,
  calculateLandingScore,
  getStageFuelStatus,
} from "../physics/engine";

import { useTelemetryStore } from "../store/telemetryStore";
import { TelemetryDashboard } from "./dashboard/TelemetryDashboard";
import type { FlightPhase } from "../store/telemetryStore";\n"""
lines[start_idx:end_idx+1] = [new_imports]

# 2. Remove TrajectoryPanel import
idx, _ = get_block("import { TrajectoryPanel } from \"./TrajectoryPanel\";")
lines[idx] = "// TrajectoryPanel removed in favor of TelemetryDashboard\n"

# 3. Refactor mission log pushes (Ignition to Parachute)
start_idx, end_idx = get_block("// ── MISSION LOG EVENT DETECTION (first sub-step only) ────────────────", "if (!loggedParaRef.current && parachuteDeployedRef.current) {", 4)
new_log_block = """        // ── MISSION LOG EVENT DETECTION (first sub-step only) ────────────────
        if (step === 0) {
          const t = frame.state.timeElapsed;
          const store = useTelemetryStore.getState();

          // IGNITION
          const activeStgForLog = config.stages.find((s) => s.isActive && !s.isSeparated);
          if (!loggedIgnitionRef.current && activeStgForLog && activeStgForLog.thrustPercentage > 0) {
            loggedIgnitionRef.current = true;
            store.addMissionEvent({ time: t, message: "IGNITION", type: "ignition" });
          }

          // LIFTOFF
          if (!loggedLiftoffRef.current && frame.state.isFlying && frame.state.velocity.y > 2) {
            loggedLiftoffRef.current = true;
            store.addMissionEvent({ time: t, message: "LIFTOFF", type: "liftoff" });
          }

          // STAGING
          if (frame.state.stageSeparationCount > prevStageSepRef.current) {
            const stageNum = frame.state.stageSeparationCount;
            store.addMissionEvent({ time: t, message: `STAGE ${stageNum} SEP`, type: "staging" });
            prevStageSepRef.current = frame.state.stageSeparationCount;
          }

          // MAX-Q
          if (!loggedMaxQRef.current && maxQPassedRef.current) {
            loggedMaxQRef.current = true;
            const qKpa = (currentAtmoDataRef.current.maxDynamicPressure / 1000).toFixed(1);
            store.addMissionEvent({ time: t, message: `MAX-Q ${qKpa} kPa`, type: "maxq" });
          }

          // PARACHUTE
          if (!loggedParaRef.current && parachuteDeployedRef.current) {
            loggedParaRef.current = true;
            store.addMissionEvent({ time: t, message: "CHUTE DEPLOYED", type: "parachute" });
          }
        }\n"""
lines[start_idx:end_idx] = [new_log_block]

# 4. Touchdown event log
start_idx, end_idx = get_block("missionLogRef.current.push({", "message: `TOUCHDOWN ${landV} m/s`,", 2)
new_td_log = """          useTelemetryStore.getState().addMissionEvent({
            time: frame.state.timeElapsed,
            message: `TOUCHDOWN ${landV} m/s`,
            type: "landing",
          });\n"""
lines[start_idx:end_idx] = [new_td_log]

# 5. Remove drawTelemetry
start_idx, end_idx = get_block("// 7. Extended telemetry HUD with atmospheric and structural readings.", ");", 0)
lines[start_idx:end_idx+1] = ["      // Telemetry HUD rendering removed (now handled by React DOM TelemetryDashboard)\n"]

# 6. Store Sync every 3 frames
start_idx, end_idx = get_block("// ── SYNC TO REACT STATE (every 3 frames to reduce re-renders) ──────────", "}", 0)
new_sync = """      // ── SYNC TO REACT STATE & ZUSTAND STORE (every 3 frames) ──────────
      if (frameCount % 3 === 0) {
        setDisplayFlightState({ ...flightStateRef.current });
        const store = useTelemetryStore.getState();
        const st = flightStateRef.current;
        const atmo = currentAtmoDataRef.current;
        const struct = structuralStateRef.current;
        const config = rocketConfigRef.current;
        const activeStage = config.stages.find(s => s.isActive && !s.isSeparated);
        const activeStageIdx = config.stages.findIndex(s => s.isActive && !s.isSeparated);

        store.updateDynamics({
          altitude: st.position.y,
          velocityX: st.velocity.x,
          velocityY: st.velocity.y,
          speed: Math.sqrt(st.velocity.x**2 + st.velocity.y**2),
          angle: st.angle,
          angularVelocity: st.angularVelocity,
          maxAltitude: st.maxAltitudeReached,
          isFlying: st.isFlying,
          hasLanded: st.hasLanded,
          positionX: st.position.x,
        });

        store.updateEnvironment({
          machNumber: atmo.machNumber,
          dynamicPressureQ: atmo.dynamicPressure,
          maxQ: atmo.maxDynamicPressure,
          maxQAltitude: atmo.maxQAltitude,
          stagnationTemp: atmo.stagnationTemperature,
          currentGForce: struct.currentAccelerationG,
        });

        const stagesInfo = getStageFuelStatus(config);
        store.updateVehicle({
          structuralIntegrity: struct.structuralIntegrity,
          throttlePercent: activeStage ? activeStage.thrustPercentage : 0,
          stages: stagesInfo.map(s => ({
            stageNumber: s.stageIndex + 1,
            name: s.name,
            fuelPercent: s.fuelPercent,
            isActive: s.isActive,
            isSeparated: s.isSeparated,
            isThrusting: s.thrustPercentage > 0,
            thrustPercentage: s.thrustPercentage
          })),
          activeStage: activeStageIdx + 1,
          totalMass: st.mass,
          totalThrust: activeStage ? activeStage.thrust * (activeStage.thrustPercentage/100) : 0,
          twr: activeStage ? (activeStage.thrust * (activeStage.thrustPercentage/100)) / (st.mass * GRAVITY) : 0,
          didBreakApart: isStructuralFailureRef.current
        });

        let phase: import('../store/telemetryStore').FlightPhase = 'PRELAUNCH';
        if (isStructuralFailureRef.current) phase = 'STRUCTURAL_FAILURE';
        else if (st.hasLanded) phase = 'LANDED';
        else if (st.isFlying && st.velocity.y < -5) phase = 'DESCENDING';
        else if (st.isFlying && st.velocity.y > 2) {
          if (atmo.dynamicPressure > 10000 && atmo.dynamicPressure > atmo.maxDynamicPressure * 0.9) phase = 'MAX_Q';
          else phase = 'ASCENDING';
        }
        else if (st.isFlying) phase = 'COASTING';

        store.updateMission({
          phase,
          timeElapsed: st.timeElapsed,
          autoFlyEnabled: autoFlyEnabledRef.current,
          autoFlyPhase: autoFlyStatusRef.current,
          difficulty: engineFailureStateRef.current.difficulty,
          isPaused: isPausedRef.current,
          timeMultiplier: timeMultiplierRef.current
        });
      }\n"""
lines[start_idx:end_idx+1] = [new_sync]

# 7. pushChartPoint
start_idx, end_idx = get_block("if (frameCount % 10 === 0) {", "setMissionLog([...logSnapshot]);\n      }", 1)
new_chart = """      if (frameCount % 10 === 0) {
        const limited = trajectoryLimiterRef.current.limitTrajectory(
          [...trajectoryBufferRef.current] // Pass a copy — limiter may truncate
        );
        setTrajectoryHistory(limited);
        
        useTelemetryStore.getState().pushChartPoint(
          flightStateRef.current.timeElapsed,
          Math.sqrt(flightStateRef.current.velocity.x**2 + flightStateRef.current.velocity.y**2),
          flightStateRef.current.position.y,
          currentAtmoDataRef.current.dynamicPressure,
          structuralStateRef.current.currentAccelerationG
        );
      }\n"""
lines[start_idx:end_idx+1] = [new_chart]

# 8. Render block
start_idx, end_idx = get_block("// ── RENDER ───────────────────────────────────────────────────────────────", "{/* ── LANDING RESULTS MODAL — centered overlay ────────────────────────── */}", -1)
new_render = """  // ── RENDER ───────────────────────────────────────────────────────────────
  return (
    <TelemetryDashboard
      rocketName={rocketConfig.name}
      onReset={handleReset}
      onToggleAutoFly={() => {
        const newEnabled = !autoFlyEnabledRef.current;
        autoFlyEnabledRef.current = newEnabled;
        if (newEnabled) {
          autoFlyStartTimeRef.current = flightStateRef.current.timeElapsed;
          autoFlyManualOverrideRef.current = false;
          autoFlyStatusRef.current = "AUTO-FLY (Throttle Up)";
        } else {
          autoFlyStatusRef.current = "MANUAL";
        }
        setAutoFlyEnabled(newEnabled);
        audioManagerRef.current.playSound("ui-click");
      }}
      onSetTimeMultiplier={(m) => { setTimeMultiplier(m); setIsPaused(false); }}
      onTogglePause={() => setIsPaused((p) => !p)}
      onToggleMute={() => {
        const muted = audioManagerRef.current.toggleMute();
        setAudioMuted(muted);
      }}
      onVolumeChange={handleVolumeChange}
      audioMuted={audioMuted}
      masterVolume={masterVolume}
      onGoalChange={handleGoalChange}
      onCustomGoalChange={handleCustomGoal}
      selectedGoalName={selectedGoal?.name ?? "custom"}
      customGoalAltitude={customGoalAltitude}
      altitudeGoals={ALTITUDE_GOALS}
      onRocketChange={handleRocketChange}
      selectedRocketKey={selectedRocketKey}
      savedCustomRockets={savedCustomRockets}
      onShowSaveManager={() => setShowSaveManager(true)}
      difficulty={difficulty}
      onDifficultyChange={(e) => setDifficulty(e.target.value as any)}
      onShowKeyboardHelp={() => setShowKeyboardHelp(true)}
    >
      <div
        style={{
          position:   "absolute",
          inset:      0,
          overflow:   "hidden",
        }}
      >
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={canvasHeight}
          onClick={handleCanvasClick}
          style={{
            position: "absolute",
            top:      0,
            left:     0,
            width:    "100%",
            height:   "100%",
            cursor:   "crosshair",
          }}
        />

"""
lines[start_idx:end_idx] = [new_render]

# Add closing tag for TelemetryDashboard at the very end
start_idx, end_idx = get_block("    </div>\n  );\n};", "", 0)
lines[start_idx] = "      </div>\n    </TelemetryDashboard>\n  );\n};\n"

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(lines)
print("Done")
