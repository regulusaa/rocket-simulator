/**
 * ROCKET SIMULATOR — PERFORMANCE MONITOR
 * =======================================
 * Tracks how fast the simulator is running and warns when it's struggling.
 *
 * WHY PERFORMANCE MONITORING MATTERS:
 *   A game loop runs at 60 FPS (frames per second). Each frame must complete
 *   in under 16.67ms (1000ms / 60 = 16.67ms per frame budget).
 *
 *   If one frame takes 50ms, the browser can't render the next frame on time —
 *   the user sees "stuttering" or "lag". If FPS drops below 30, gameplay
 *   feels unresponsive. The PerformanceMonitor catches this early so you can
 *   reduce particle counts, skip calculations, or warn the user.
 *
 * WHAT WE TRACK:
 *   - FPS (frames per second): How many frames rendered in the last second.
 *   - Frame time: How long each frame takes in milliseconds.
 *   - Physics time: How long the physics engine takes per frame.
 *   - Render time: How long the canvas drawing takes per frame.
 *   - Particle count: More particles = more work per frame.
 *   - Trajectory size: Trajectory history grows forever without limits.
 *   - Health score: A 0-100 summary of how well everything is running.
 *
 * performance.now() vs Date.now():
 *   - Date.now() returns milliseconds since Unix epoch (e.g., 1718000000123).
 *     Resolution: ~1ms. Good enough for "was that a second ago?"
 *   - performance.now() returns milliseconds since page load (e.g., 1234.567).
 *     Resolution: up to 0.001ms (microseconds). Essential for frame timing.
 *   We use performance.now() for sub-millisecond frame measurements and
 *   Date.now() for the "has one second passed?" FPS counter.
 */

/**
 * Snapshot of all performance metrics collected each frame.
 *
 * These are plain data values — the PerformanceMonitor class fills them in
 * and the UI reads them for the debug overlay (press P to toggle it).
 */
export interface PerformanceMetrics {
  // === FRAME TIMING ===

  /**
   * How many complete frames were rendered in the last full second.
   * Target: 60 FPS (tied to monitor refresh rate via requestAnimationFrame).
   * 30 FPS is the minimum for playable gameplay.
   * Below 15 FPS the simulation starts to feel like a slideshow.
   */
  framesPerSecond: number;

  /**
   * Rolling average time (milliseconds) to complete one full frame.
   * This covers physics + rendering + all other work in the game loop.
   * Target: ≤16.67ms (at 60 FPS).
   * Warning threshold: >33ms (below 30 FPS equivalent).
   *
   * We average the last 60 frames instead of reporting the instantaneous value
   * because a single slow frame (e.g., garbage collection paused for 5ms)
   * would look alarming even if every other frame is fine.
   */
  frameTime: number;

  /**
   * Rolling average time (ms) spent in physics calculations per frame.
   * Physics includes: force integration, collision checks, particle updates,
   * atmospheric model queries, and stage separation logic.
   * If physicsTime > 10ms, you're using >60% of your frame budget on physics alone.
   */
  physicsTime: number;

  /**
   * Rolling average time (ms) spent in canvas rendering per frame.
   * Rendering includes: clear canvas, draw background, draw rocket, draw HUD,
   * draw particles, draw trajectory, draw all overlays.
   * If renderTime > 8ms with physicsTime > 8ms, you're over budget.
   */
  renderTime: number;

  // === PARTICLE SYSTEM ===

  /**
   * How many particle objects (exhaust, debris, smoke) are active right now.
   * Each particle needs position update + color interpolation + draw call.
   * 3000+ particles can push frame time over 16ms on mid-range hardware.
   */
  particleCount: number;

  /**
   * The absolute ceiling: no more than this many particles will ever exist.
   * The ParticleSystem enforces this limit by refusing to spawn new particles
   * when the count reaches this cap. Default: 5000.
   */
  maxParticles: number;

  // === MEMORY USAGE ===

  /**
   * How many {x, y} points are in the trajectory history array.
   * The trajectory grows by one point per physics tick (every ~16ms).
   * After 10 minutes of flight at 60 FPS: 60 × 60 × 10 = 36,000 points.
   * After an hour: 216,000 points — ~7MB in a JavaScript array of objects.
   */
  trajectoryPointCount: number;

  /**
   * Rough estimate of how many megabytes the trajectory array is consuming.
   * Formula: pointCount × 32 bytes (two 64-bit floats per {x, y} point) ÷ 1MB.
   * This is an approximation — JavaScript object headers add overhead
   * that varies by engine, but 32 bytes per point is a conservative estimate.
   */
  trajectoryMemoryMB: number;

