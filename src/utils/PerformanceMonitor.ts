/**
 * ROCKET SIMULATOR - PERFORMANCE MONITOR
 * ======================================
 * System for tracking and monitoring performance metrics of the simulator.
 * 
 * Tracks:
 * - Frames per second (FPS)
 * - Frame render time (milliseconds per frame)
 * - Physics update time
 * - Particle count and particle system performance
 * - Trajectory history size
 * - Memory usage estimates
 * - Performance warnings when thresholds are exceeded
 * 
 * This helps identify bottlenecks and ensures the simulator runs smoothly
 * even on lower-end devices or with many particles/trajectory points.
 */

/**
 * Performance metrics collected each frame
 * Used to track how well the simulator is performing
 */
export interface PerformanceMetrics {
  // === FRAME TIMING ===
  // Frames rendered per second (target: 60 FPS)
  framesPerSecond: number;

  // Time taken to render one frame (milliseconds)
  // Lower is better (60 FPS = ~16.67ms per frame)
  frameTime: number;

  // Time spent on physics calculations (milliseconds)
  physicsTime: number;

  // Time spent on rendering (milliseconds)
  renderTime: number;

  // === PARTICLE SYSTEM ===
  // Total number of active particles in the world
  particleCount: number;

  // Maximum particles allowed (safety cap to prevent lag)
  maxParticles: number;

  // === MEMORY USAGE ===
  // Number of trajectory points stored
  trajectoryPointCount: number;

  // Estimated memory used by trajectory (rough estimate in MB)
  trajectoryMemoryMB: number;

  // === WARNINGS ===
  // Array of performance warnings for the current frame
  // Examples: "FPS dropping below 30", "High particle count"
  warnings: string[];

  // === PERFORMANCE RATING ===
  // Overall health score (0-100, 100 = perfect)
  healthScore: number;

  // === STATUS ===
  // Is performance acceptable? (FPS >= 30 and no critical warnings)
  isHealthy: boolean;
}

/**
 * Trajectory point limiter configuration
 * Controls how many trajectory points to keep to prevent memory bloat
 */
export interface TrajectoryLimiterConfig {
  // Maximum number of trajectory points to keep
  // Older points are discarded when limit is reached
  maxPoints: number;

  // Sample rate: keep every Nth point (1 = keep all, 2 = keep every other)
  // Higher values reduce memory but lose some trajectory detail
  sampleRate: number;

  // Time interval (seconds) to auto-cleanup old points
  cleanupInterval: number;
}

/**
 * Performance Monitor class
 * Tracks FPS, frame times, particle counts, and memory usage
 * Provides warnings when performance degrades
 */
export class PerformanceMonitor {
  // Frame timing tracking
  private frameCount: number = 0;
  private lastSecondTime: number = Date.now();
  private currentFPS: number = 60;

  // Frame time history (for calculating average)
  private frameTimeHistory: number[] = [];
  private maxHistoryLength: number = 60; // Track last 60 frames

  // Physics and render time tracking
  private physicsTimeHistory: number[] = [];
  private renderTimeHistory: number[] = [];

  // Current frame measurements
  private currentPhysicsTime: number = 0;
  private currentRenderTime: number = 0;

  // Particle and memory tracking
  private particleCount: number = 0;
  private maxParticles: number = 5000; // Safety cap

  // Trajectory tracking
  private trajectoryPointCount: number = 0;

  // Performance thresholds (when to warn)
  private fpsWarningThreshold: number = 30; // Warn if FPS drops below 30
  private frameTimeWarningThreshold: number = 33; // Warn if frame > 33ms (30 FPS)
  private particleWarningThreshold: number = 3000; // Warn at 3k particles
  private trajectoryWarningThreshold: number = 50000; // Warn at 50k points

  /**
   * Start measuring a frame
   * Call this at the beginning of your game loop
   */
  public startFrame(): void {
    // Record start time for measuring total frame time
    this.frameStartTime = performance.now();
  }

  private frameStartTime: number = 0;

  /**
   * Start measuring physics time
   * Call this before physics calculations
   */
  public startPhysicsTimer(): void {
    this.physicsStartTime = performance.now();
  }

  private physicsStartTime: number = 0;

  /**
   * End physics timing and record the time taken
   * Call this after physics calculations complete
   */
  public endPhysicsTimer(): void {
    // Calculate time spent on physics (in milliseconds)
    this.currentPhysicsTime = performance.now() - this.physicsStartTime;

    // Add to history for averaging
    this.physicsTimeHistory.push(this.currentPhysicsTime);
    if (this.physicsTimeHistory.length > this.maxHistoryLength) {
      this.physicsTimeHistory.shift(); // Remove oldest entry
    }
  }

