/**
 * ROCKET SIMULATOR - FINAL COMPLETE VERSION (WITH AUDIO)
 * =======================================================
 * Complete integrated rocket simulator with all features:
 * - Multi-stage rocket physics and staging
 * - Advanced landing mechanics with parachutes
 * - Particle effects and trajectory visualization
 * - Real-time performance monitoring and optimization
 * - Complete audio system with sound effects
 * 
 * All systems fully integrated and optimized.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  createMultiStageRocket,
  updatePhysics,
  resetRocket,
  applyControls,
  calculateLandingScore,
} from "../physics/engine";
import type { MultiStageRocketState } from "../physics/engine";
import { TrajectoryPanel } from "./TrajectoryPanel";
import { ParticleSystem } from "../physics/ParticleSystem";
import {
  createParachute,
  createLandingGear,
  createLandingState,
  deployParachute,
  updateParachute,
  processLanding,
  type Parachute,
  type LandingGear,
  type LandingState,
} from "../physics/LandingMechanics";
import {
  PerformanceMonitor,
  TrajectoryLimiter,
  getPerformanceStatus,
  type PerformanceMetrics,
} from "../utils/PerformanceMonitor";
import { AudioManager, type SoundEffect } from "../utils/AudioSystem";
import {
  GRAVITY,
  DRAG_COEFFICIENT,
  ROCKET_RADIUS,
  PHYSICS_TICK_RATE,
  WIND_SPEED,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  PIXELS_PER_METER,
  ROCKET_BODY_WIDTH,
  ROCKET_NOSE_HEIGHT,
  ROCKET_FLAME_HEIGHT_MIN,
  ROCKET_FLAME_HEIGHT_MAX,
  COLORS,
  ALTITUDE_GOALS,
  INFO_PANEL_WIDTH,
  INFO_PANEL_HEIGHT,
  INFO_PANEL_MARGIN,
  FONT_SIZE_MEDIUM,
  FONT_SIZE_SMALL,
  DEBUG_MODE,
} from "../utils/constants";
import {
  ROCKET_FALCON_9_INSPIRED,
  ROCKET_SIMPLE_TWO_STAGE,
  ROCKET_THREE_STAGE,
  type MultiStageRocketConfig,
} from "../physics/MultiStageSystem";
import type { AltitudeGoal } from "../physics/types";

/**
 * Complete final RocketSimulator component with audio integration
 */