  // === WARNINGS ===

  /**
   * Human-readable warning strings for the current metrics snapshot.
   * These appear in the debug overlay when thresholds are exceeded.
   * Examples:
   *   "⚠️ Low FPS: 24 (target: 60)"
   *   "⚠️ High particle count: 4200 (recommended: < 3000)"
   */
  warnings: string[];

  // === PERFORMANCE RATING ===

  /**
   * Composite score from 0 to 100. 100 = everything running perfectly.
   * Deductions:
   *   -0 to -40 for low FPS  (proportional: 30 FPS = -20, 0 FPS = -40)
   *   -0 to -20 for slow frames (proportional to threshold)
   *   -0 to -20 for high particle count
   *   -0 to -20 for large trajectory
   * Score is clamped to [0, 100] so it never goes negative.
   */
  healthScore: number;

  /**
   * Quick boolean: is everything OK?
   * true = FPS >= 30 AND no active warnings.
   * false = something needs attention.
   */
  isHealthy: boolean;
}

/**
 * Configuration for the TrajectoryLimiter.
 * These values control how aggressively old trajectory points are pruned.
 */
export interface TrajectoryLimiterConfig {
  /**
   * Hard cap on trajectory points. If the array grows past this, the
   * oldest points are sliced off. Default: ~10,000 points ≈ 160 seconds
   * of flight history at 60 FPS.
   */
  maxPoints: number;

  /**
   * Keep every Nth point. sampleRate=1 keeps every point (no reduction).
   * sampleRate=2 keeps points 0, 2, 4, 6... halving the array size.
   * sampleRate=4 keeps every 4th point — 75% reduction, slight loss of detail.
   * Use higher values for very long flights where micro-movements don't matter.
   */
  sampleRate: number;

  /**
   * How often (in seconds) to check and prune the trajectory automatically.
   * Setting this to 10 means every 10 seconds the limiter runs a cleanup pass.
   * Lower = more CPU for cleanup; higher = trajectory can grow larger between cleans.
   */
  cleanupInterval: number;
}

/**
 * PerformanceMonitor — tracks FPS, frame times, particle count, trajectory size.
 *
 * HOW FPS COUNTING WORKS:
 *   We count how many times endFrame() is called within a 1-second window.
 *   When a full second has passed, we save that count as currentFPS and reset.
 *   This is called a "one-second sliding window counter."
 *
 *   Alternative approach: 1 / frameTime gives instantaneous FPS from a single frame.
 *   But that's noisy — a 10ms frame says "100 FPS" and a 20ms frame says "50 FPS"
 *   even if the average is 60 FPS. Counting over a full second is far more stable.
 *
 * HOW ROLLING AVERAGES WORK:
 *   We store the last 60 frame times in an array (maxHistoryLength = 60).
 *   Each new measurement pushes onto the end; when the array hits 60, we shift()
 *   the oldest off. Then we sum all 60 and divide by 60 to get the average.
 *   This smooths out single-frame spikes (e.g., from garbage collection)
 *   while still reacting to genuine sustained slowdowns within ~1 second.
 */
export class PerformanceMonitor {
  // === FRAME COUNT AND FPS ===

  // How many frames rendered since the last 1-second mark
  private frameCount: number = 0;

  // Timestamp of the last FPS reset (Date.now() — millisecond precision is fine here)
  private lastSecondTime: number = Date.now();

  // The FPS value shown to the user: updated once per second from frameCount
  private currentFPS: number = 60;

  // === ROLLING HISTORY ARRAYS ===
  // Each holds the last `maxHistoryLength` measurements.
  // push() new value, shift() oldest when full.

  // Total frame times in ms (physics + render + everything)
  private frameTimeHistory: number[] = [];

  // Physics-only times in ms
  private physicsTimeHistory: number[] = [];

  // Render-only times in ms
  private renderTimeHistory: number[] = [];

  // How many frames to average over. 60 = about 1 second of history at 60 FPS
  private maxHistoryLength: number = 60;

  // === CURRENT FRAME IN-PROGRESS VALUES ===
  // These are set by startPhysicsTimer() / endPhysicsTimer() and similar pairs.

  private currentPhysicsTime: number = 0;
  private currentRenderTime: number = 0;

  // === STOPWATCH TIMESTAMPS ===
  // Set at the start of a timed section; subtracted at the end to get duration.
  // Declared after the methods that use them to avoid hoisting confusion,
  // but TypeScript/JavaScript doesn't care about declaration order within a class.