  /**
   * Start measuring render time
   * Call this before rendering/drawing
   */
  public startRenderTimer(): void {
    this.renderStartTime = performance.now();
  }

  private renderStartTime: number = 0;

  /**
   * End render timing and record the time taken
   * Call this after all rendering is complete
   */
  public endRenderTimer(): void {
    // Calculate time spent on rendering (in milliseconds)
    this.currentRenderTime = performance.now() - this.renderStartTime;

    // Add to history for averaging
    this.renderTimeHistory.push(this.currentRenderTime);
    if (this.renderTimeHistory.length > this.maxHistoryLength) {
      this.renderTimeHistory.shift(); // Remove oldest entry
    }
  }

  /**
   * End frame measurement and update FPS counter
   * Call this at the end of your game loop
   */
  public endFrame(): void {
    // Calculate total frame time (in milliseconds)
    const frameTime = performance.now() - this.frameStartTime;

    // Add to frame time history
    this.frameTimeHistory.push(frameTime);
    if (this.frameTimeHistory.length > this.maxHistoryLength) {
      this.frameTimeHistory.shift(); // Remove oldest entry
    }

    // Increment frame counter
    this.frameCount++;

    // Check if one second has passed
    // Update FPS every second (more stable than every frame)
    const now = Date.now();
    if (now - this.lastSecondTime >= 1000) {
      // Calculate FPS based on frames rendered in the last second
      this.currentFPS = this.frameCount;

      // Reset for next second
      this.frameCount = 0;
      this.lastSecondTime = now;
    }
  }

  /**
   * Update particle count
   * Call this whenever particle count changes
   */
  public setParticleCount(count: number): void {
    this.particleCount = count;
  }

  /**
   * Update trajectory point count
   * Call this whenever trajectory size changes
   */
  public setTrajectoryPointCount(count: number): void {
    this.trajectoryPointCount = count;
  }

  /**
   * Get current performance metrics
   * Returns all tracked performance data
   */
  public getMetrics(): PerformanceMetrics {
    // Calculate averages from history
    const avgFrameTime =
      this.frameTimeHistory.length > 0
        ? this.frameTimeHistory.reduce((a, b) => a + b, 0) / this.frameTimeHistory.length
        : 0;

    const avgPhysicsTime =
      this.physicsTimeHistory.length > 0
        ? this.physicsTimeHistory.reduce((a, b) => a + b, 0) / this.physicsTimeHistory.length
        : 0;

    const avgRenderTime =
      this.renderTimeHistory.length > 0
        ? this.renderTimeHistory.reduce((a, b) => a + b, 0) / this.renderTimeHistory.length
        : 0;

    // === GENERATE WARNINGS ===
    const warnings: string[] = [];

    // FPS warning
    if (this.currentFPS < this.fpsWarningThreshold) {
      warnings.push(`⚠️ Low FPS: ${this.currentFPS} (target: 60)`);
    }

    // Frame time warning
    if (avgFrameTime > this.frameTimeWarningThreshold) {
      warnings.push(`⚠️ Slow frames: ${avgFrameTime.toFixed(1)}ms (target: 16.7ms)`);
    }

    // Particle warning
    if (this.particleCount > this.particleWarningThreshold) {
      warnings.push(`⚠️ High particle count: ${this.particleCount} (recommended: < 3000)`);
    }

    // Trajectory warning
    if (this.trajectoryPointCount > this.trajectoryWarningThreshold) {
      warnings.push(`⚠️ Large trajectory: ${this.trajectoryPointCount} points (recommended: < 50000)`);
    }

    // === CALCULATE HEALTH SCORE ===
    // Health score 0-100, based on multiple factors
    let healthScore = 100;

    // Deduct points for low FPS (max -40 points)
    healthScore -= Math.max(0, 40 * (1 - this.currentFPS / 60));

    // Deduct points for high frame time (max -20 points)
    healthScore -= Math.max(0, 20 * (avgFrameTime / this.frameTimeWarningThreshold));

    // Deduct points for high particle count (max -20 points)
    healthScore -= Math.max(0, 20 * (this.particleCount / this.particleWarningThreshold));

    // Deduct points for large trajectory (max -20 points)
    healthScore -= Math.max(0, 20 * (this.trajectoryPointCount / this.trajectoryWarningThreshold));

    // Clamp to 0-100 range
    healthScore = Math.max(0, Math.min(100, healthScore));

    // Estimate memory used by trajectory points
    // Rough estimate: each point is ~32 bytes (x: number, y: number)
    const trajectoryMemoryBytes = this.trajectoryPointCount * 32;
    const trajectoryMemoryMB = trajectoryMemoryBytes / (1024 * 1024);

    // === DETERMINE HEALTH STATUS ===
    // System is healthy if FPS >= 30 and no critical warnings
    const isHealthy = this.currentFPS >= 30 && warnings.length === 0;

    return {
      framesPerSecond: this.currentFPS,
      frameTime: avgFrameTime,
      physicsTime: avgPhysicsTime,
      renderTime: avgRenderTime,
      particleCount: this.particleCount,
      maxParticles: this.maxParticles,
      trajectoryPointCount: this.trajectoryPointCount,
      trajectoryMemoryMB,
      warnings,
      healthScore,
      isHealthy,
    };
  }