export const RocketSimulator: React.FC = () => {
  // === REFS (persistent across renders) ===

  // Canvas reference
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Animation frame ID
  const animationFrameRef = useRef<number | null>(null);

  // Input tracking
  const keysPressed = useRef<{ [key: string]: boolean }>({});

  // Particle system
  const particleSystemRef = useRef<ParticleSystem>(new ParticleSystem());

  // Performance monitoring
  const performanceMonitorRef = useRef<PerformanceMonitor>(
    new PerformanceMonitor()
  );

  // Trajectory optimization
  const trajectoryLimiterRef = useRef(
    new TrajectoryLimiter({
      maxPoints: 50000,
      sampleRate: 1,
      cleanupInterval: 5,
    })
  );

  // === NEW: AUDIO SYSTEM ===

  // Audio manager for all sound effects
  const audioManagerRef = useRef<AudioManager>(new AudioManager());

  // Track previous throttle state for throttle up/down sounds
  const previousThrottleRef = useRef<number>(0);

  // Track if engine is currently playing
  const engineSoundPlayingRef = useRef<boolean>(false);

  // === STATE ===

  // Flight state
  const [flightState, setFlightState] = useState<MultiStageRocketState>(() =>
    createMultiStageRocket(ROCKET_SIMPLE_TWO_STAGE)
  );

  // Rocket configuration
  const [rocketConfig, setRocketConfig] = useState<MultiStageRocketConfig>(
    ROCKET_SIMPLE_TWO_STAGE
  );

  // Selected goal
  const [selectedGoal, setSelectedGoal] = useState<AltitudeGoal | null>(
    ALTITUDE_GOALS[0]
  );

  // Custom goal
  const [customGoalAltitude, setCustomGoalAltitude] = useState<number | null>(
    null
  );

  // Landing score
  const [landingScore, setLandingScore] = useState<number | null>(null);

  // Fullscreen trajectory
  const [showFullscreenTrajectory, setShowFullscreenTrajectory] =
    useState(false);

  // Trajectory history
  const [trajectoryHistory, setTrajectoryHistory] = useState<
    Array<{ x: number; y: number }>
  >([]);

  // Particle count
  const [particleCount, setParticleCount] = useState(0);

  // Landing mechanics
  const [landingState, setLandingState] = useState<LandingState>(
    createLandingState()
  );

  const [finalStageParachute, setFinalStageParachute] = useState<Parachute>(
    createParachute(100000, 1)
  );

  const [landingGear, setLandingGear] = useState<LandingGear>(
    createLandingGear(500000)
  );

  const parachuteDeployedRef = useRef(false);

  // Performance metrics
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics>(
    performanceMonitorRef.current.getMetrics()
  );

  const [showPerformanceStats, setShowPerformanceStats] = useState(DEBUG_MODE);

  // === NEW: AUDIO STATE ===

  // Is audio muted?
  const [audioMuted, setAudioMuted] = useState(false);

  // Master volume (0-1)
  const [masterVolume, setMasterVolume] = useState(0.5);

  // === EVENT HANDLERS ===

  /**
   * Handle key press
   */
  const handleKeyDown = (e: KeyboardEvent) => {
    keysPressed.current[e.key.toLowerCase()] = true;

    // ESC closes fullscreen
    if (e.key === "Escape") {
      setShowFullscreenTrajectory(false);
    }

    // Spacebar doesn't scroll
    if (e.key === " ") {
      e.preventDefault();
    }

    // P toggles performance stats
    if (e.key === "p" || e.key === "P") {
      setShowPerformanceStats((prev) => !prev);
    }

    // M toggles audio mute
    if (e.key === "m" || e.key === "M") {
      const newMuted = audioManagerRef.current.toggleMute();
      setAudioMuted(newMuted);
      audioManagerRef.current.playSound("ui-click");
    }
  };

  /**
   * Handle key release
   */
  const handleKeyUp = (e: KeyboardEvent) => {
    keysPressed.current[e.key.toLowerCase()] = false;
  };

  /**
   * Handle canvas click
   */
  const handleCanvasClick = () => {
    keysPressed.current["mouseClick"] = true;
  };

  /**
   * Handle rocket selection with sound effect
   */
  const handleRocketChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedName = e.target.value;

    let selectedConfig: MultiStageRocketConfig | null = null;

    if (selectedName === "Simple Two-Stage") {
      selectedConfig = ROCKET_SIMPLE_TWO_STAGE;
    } else if (selectedName === "Falcon 9 Inspired") {
      selectedConfig = ROCKET_FALCON_9_INSPIRED;
    } else if (selectedName === "Three-Stage Heavy") {
      selectedConfig = ROCKET_THREE_STAGE;
    }

    if (selectedConfig) {
      const newState = createMultiStageRocket(selectedConfig);
      setFlightState(newState);
      setRocketConfig(selectedConfig);
      setLandingScore(null);
      setTrajectoryHistory([]);

      setLandingState(createLandingState());
      setFinalStageParachute(createParachute(100000, 1));
      setLandingGear(createLandingGear(500000));
      parachuteDeployedRef.current = false;

      performanceMonitorRef.current.reset();

      particleSystemRef.current.clear();

      // Play UI sound
      audioManagerRef.current.playSound("ui-select");
    }
  };

  /**
   * Handle goal selection with sound
   */
  const handleGoalChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const goalName = e.target.value;
    const goal = ALTITUDE_GOALS.find((g) => g.name === goalName);

    if (goal) {
      setSelectedGoal(goal);
      setCustomGoalAltitude(null);
      audioManagerRef.current.playSound("ui-select");
    }
  };

  /**
   * Handle custom goal input
   */
  const handleCustomGoal = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    if (value === "") {
      setCustomGoalAltitude(null);
      setSelectedGoal(ALTITUDE_GOALS[0]);
    } else {
      const altitude = parseFloat(value);
      if (!isNaN(altitude) && altitude > 0) {
        setCustomGoalAltitude(altitude);
        setSelectedGoal(null);
      }
    }
  };

  /**
   * Handle reset button with sound
   */
  const handleReset = () => {
    resetRocket(flightState, rocketConfig);
    setFlightState({ ...flightState });
    setLandingScore(null);
    setShowFullscreenTrajectory(false);
    setTrajectoryHistory([]);

    setLandingState(createLandingState());
    setFinalStageParachute(createParachute(100000, 1));
    setLandingGear(createLandingGear(500000));
    parachuteDeployedRef.current = false;

    performanceMonitorRef.current.reset();

    particleSystemRef.current.clear();

    // Stop all audio and play click sound
    audioManagerRef.current.stopAllSounds();
    audioManagerRef.current.playSound("ui-click");

    engineSoundPlayingRef.current = false;
  };

  /**
   * Handle volume change
   */
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const volume = parseFloat(e.target.value);
    setMasterVolume(volume);
    audioManagerRef.current.setMasterVolume(volume);
  };

  // === DRAWING FUNCTIONS ===

  /**
   * Draw the ground
   */
  const drawGround = (ctx: CanvasRenderingContext2D) => {
    const groundY = CANVAS_HEIGHT - 20;

    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, groundY, CANVAS_WIDTH, 20);

    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(CANVAS_WIDTH, groundY);
    ctx.stroke();
  };

  /**
   * Draw the rocket
   */
  const drawRocket = (ctx: CanvasRenderingContext2D, state: MultiStageRocketState) => {
    const screenX = (CANVAS_WIDTH / 2) + (state.position.x * PIXELS_PER_METER);
    const screenY = CANVAS_HEIGHT - 20 - (state.position.y * PIXELS_PER_METER);

    let currentScreenY = screenY;

    // Draw each stage
    for (let i = 0; i < rocketConfig.stages.length; i++) {
      const stage = rocketConfig.stages[i];

      if (stage.isSeparated) continue;

      const stageColor = `rgba(${200 - i * 40}, ${200 - i * 40}, ${200 - i * 40}, 1)`;
      const stageHeight = 30 + i * 5;

      ctx.fillStyle = stageColor;
      ctx.fillRect(
        screenX - ROCKET_BODY_WIDTH / 2,
        currentScreenY - stageHeight,
        ROCKET_BODY_WIDTH,
        stageHeight
      );

      ctx.strokeStyle = COLORS.text;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        screenX - ROCKET_BODY_WIDTH / 2,
        currentScreenY - stageHeight,
        ROCKET_BODY_WIDTH,
        stageHeight
      );

      // Fuel bar
      const fuelPercent = (stage.fuelMass / stage.fuelCapacity) * 100;
      const fuelBarWidth = (ROCKET_BODY_WIDTH - 4) * (fuelPercent / 100);
      const fuelColor = fuelPercent > 20 ? "#00ff00" : "#ff4444";

      ctx.fillStyle = fuelColor;
      ctx.fillRect(
        screenX - ROCKET_BODY_WIDTH / 2 + 2,
        currentScreenY - stageHeight + 3,
        fuelBarWidth,
        stageHeight - 6
      );

      currentScreenY -= stageHeight;
    }

    // Nose cone
    ctx.fillStyle = COLORS.rocketNose;
    ctx.beginPath();
    ctx.moveTo(screenX, currentScreenY - ROCKET_NOSE_HEIGHT);
    ctx.lineTo(screenX - ROCKET_BODY_WIDTH / 2, currentScreenY);
    ctx.lineTo(screenX + ROCKET_BODY_WIDTH / 2, currentScreenY);
    ctx.closePath();
    ctx.fill();

    // Flame
    const activeStage = rocketConfig.stages.find((s) => s.isActive && !s.isSeparated);
    if (activeStage && activeStage.isThrusting && activeStage.fuelMass > 0) {
      const flameHeight =
        ROCKET_FLAME_HEIGHT_MIN +
        ((ROCKET_FLAME_HEIGHT_MAX - ROCKET_FLAME_HEIGHT_MIN) *
          (activeStage.thrustPercentage / 100));

      const flameBaseY = screenY;

      ctx.fillStyle = COLORS.flame;
      ctx.beginPath();
      ctx.moveTo(screenX, flameBaseY);
      ctx.lineTo(screenX - ROCKET_BODY_WIDTH / 1.5, flameBaseY + flameHeight);
      ctx.lineTo(screenX + ROCKET_BODY_WIDTH / 1.5, flameBaseY + flameHeight);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "rgba(255, 200, 0, 0.7)";
      ctx.beginPath();
      ctx.moveTo(screenX, flameBaseY);
      ctx.lineTo(screenX - ROCKET_BODY_WIDTH / 2.5, flameBaseY + flameHeight * 0.6);
      ctx.lineTo(screenX + ROCKET_BODY_WIDTH / 2.5, flameBaseY + flameHeight * 0.6);
      ctx.closePath();
      ctx.fill();
    }

    // Parachute
    if (finalStageParachute.isDeployed && finalStageParachute.deploymentProgress > 0) {
      const parachuteRadius = 20 * finalStageParachute.deploymentProgress;
      const parachuteY = currentScreenY - 40 - parachuteRadius;

      ctx.fillStyle = "rgba(255, 100, 100, 0.6)";
      ctx.beginPath();
      ctx.arc(screenX, parachuteY, parachuteRadius, Math.PI, 0);
      ctx.fill();

      ctx.strokeStyle = "rgba(255, 100, 100, 1)";
      ctx.lineWidth = 1;
      ctx.stroke();

      for (let line = 0; line < 4; line++) {
        const angle = (Math.PI / 3) + (line * Math.PI / 6);
        const attachX = screenX + parachuteRadius * Math.cos(angle);
        const attachY = parachuteY + parachuteRadius * Math.sin(angle);

        ctx.strokeStyle = "rgba(255, 100, 100, 0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(attachX, attachY);
        ctx.lineTo(screenX, currentScreenY);
        ctx.stroke();
      }
    }

    // Landing gear
    if (flightState.position.y <= 1) {
      let gearColor = "#00ff00";
      if (landingGear.damageState > 0.5) {
        gearColor = "#ffff00";
      }
      if (landingGear.isBroken) {
        gearColor = "#ff0000";
      }

      ctx.strokeStyle = gearColor;
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.moveTo(screenX - ROCKET_BODY_WIDTH / 2, screenY);
      ctx.lineTo(screenX - ROCKET_BODY_WIDTH - 10, screenY + 15);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(screenX + ROCKET_BODY_WIDTH / 2, screenY);
      ctx.lineTo(screenX + ROCKET_BODY_WIDTH + 10, screenY + 15);
      ctx.stroke();
    }
  };

  /**
   * Draw telemetry panel
   */
  const drawInfoPanel = (ctx: CanvasRenderingContext2D, state: MultiStageRocketState) => {
    const panelX = CANVAS_WIDTH - INFO_PANEL_WIDTH - INFO_PANEL_MARGIN;
    const panelY = CANVAS_HEIGHT - INFO_PANEL_HEIGHT - INFO_PANEL_MARGIN;

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(panelX, panelY, INFO_PANEL_WIDTH, INFO_PANEL_HEIGHT);

    ctx.strokeStyle = COLORS.ui;
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX, panelY, INFO_PANEL_WIDTH, INFO_PANEL_HEIGHT);

    ctx.fillStyle = COLORS.text;
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;

    const drawLine = (text: string, yOffset: number) => {
      ctx.fillText(text, panelX + 10, panelY + 25 + yOffset);
    };

    let lineOffset = 0;
    const lineHeight = 20;

    ctx.font = `bold ${FONT_SIZE_MEDIUM}px monospace`;
    drawLine("TELEMETRY", lineOffset);
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;
    lineOffset += lineHeight + 5;

    ctx.strokeStyle = COLORS.ui;
    ctx.beginPath();
    ctx.moveTo(panelX + 10, panelY + 35);
    ctx.lineTo(panelX + INFO_PANEL_WIDTH - 10, panelY + 35);
    ctx.stroke();
    lineOffset += 10;

    const altitudeDisplay =
      state.maxAltitudeReached > 100000
        ? (state.maxAltitudeReached / 1000).toFixed(0) + " km"
        : state.maxAltitudeReached.toFixed(0) + " m";
    drawLine(`ALT: ${altitudeDisplay}`, lineOffset);
    lineOffset += lineHeight;

    const currentAlt =
      state.position.y > 100000
        ? (state.position.y / 1000).toFixed(1) + " km"
        : state.position.y.toFixed(1) + " m";
    drawLine(`CUR: ${currentAlt}`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`VEL: ${state.velocity.y.toFixed(1)} m/s`, lineOffset);
    lineOffset += lineHeight;

    let totalFuel = 0;
    let totalCapacity = 0;
    for (const stage of rocketConfig.stages) {
      if (!stage.isSeparated) {
        totalFuel += stage.fuelMass;
        totalCapacity += stage.fuelCapacity;
      }
    }
    const totalFuelPercent = totalCapacity > 0 ? (totalFuel / totalCapacity) * 100 : 0;
    drawLine(`FUEL: ${totalFuelPercent.toFixed(0)}%`, lineOffset);
    lineOffset += lineHeight;

    const activeStage = rocketConfig.stages.find((s) => s.isActive && !s.isSeparated);
    const throttleDisplay = activeStage ? activeStage.thrustPercentage.toFixed(0) : "0";
    drawLine(`THR: ${throttleDisplay}%`, lineOffset);
    lineOffset += lineHeight;

    const minutes = Math.floor(state.timeElapsed / 60);
    const seconds = (state.timeElapsed % 60).toFixed(1);
    drawLine(`TIME: ${minutes}:${seconds}`, lineOffset);
    lineOffset += lineHeight;

    let status = "STANDBY";
    if (state.isFlying) status = "FLYING";
    if (state.hasLanded) status = "LANDED";
    drawLine(`STATUS: ${status}`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`STAGE: ${state.activeStageNumber + 1}/${rocketConfig.stages.length}`, lineOffset);
    lineOffset += lineHeight;

    if (state.stageSeparationCount > 0) {
      drawLine(`SEPARATED: ${state.stageSeparationCount}`, lineOffset);
    }
  };

  /**
   * Draw performance stats
   */
  const drawPerformanceStats = (ctx: CanvasRenderingContext2D, metrics: PerformanceMetrics) => {
    const panelX = 10;
    const panelY = 10;
    const panelWidth = 280;
    const panelHeight = 200;

    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.fillRect(panelX, panelY, panelWidth, panelHeight);

    const perfStatus = getPerformanceStatus(metrics);
    ctx.strokeStyle = perfStatus.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

    ctx.fillStyle = perfStatus.color;
    ctx.font = `bold ${FONT_SIZE_SMALL}px monospace`;

    const drawLine = (text: string, yOffset: number) => {
      ctx.fillText(text, panelX + 10, panelY + 20 + yOffset);
    };

    let lineOffset = 0;
    const lineHeight = 18;

    drawLine(`${perfStatus.emoji} ${perfStatus.status}`, lineOffset);
    lineOffset += lineHeight + 3;

    ctx.fillStyle = COLORS.text;
    ctx.font = `${FONT_SIZE_SMALL}px monospace`;

    drawLine(`FPS: ${metrics.framesPerSecond.toFixed(0)}`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`Frame: ${metrics.frameTime.toFixed(1)}ms`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`Physics: ${metrics.physicsTime.toFixed(1)}ms`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`Render: ${metrics.renderTime.toFixed(1)}ms`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`Particles: ${metrics.particleCount}/${metrics.maxParticles}`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`Trajectory: ${metrics.trajectoryPointCount}`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`Memory: ${metrics.trajectoryMemoryMB.toFixed(1)}MB`, lineOffset);
    lineOffset += lineHeight;

    drawLine(`Health: ${metrics.healthScore.toFixed(0)}/100`, lineOffset);

    if (metrics.warnings.length > 0) {
      lineOffset += lineHeight + 2;
      ctx.fillStyle = "#ffff00";
      ctx.font = `${FONT_SIZE_SMALL - 2}px monospace`;
      for (let i = 0; i < Math.min(2, metrics.warnings.length); i++) {
        drawLine(metrics.warnings[i].substring(0, 25), lineOffset);
        lineOffset += lineHeight - 3;
      }
    }
  };

  // === GAME LOOP ===

  /**
   * Main game loop with audio integration
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let lastFrameTime = Date.now();

    const gameLoop = () => {
      // Start timing
      performanceMonitorRef.current.startFrame();

      const now = Date.now();
      const deltaTime = Math.min((now - lastFrameTime) / 1000, 0.1);
      lastFrameTime = now;

      // === APPLY CONTROLS ===
      const isSpacebarPressed = keysPressed.current[" "];
      const isClickActive = keysPressed.current["mouseClick"] || false;

      applyControls(rocketConfig, isSpacebarPressed, isClickActive);
      keysPressed.current["mouseClick"] = false;

      // === PHYSICS UPDATE ===
      performanceMonitorRef.current.startPhysicsTimer();

      const physicsFrame = updatePhysics(flightState, rocketConfig, {
        gravity: GRAVITY,
        windSpeed: WIND_SPEED,
        dragCoefficient: DRAG_COEFFICIENT,
        rocketRadius: ROCKET_RADIUS,
        timeStep: PHYSICS_TICK_RATE,
      }, deltaTime);

      performanceMonitorRef.current.endPhysicsTimer();

      // === AUDIO: ENGINE SOUND ===
      // Play/update engine thrust sound based on throttle
      const activeStage = rocketConfig.stages.find((s) => s.isActive && !s.isSeparated);
      const currentThrottle = activeStage ? activeStage.thrustPercentage : 0;

      // Throttle up sound
      if (currentThrottle > previousThrottleRef.current && currentThrottle > 0 && previousThrottleRef.current === 0) {
        audioManagerRef.current.playSound("engine-ignition");
      }

      // Throttle increase sound
      if (currentThrottle > previousThrottleRef.current + 10) {
        audioManagerRef.current.playSound("thrust-increase");
      }

      // Throttle decrease sound
      if (currentThrottle < previousThrottleRef.current - 10) {
        audioManagerRef.current.playSound("thrust-decrease");
      }

      // Continuous engine sound
      if (currentThrottle > 0 && flightState.isFlying) {
        if (!engineSoundPlayingRef.current) {
          audioManagerRef.current.playSound("engine-thrust", {
            loop: true,
            pitch: 0.8 + (currentThrottle / 100) * 0.4, // Pitch varies with throttle
          });
          engineSoundPlayingRef.current = true;
        }
      } else {
        if (engineSoundPlayingRef.current) {
          audioManagerRef.current.stopSound("engine-thrust");
          engineSoundPlayingRef.current = false;
        }
      }

      previousThrottleRef.current = currentThrottle;

      // === PARACHUTE DEPLOYMENT ===
      if (
        flightState.isFlying &&
        !parachuteDeployedRef.current &&
        physicsFrame.state.velocity.y < -5 &&
        physicsFrame.state.position.y > finalStageParachute.minAltitudeForDeployment
      ) {
        deployParachute(finalStageParachute);
        parachuteDeployedRef.current = true;
        audioManagerRef.current.playSound("parachute-deploy");
      }

      const parachtuteDragForce = updateParachute(finalStageParachute, deltaTime);

      if (parachtuteDragForce > 0) {
        const totalMass = flightState.maxAltitudeReached > 0 ? 1000 : 1;
        const parachtuteDragAcceleration = parachtuteDragForce / totalMass;
        physicsFrame.state.acceleration.y += parachtuteDragAcceleration;
      }

      // === STAGE SEPARATION ===
      if (physicsFrame.state.didStageSeperateThisFrame) {
        particleSystemRef.current.createBurst(
          physicsFrame.state.position.x,
          physicsFrame.state.position.y,
          20,
          "rgba(255, 200, 100, 1)",
          40
        );
        audioManagerRef.current.playSound("stage-separation");
      }

      // === EXHAUST TRAIL ===
      if (activeStage && activeStage.isThrusting && activeStage.fuelMass > 0) {
        particleSystemRef.current.createExhaustTrail(
          physicsFrame.state.position.x,
          physicsFrame.state.position.y,
          physicsFrame.state.velocity.x,
          physicsFrame.state.velocity.y,
          activeStage.thrustPercentage
        );
      }

      particleSystemRef.current.update(deltaTime);
      setParticleCount(particleSystemRef.current.getParticleCount());

      // === LANDING ===
      if (physicsFrame.groundImpact && !landingState.hasTouchedDown) {
        const updatedLandingState = processLanding(
          landingState,
          physicsFrame.state.landingVelocity,
          1000,
          landingGear,
          finalStageParachute.hasBeenUsed ? 1 : 0
        );

        setLandingState(updatedLandingState);

        const score = calculateLandingScore(physicsFrame.state.landingVelocity);
        setLandingScore(score);

        // Play landing sound based on impact
        if (score > 50) {
          particleSystemRef.current.createBurst(
            physicsFrame.state.position.x,
            0,
            5,
            "rgba(200, 200, 200, 1)",
            10
          );
          audioManagerRef.current.playSound("landing-soft");
        } else {
          particleSystemRef.current.createBurst(
            physicsFrame.state.position.x,
            0,
            15,
            "rgba(255, 100, 0, 1)",
            30
          );
          audioManagerRef.current.playSound("landing-hard");
        }

        audioManagerRef.current.stopSound("engine-thrust");
        engineSoundPlayingRef.current = false;
      }

      // === TRAJECTORY ===
      const newPoint = { x: physicsFrame.state.position.x, y: physicsFrame.state.position.y };

      setTrajectoryHistory((prev) => {
        const updated = [...prev, newPoint];
        return trajectoryLimiterRef.current.limitTrajectory(updated);
      });

      setFlightState({ ...physicsFrame.state });

      // === RENDERING ===
      performanceMonitorRef.current.startRenderTimer();

      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      particleSystemRef.current.draw(
        ctx,
        PIXELS_PER_METER,
        CANVAS_WIDTH,
        CANVAS_HEIGHT
      );

      drawGround(ctx);
      drawRocket(ctx, flightState);
      drawInfoPanel(ctx, flightState);

      // Goal indicator
      if (selectedGoal || customGoalAltitude) {
        const goalAlt = customGoalAltitude || selectedGoal?.altitude || 0;
        const goalScreenY = CANVAS_HEIGHT - 20 - (goalAlt * PIXELS_PER_METER);

        if (goalScreenY > 0 && goalScreenY < CANVAS_HEIGHT) {
          ctx.strokeStyle = COLORS.trajectory;
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(0, goalScreenY);
          ctx.lineTo(CANVAS_WIDTH, goalScreenY);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = COLORS.trajectory;
          ctx.font = `${FONT_SIZE_SMALL}px monospace`;
          ctx.fillText(
            `Goal: ${(selectedGoal?.name || "Custom")} (${(goalAlt / 1000).toFixed(0)}km)`,
            10,
            goalScreenY - 5
          );
        }
      }

      performanceMonitorRef.current.endRenderTimer();

      performanceMonitorRef.current.setParticleCount(particleSystemRef.current.getParticleCount());
      performanceMonitorRef.current.setTrajectoryPointCount(trajectoryHistory.length);
      performanceMonitorRef.current.endFrame();

      setPerformanceMetrics(performanceMonitorRef.current.getMetrics());

      if (showPerformanceStats) {
        drawPerformanceStats(ctx, performanceMonitorRef.current.getMetrics());
      }

      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };

    animationFrameRef.current = requestAnimationFrame(gameLoop);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [flightState, rocketConfig, selectedGoal, customGoalAltitude, landingScore, landingState, showPerformanceStats]);

  // === EVENT LISTENERS ===

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // === RENDER ===

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        backgroundColor: COLORS.background,
        fontFamily: "monospace",
        color: COLORS.text,
      }}
    >
      {showFullscreenTrajectory && (
        <TrajectoryPanel
          rocketState={flightState as any}
          trajectoryHistory={trajectoryHistory}
          isFullscreen={true}
          onCloseFullscreen={() => setShowFullscreenTrajectory(false)}
        />
      )}

      {!showFullscreenTrajectory && (
        <>
          <h1 style={{ marginBottom: "20px" }}>🚀 Multi-Stage Rocket Simulator</h1>

          <div style={{ position: "relative" }}>
            <canvas
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              onClick={handleCanvasClick}
              style={{
                border: `2px solid ${COLORS.ui}`,
                cursor: "pointer",
                marginBottom: "20px",
                backgroundColor: COLORS.background,
              }}
            />

            <div style={{ position: "absolute", bottom: "20px", left: "20px" }}>
              <TrajectoryPanel
                rocketState={flightState as any}
                trajectoryHistory={trajectoryHistory}
                isFullscreen={false}
                onCloseFullscreen={() => {}}
              />
              <button
                onClick={() => setShowFullscreenTrajectory(true)}
                style={{
                  position: "absolute",
                  bottom: "10px",
                  right: "10px",
                  padding: "4px 8px",
                  fontSize: "12px",
                  backgroundColor: COLORS.ui,
                  color: COLORS.text,
                  border: `1px solid ${COLORS.text}`,
                  cursor: "pointer",
                  borderRadius: "3px",
                }}
                title="Expand to fullscreen"
              >
                ⛶
              </button>
            </div>
          </div>

          <div style={{ marginBottom: "15px", textAlign: "center" }}>
            <p>SPACEBAR: Hold for thrust | CLICK: Burst | P: Perf | M: Mute | ESC: Close fullscreen</p>
          </div>

          <div
            style={{
              display: "flex",
              gap: "20px",
              marginBottom: "20px",
              flexWrap: "wrap",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <div>
              <label style={{ marginRight: "10px" }}>Rocket: </label>
              <select
                value={rocketConfig.name}
                onChange={handleRocketChange}
                style={{
                  padding: "8px",
                  backgroundColor: COLORS.ui,
                  color: COLORS.text,
                  border: `1px solid ${COLORS.text}`,
                  cursor: "pointer",
                }}
              >
                <option value="Simple Two-Stage">Simple Two-Stage</option>
                <option value="Falcon 9 Inspired">Falcon 9 Inspired</option>
                <option value="Three-Stage Heavy">Three-Stage Heavy</option>
              </select>
            </div>

            <div>
              <label style={{ marginRight: "10px" }}>Goal: </label>
              <select
                value={selectedGoal?.name || "custom"}
                onChange={handleGoalChange}
                style={{
                  padding: "8px",
                  backgroundColor: COLORS.ui,
                  color: COLORS.text,
                  border: `1px solid ${COLORS.text}`,
                  cursor: "pointer",
                }}
              >
                {ALTITUDE_GOALS.map((goal) => (
                  <option key={goal.name} value={goal.name}>
                    {goal.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ marginRight: "10px" }}>Custom (m): </label>
              <input
                type="number"
                value={customGoalAltitude || ""}
                onChange={handleCustomGoal}
                placeholder="Enter altitude"
                style={{
                  padding: "8px",
                  backgroundColor: COLORS.ui,
                  color: COLORS.text,
                  border: `1px solid ${COLORS.text}`,
                }}
              />
            </div>

            <button
              onClick={handleReset}
              style={{
                padding: "8px 15px",
                backgroundColor: COLORS.ui,
                color: COLORS.text,
                border: `1px solid ${COLORS.text}`,
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              Reset
            </button>

            {/* === NEW: AUDIO CONTROLS === */}
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <button
                onClick={() => {
                  const newMuted = audioManagerRef.current.toggleMute();
                  setAudioMuted(newMuted);
                }}
                style={{
                  padding: "8px 12px",
                  backgroundColor: audioMuted ? "#ff4444" : COLORS.ui,
                  color: COLORS.text,
                  border: `1px solid ${COLORS.text}`,
                  cursor: "pointer",
                  fontSize: "14px",
                }}
                title="Toggle mute (M key)"
              >
                {audioMuted ? "🔇 MUTED" : "🔊 AUDIO"}
              </button>

              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={masterVolume}
                onChange={handleVolumeChange}
                style={{ width: "100px", cursor: "pointer" }}
                title="Master volume"
              />
              <span style={{ fontSize: "12px" }}>{Math.round(masterVolume * 100)}%</span>
            </div>
          </div>

          {landingScore !== null && (
            <div
              style={{
                padding: "15px",
                backgroundColor: "rgba(74, 111, 165, 0.3)",
                border: `2px solid ${COLORS.ui}`,
                marginBottom: "20px",
                textAlign: "center",
              }}
            >
              <p>
                Landing Score: <strong>{landingScore.toFixed(0)}/100</strong>
              </p>
              <p>
                Landing Quality: <strong>{landingState.landingQuality}</strong>
              </p>
              <p>
                Structural Damage: {landingState.structuralDamage.toFixed(1)}%
              </p>
              <p>
                Reusable: {landingState.isReusable ? "✓ YES" : "✗ NO"}
              </p>
              <p>
                Max Altitude:{" "}
                {(flightState.maxAltitudeReached / 1000).toFixed(2)} km
              </p>
              <p>
                Landing Velocity:{" "}
                {Math.abs(flightState.landingVelocity).toFixed(2)} m/s
              </p>
              <p>
                Stages Separated: {flightState.stageSeparationCount}
              </p>
              <p>
                Parachutes Deployed: {landingState.parachutesDeployed}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
};