  private frameStartTime: number = 0;
  private physicsStartTime: number = 0;
  private renderStartTime: number = 0;

  // === COUNTERS FOR EXTERNAL SYSTEMS ===

  // Updated by the particle system each frame via setParticleCount()
  private particleCount: number = 0;

  // Safety cap — the particle system enforces this, we just track it
  private maxParticles: number = 5000;

  // Updated by the trajectory history manager each frame
  private trajectoryPointCount: number = 0;

  // === WARNING THRESHOLDS ===
  // If any measured value crosses these, a warning string is generated.

  private fpsWarningThreshold: number = 30;          // Below 30 FPS = warning
  private frameTimeWarningThreshold: number = 33;    // Above 33ms/frame ≈ below 30 FPS
  private particleWarningThreshold: number = 3000;   // Above 3k particles is heavy
  private trajectoryWarningThreshold: number = 50000; // 50k points ≈ 800s at 60fps

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API — called from the game loop in RocketSimulator.tsx
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Call at the VERY BEGINNING of each game loop iteration (before physics).
   * Records the frame start time so endFrame() can compute total duration.
   *
   * Example usage pattern:
   *   perfMonitor.startFrame();           // start stopwatch
   *   perfMonitor.startPhysicsTimer();
   *   updatePhysics(dt);                  // do physics
   *   perfMonitor.endPhysicsTimer();
   *   perfMonitor.startRenderTimer();
   *   drawEverything(ctx);                // do rendering
   *   perfMonitor.endRenderTimer();
   *   perfMonitor.endFrame();             // stop stopwatch, update FPS
   */
  public startFrame(): void {
    this.frameStartTime = performance.now();
  }

  /**
   * Call immediately BEFORE the physics update begins.
   * Starts the physics stopwatch.
   */
  public startPhysicsTimer(): void {
    this.physicsStartTime = performance.now();
  }

  /**
   * Call immediately AFTER physics update completes.
   * Computes elapsed time and adds it to the rolling history.
   */
  public endPhysicsTimer(): void {
    this.currentPhysicsTime = performance.now() - this.physicsStartTime;

    this.physicsTimeHistory.push(this.currentPhysicsTime);
    if (this.physicsTimeHistory.length > this.maxHistoryLength) {
      // Remove the oldest measurement so we keep a fixed-size window
      this.physicsTimeHistory.shift();
    }
  }

  /**
   * Call immediately BEFORE all canvas drawing begins.
   * Starts the render stopwatch.
   */
  public startRenderTimer(): void {
    this.renderStartTime = performance.now();
  }

  /**
   * Call immediately AFTER all canvas drawing completes.
   * Computes elapsed time and adds it to the rolling history.
   */
  public endRenderTimer(): void {
    this.currentRenderTime = performance.now() - this.renderStartTime;

    this.renderTimeHistory.push(this.currentRenderTime);
    if (this.renderTimeHistory.length > this.maxHistoryLength) {
      this.renderTimeHistory.shift();
    }
  }

  /**
   * Call at the VERY END of each game loop iteration.
   * Computes total frame duration and updates the FPS counter once per second.
   *
   * FPS COUNTING MECHANISM:
   *   frameCount is incremented every time endFrame() is called.
   *   Date.now() is checked against lastSecondTime.
   *   When ≥1000ms have passed: currentFPS = frameCount, then reset both.
   *
   *   This means if the game loop fires 57 times in one second,
   *   currentFPS = 57 — even if individual frames varied from 10ms to 25ms.
   *   That's more accurate than 1/frameTime for display purposes.
   */
  public endFrame(): void {
    const frameTime = performance.now() - this.frameStartTime;

    this.frameTimeHistory.push(frameTime);
    if (this.frameTimeHistory.length > this.maxHistoryLength) {
      this.frameTimeHistory.shift();
    }

    this.frameCount++;

    const now = Date.now();
    if (now - this.lastSecondTime >= 1000) {
      // A full second has elapsed — snapshot the count as the FPS value
      this.currentFPS = this.frameCount;
      this.frameCount = 0;
      this.lastSecondTime = now;
    }
  }

  /**
   * Tell the monitor how many particles are active right now.
   * Called by the particle system after each update pass.
   */
  public setParticleCount(count: number): void {
    this.particleCount = count;
  }

  /**
   * Tell the monitor how many trajectory points are in memory.
   * Called by the trajectory manager whenever the history array changes.
   */
  public setTrajectoryPointCount(count: number): void {
    this.trajectoryPointCount = count;
  }