  /**
   * Reset all metrics to starting state
   * Call this when starting a new flight
   */
  public reset(): void {
    this.frameCount = 0;
    this.currentFPS = 60;
    this.frameTimeHistory = [];
    this.physicsTimeHistory = [];
    this.renderTimeHistory = [];
    this.currentPhysicsTime = 0;
    this.currentRenderTime = 0;
    this.particleCount = 0;
    this.trajectoryPointCount = 0;
  }
}

/**
 * Trajectory Point Limiter
 * Manages trajectory point history to prevent memory bloat
 * Automatically removes old or excess points
 */
export class TrajectoryLimiter {
  // Current configuration
  private config: TrajectoryLimiterConfig;

  // Last cleanup time (to cleanup on interval)
  private lastCleanupTime: number = Date.now();

  /**
   * Create a trajectory limiter with configuration
   */
  constructor(config: TrajectoryLimiterConfig) {
    this.config = config;
  }

  /**
   * Filter trajectory history to keep under limit
   * Removes oldest points when limit exceeded
   */
  public limitTrajectory(
    trajectory: Array<{ x: number; y: number }>
  ): Array<{ x: number; y: number }> {
    // If under limit, return as-is
    if (trajectory.length <= this.config.maxPoints) {
      return trajectory;
    }

    // Calculate how many points to remove
    // Remove oldest points to get back under limit
    const excessPoints = trajectory.length - this.config.maxPoints;
    return trajectory.slice(excessPoints);
  }

  /**
   * Sample trajectory to reduce size
   * Keeps every Nth point based on sample rate
   */
  public sampleTrajectory(
    trajectory: Array<{ x: number; y: number }>
  ): Array<{ x: number; y: number }> {
    if (this.config.sampleRate <= 1) {
      return trajectory; // No sampling needed
    }

    // Keep every Nth point
    const sampled: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < trajectory.length; i += this.config.sampleRate) {
      sampled.push(trajectory[i]);
    }

    return sampled;
  }

  /**
   * Optimize trajectory by both limiting and sampling
   * Aggressive optimization for very large trajectories
   */
  public optimizeTrajectory(
    trajectory: Array<{ x: number; y: number }>
  ): Array<{ x: number; y: number }> {
    // First limit to max points
    let optimized = this.limitTrajectory(trajectory);

    // Then sample if still large
    optimized = this.sampleTrajectory(optimized);

    return optimized;
  }

  /**
   * Check if cleanup is needed based on time interval
   */
  public shouldCleanup(): boolean {
    const now = Date.now();
    return now - this.lastCleanupTime >= this.config.cleanupInterval * 1000;
  }

  /**
   * Mark cleanup as done
   */
  public markCleanup(): void {
    this.lastCleanupTime = Date.now();
  }

  /**
   * Update configuration
   */
  public setConfig(config: Partial<TrajectoryLimiterConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Get human-readable performance status
 * Used for UI display
 */
export function getPerformanceStatus(metrics: PerformanceMetrics): {
  status: "EXCELLENT" | "GOOD" | "ACCEPTABLE" | "POOR" | "CRITICAL";
  color: string;
  emoji: string;
} {
  // Determine status based on health score and warnings
  if (metrics.healthScore >= 90 && metrics.warnings.length === 0) {
    return {
      status: "EXCELLENT",
      color: "#00ff00", // Green
      emoji: "🟢",
    };
  }

  if (metrics.healthScore >= 70 && metrics.warnings.length <= 1) {
    return {
      status: "GOOD",
      color: "#00dd00", // Light green
      emoji: "🟢",
    };
  }

  if (metrics.healthScore >= 50 && metrics.warnings.length <= 2) {
    return {
      status: "ACCEPTABLE",
      color: "#ffff00", // Yellow
      emoji: "🟡",
    };
  }

  if (metrics.healthScore >= 20 || metrics.warnings.length <= 3) {
    return {
      status: "POOR",
      color: "#ff8800", // Orange
      emoji: "🟠",
    };
  }

  return {
    status: "CRITICAL",
    color: "#ff0000", // Red
    emoji: "🔴",
  };
}