  /**
   * Compute and return the full metrics snapshot for this moment.
   *
   * ROLLING AVERAGE FORMULA:
   *   sum = history[0] + history[1] + ... + history[N-1]
   *   average = sum / N
   *   JavaScript: array.reduce((acc, val) => acc + val, 0) / array.length
   *
   * HEALTH SCORE FORMULA (all deductions are proportional, not binary):
   *   Start at 100.
   *   FPS deduction:   40 × (1 - fps/60)   → full FPS=0 costs 40pts; FPS=60 costs 0
   *   Frame deduction: 20 × (ms/threshold)  → 33ms costs 20pts; 16ms costs ~10pts
   *   Particle:        20 × (count/3000)    → 3000 particles costs 20pts
   *   Trajectory:      20 × (count/50000)   → 50k points costs 20pts
   *   Max deduction total = 40+20+20+20 = 100 (score floors at 0, never negative)
   *
   * MEMORY ESTIMATE:
   *   Each {x: number, y: number} object:
   *     - x is a 64-bit IEEE 754 float → 8 bytes
   *     - y is a 64-bit IEEE 754 float → 8 bytes
   *     - JavaScript object header in V8: ~16 bytes
   *     Total ≈ 32 bytes per point
   *   This is a rough estimate — the actual heap usage varies by JS engine.
   */
  public getMetrics(): PerformanceMetrics {
    // Compute rolling averages using array reduce
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

    // Build the warnings array — each threshold gets its own check
    const warnings: string[] = [];

    if (this.currentFPS < this.fpsWarningThreshold) {
      warnings.push(`⚠️ Low FPS: ${this.currentFPS} (target: 60)`);
    }

    if (avgFrameTime > this.frameTimeWarningThreshold) {
      warnings.push(`⚠️ Slow frames: ${avgFrameTime.toFixed(1)}ms (target: 16.7ms)`);
    }

    if (this.particleCount > this.particleWarningThreshold) {
      warnings.push(`⚠️ High particle count: ${this.particleCount} (recommended: < 3000)`);
    }

    if (this.trajectoryPointCount > this.trajectoryWarningThreshold) {
      warnings.push(`⚠️ Large trajectory: ${this.trajectoryPointCount} points (recommended: < 50000)`);
    }

    // Health score: starts perfect, deductions proportional to how bad each metric is
    let healthScore = 100;
    healthScore -= Math.max(0, 40 * (1 - this.currentFPS / 60));
    healthScore -= Math.max(0, 20 * (avgFrameTime / this.frameTimeWarningThreshold));
    healthScore -= Math.max(0, 20 * (this.particleCount / this.particleWarningThreshold));
    healthScore -= Math.max(0, 20 * (this.trajectoryPointCount / this.trajectoryWarningThreshold));
    healthScore = Math.max(0, Math.min(100, healthScore));

    // Rough trajectory memory estimate: 32 bytes per {x, y} point → convert to MB
    const trajectoryMemoryMB = (this.trajectoryPointCount * 32) / (1024 * 1024);

    // "Healthy" = FPS is acceptable AND no warnings at all
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
   * Reset all counters back to initial state.
   * Call when starting a new launch so history from the previous flight
   * doesn't bleed into the first few seconds of the new one.
   */
  public reset(): void {
    this.frameCount = 0;
    this.currentFPS = 60;           // Optimistic default until we have real data
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
 * TrajectoryLimiter — keeps the trajectory history array from growing forever.
 *
 * PROBLEM IT SOLVES:
 *   The trajectory history gains one point every physics tick (~16ms at 60 FPS).
 *   After 10 minutes: ~36,000 points. After 1 hour: ~216,000 points.
 *   That's roughly 7MB of plain objects, and iterating 216k objects to draw
 *   the trajectory line takes ~3ms per frame — a significant chunk of budget.
 *
 * TWO STRATEGIES:
 *   1. Hard limit (limitTrajectory): slice off the oldest points when over max.
 *      Result: trajectory shows only the MOST RECENT segment of the flight.
 *   2. Sampling (sampleTrajectory): keep every Nth point.
 *      Result: trajectory covers the FULL flight, just at lower resolution.
 *
 *   optimizeTrajectory() applies both: first limit, then sample. This gives
 *   a bounded array size with full-flight coverage at reduced fidelity.
 */
export class TrajectoryLimiter {
  private config: TrajectoryLimiterConfig;
  private lastCleanupTime: number = Date.now();

  constructor(config: TrajectoryLimiterConfig) {
    this.config = config;
  }

  /**
   * Remove oldest points to bring array under maxPoints limit.
   *
   * SLICING SEMANTICS:
   *   trajectory.slice(n) returns elements from index n to the end.
   *   So slice(excessPoints) drops the first excessPoints elements —
   *   those are the oldest positions, recorded earliest in the flight.
   *
   *   This preserves the most recent flight path, which is typically
   *   what the player cares about most (current trajectory, not launch position).
   */
  public limitTrajectory(
    trajectory: Array<{ x: number; y: number }>
  ): Array<{ x: number; y: number }> {
    if (trajectory.length <= this.config.maxPoints) {
      return trajectory; // Already within limit — nothing to do
    }

    // Drop oldest (front) points to reach maxPoints size
    const excessPoints = trajectory.length - this.config.maxPoints;
    return trajectory.slice(excessPoints);
  }

  /**
   * Down-sample the trajectory by keeping every Nth point.
   *
   * EXAMPLE with sampleRate=3 on [A, B, C, D, E, F, G, H, I]:
   *   Keeps indices 0, 3, 6 → [A, D, G]
   *   Discards B, C, E, F, H, I (67% reduction)
   *
   * The trajectory still covers the full range of the flight; it just has
   * fewer intermediate points. For high-altitude flights the shape is preserved
   * because the rocket moves smoothly and adjacent points are nearly collinear.
   */
  public sampleTrajectory(
    trajectory: Array<{ x: number; y: number }>
  ): Array<{ x: number; y: number }> {
    if (this.config.sampleRate <= 1) {
      return trajectory; // sampleRate=1 means keep everything
    }

    const sampled: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < trajectory.length; i += this.config.sampleRate) {
      sampled.push(trajectory[i]);
    }
    return sampled;
  }

  /**
   * Apply both limit and sampling in one pass.
   * Call this during periodic cleanup (see shouldCleanup / markCleanup).
   */
  public optimizeTrajectory(
    trajectory: Array<{ x: number; y: number }>
  ): Array<{ x: number; y: number }> {
    let optimized = this.limitTrajectory(trajectory);
    optimized = this.sampleTrajectory(optimized);
    return optimized;
  }

  /**
   * Returns true if enough time has passed since the last cleanup.
   * Use this in the game loop to decide when to run optimizeTrajectory:
   *
   *   if (limiter.shouldCleanup()) {
   *     trajectoryHistory = limiter.optimizeTrajectory(trajectoryHistory);
   *     limiter.markCleanup();
   *   }
   */
  public shouldCleanup(): boolean {
    return Date.now() - this.lastCleanupTime >= this.config.cleanupInterval * 1000;
  }

  /** Record that cleanup just ran — resets the interval timer. */
  public markCleanup(): void {
    this.lastCleanupTime = Date.now();
  }

  /** Merge new config values into the existing config (partial update). */
  public setConfig(config: Partial<TrajectoryLimiterConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Convert a health score into a human-readable status label with color.
 *
 * THRESHOLDS (chosen to match intuitive traffic-light UX):
 *   90-100: EXCELLENT — everything is perfect
 *    70-89: GOOD — minor warnings, still smooth
 *    50-69: ACCEPTABLE — noticeable issues but playable
 *    20-49: POOR — significant performance problems
 *     0-19: CRITICAL — close to unplayable
 *
 * The color values match the HUD color scheme:
 *   Green (#00ff00 / #00dd00): all is well
 *   Yellow (#ffff00): caution
 *   Orange (#ff8800): degraded
 *   Red (#ff0000): critical
 */
export function getPerformanceStatus(metrics: PerformanceMetrics): {
  status: "EXCELLENT" | "GOOD" | "ACCEPTABLE" | "POOR" | "CRITICAL";
  color: string;
  emoji: string;
} {
  if (metrics.healthScore >= 90 && metrics.warnings.length === 0) {
    return { status: "EXCELLENT", color: "#00ff00", emoji: "🟢" };
  }

  if (metrics.healthScore >= 70 && metrics.warnings.length <= 1) {
    return { status: "GOOD", color: "#00dd00", emoji: "🟢" };
  }

  if (metrics.healthScore >= 50 && metrics.warnings.length <= 2) {
    return { status: "ACCEPTABLE", color: "#ffff00", emoji: "🟡" };
  }

  if (metrics.healthScore >= 20 || metrics.warnings.length <= 3) {
    return { status: "POOR", color: "#ff8800", emoji: "🟠" };
  }

  return { status: "CRITICAL", color: "#ff0000", emoji: "🔴" };
}
