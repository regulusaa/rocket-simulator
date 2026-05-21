/**
 * ROCKET SIMULATOR - PARTICLE SYSTEM (CAMERA-AWARE VERSION)
 * ==========================================================
 * Manages visual particles for exhaust trails, separation bursts, and landing effects.
 *
 * CHANGES IN THIS VERSION:
 *   - draw() now takes a Camera instance instead of hardcoded canvas dimensions.
 *     This means particles are rendered at the correct camera-transformed positions
 *     regardless of where the camera is or how far it is zoomed out.
 *   - createExhaustTrail() takes the rocket's angle so exhaust particles spawn
 *     BEHIND the nozzle (opposite to the thrust direction) instead of always below.
 *   - Particle spawn positions are in world space (meters) and converted to
 *     screen space via camera.worldToScreen() at render time.
 *
 * HOW PARTICLES WORK:
 *   1. Spawn — createParticle() / createBurst() / createExhaustTrail() add entries
 *      to the internal array with initial position, velocity, color, and lifetime.
 *   2. Update — each frame, update() moves particles, ages them, and removes dead ones.
 *   3. Draw   — draw() converts each particle's world-space position to screen-space
 *      and renders a circle with decreasing opacity as the particle ages.
 */

import type { Camera } from "../utils/Camera";
// The Camera class converts world coordinates (meters) to screen coordinates (pixels).
// We import the TYPE only since particles don't instantiate cameras — just use them.

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * A single particle in world space.
 * Particles are purely visual — they don't interact with the rocket physics.
 */
export interface Particle {
  // Position in world space (meters, same coordinate system as the rocket).
  x: number;
  y: number;

  // Velocity in world space (meters/second).
  // Particles move independently of the rocket once spawned.
  vx: number;
  vy: number;

  // Visual properties.
  size: number;    // Radius in world meters (scaled by camera zoom at render time)
  color: string;   // CSS color string, e.g., "rgba(255, 100, 0, 1)"
  opacity: number; // Current transparency 0–1 (fades from 1 to 0 over lifetime)

  // Lifetime tracking.
  age: number;      // Seconds since this particle was created
  lifetime: number; // Seconds before this particle disappears
}

// ─── PARTICLE SYSTEM CLASS ────────────────────────────────────────────────────

/**
 * ParticleSystem manages all active particles.
 * It is the only object that holds and mutates the particles array.
 */
export class ParticleSystem {
  // The live array of all currently active particles.
  // Particles are added at the end and removed mid-array when dead (splice).
  private particles: Particle[] = [];

  // ─── CREATION ────────────────────────────────────────────────────────────────

  /**
   * Create and add a single particle with the given properties.
   * All properties are in world space (meters, m/s).
   *
   * @param options  Initial particle configuration. Unspecified fields get defaults.
   */
  public createParticle(options: {
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    size?: number;
    color?: string;
    lifetime?: number;
  }): void {
    // Build the full particle from options with sensible defaults.
    const particle: Particle = {
      x: options.x,
      y: options.y,
      vx: options.vx ?? 0,                          // Default: no horizontal motion
      vy: options.vy ?? 0,                          // Default: no vertical motion
      size: options.size ?? 1,                      // Default: 1-meter radius
      color: options.color ?? "rgba(255, 100, 0, 1)", // Default: orange exhaust color
      opacity: 1,                                   // All particles start fully opaque
      age: 0,                                       // Just born — age starts at zero
      lifetime: options.lifetime ?? 1,              // Default: 1 second before disappearing
    };

    // Append to the active particles array.
    this.particles.push(particle);
  }

  /**
   * Create an explosion burst: many particles radiating outward in all directions.
   * Used for stage separation, landing impacts, or other punctuation moments.
   *
   * @param x       World-space X center of the burst (meters).
   * @param y       World-space Y center of the burst (meters, altitude).
   * @param count   Number of particles in the burst.
   * @param color   Color string for burst particles.
   * @param speed   Maximum outward speed (world m/s) for burst particles.
   */
  public createBurst(
    x: number,
    y: number,
    count: number = 10,
    color: string = "rgba(255, 150, 0, 1)",
    speed: number = 20
  ): void {
    for (let i = 0; i < count; i++) {
      // Random outward angle covers the full circle (0 to 2π radians).
      const angle = Math.random() * Math.PI * 2;

      // Random speed from 0 to max — creates a natural dispersal cone.
      const particleSpeed = Math.random() * speed;

      // Decompose speed into world-space velocity components.
      const vx = Math.cos(angle) * particleSpeed; // Horizontal component
      const vy = Math.sin(angle) * particleSpeed; // Vertical component

      this.createParticle({
        x,
        y,
        vx,
        vy,
        size: Math.random() * 1 + 0.5,  // Random size 0.5–1.5 meters
        color,
        lifetime: Math.random() * 0.5 + 0.3, // 0.3–0.8 seconds — quick burst
      });
    }
  }

  /**
   * Create exhaust trail particles from the rocket's nozzle.
   * Particles spawn behind the nozzle (opposite to thrust direction) and drift away.
   *
   * The nozzle is at (rocketX, rocketY) in world space.
   * Thrust goes in the direction (sin(angle), cos(angle)).
   * Exhaust goes the OPPOSITE direction: (-sin(angle), -cos(angle)).
   *
   * @param rocketX         Rocket nozzle X position (world meters).
   * @param rocketY         Rocket nozzle Y position (world meters, altitude).
   * @param rocketVX        Rocket's current horizontal velocity (m/s) — particles inherit some.
   * @param rocketVY        Rocket's current vertical velocity (m/s) — particles inherit some.
   * @param rocketAngle     Rocket's tilt angle in radians (0 = vertical).
   * @param throttlePercent Current throttle 0–100% — controls particle count and color.
   */
  public createExhaustTrail(
    rocketX: number,
    rocketY: number,
    rocketVX: number,
    rocketVY: number,
    rocketAngle: number,
    throttlePercent: number = 50
  ): void {
    // Skip particle creation when engine is off.
    if (throttlePercent <= 0) return;

    // Number of particles per call scales with throttle.
    // At 10% throttle: 3 particles. At 100%: 12 particles.
    const particleCount = Math.floor((throttlePercent / 100) * 10) + 2;

    // The exhaust nozzle direction: opposite to where the rocket is pointing.
    // Rocket thrust direction is (sin(angle), cos(angle)).
    // Exhaust is opposite: (-sin(angle), -cos(angle)).
    const nozzleDirX = -Math.sin(rocketAngle); // Horizontal component of "down the nozzle"
    const nozzleDirY = -Math.cos(rocketAngle); // Vertical component of "down the nozzle"

    for (let i = 0; i < particleCount; i++) {
      // Spawn position: slightly behind the nozzle so particles appear to emerge from it.
      // Add random spread perpendicular to the nozzle direction.
      const spreadAmount = (Math.random() - 0.5) * 1.5; // ±0.75 m perpendicular spread
      // Perpendicular to nozzleDirX/nozzleDirY is (nozzleDirY, -nozzleDirX) rotated 90°.
      const spawnX = rocketX + nozzleDirX * 2 + spreadAmount * nozzleDirY;
      const spawnY = rocketY + nozzleDirY * 2 - spreadAmount * nozzleDirX;

      // Exhaust velocity: combination of nozzle direction plus rocket's own velocity (partial inheritance).
      // baseSpeed: how fast exhaust shoots out (world m/s). Scales with throttle.
      const baseSpeed = 10 + (throttlePercent / 100) * 20; // 10–30 m/s exhaust speed

      // Inherit 30% of rocket's velocity so exhaust hangs near the rocket for a moment.
      const inheritFactor = 0.3;
      const vx =
        nozzleDirX * baseSpeed +    // Exhaust shooting down the nozzle
        rocketVX * inheritFactor +  // Inherit fraction of rocket horizontal speed
        (Math.random() - 0.5) * 5; // Random dispersion ±2.5 m/s

      const vy =
        nozzleDirY * baseSpeed +    // Exhaust shooting down the nozzle (downward when vertical)
        rocketVY * inheritFactor +  // Inherit fraction of rocket vertical speed
        (Math.random() - 0.5) * 5; // Random dispersion ±2.5 m/s

      // Color shifts with throttle level:
      //   Low throttle (0–30%): more reddish-orange (incomplete combustion look)
      //   High throttle (70–100%): more yellow-white (hotter, more complete combustion)
      // We interpolate the green channel: low=100 (orange), high=200 (yellow-white).
      const greenChannel = Math.floor(100 + (throttlePercent / 100) * 155);
      const color = `rgba(255, ${greenChannel}, 0, 1)`;

      this.createParticle({
        x: spawnX,
        y: spawnY,
        vx,
        vy,
        size: Math.random() * 0.5 + 0.25, // 0.25–0.75 m — small smoke puffs in world space
        color,
        lifetime: 0.4 + Math.random() * 0.4, // 0.4–0.8 seconds — quick fade
      });
    }
  }

  // ─── UPDATE ──────────────────────────────────────────────────────────────────

  /**
   * Advance all particles by one time step: move, age, fade, remove dead ones.
   * Call this ONCE per frame with real deltaTime (not game-speed multiplied).
   * Particles are visual-only and should age at real time speed regardless of
   * the game's time multiplier, otherwise they flash by too quickly at 10× speed.
   *
   * @param deltaTime Seconds elapsed since the last frame (real time, not game time).
   */
  public update(deltaTime: number): void {
    // Iterate backwards so we can safely remove particles mid-loop via splice.
    // If we iterated forward and spliced, the index would skip the next element.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];

      // Move particle according to its velocity.
      // Particles don't have gravity applied — they float freely in world space.
      p.x += p.vx * deltaTime;
      p.y += p.vy * deltaTime;

      // Age the particle — how long it has lived.
      p.age += deltaTime;

      // Compute opacity as a linear fade from 1 → 0 over the particle's lifetime.
      // lifetimePercent goes from 0 (just born) to 1 (about to die).
      const lifetimePercent = p.age / p.lifetime;
      // 1 - percent: at 0% done, opacity=1 (fully visible); at 100% done, opacity=0 (gone).
      p.opacity = Math.max(0, 1 - lifetimePercent);

      // Remove the particle once it has exceeded its lifetime.
      if (p.age >= p.lifetime) {
        this.particles.splice(i, 1); // Remove one element at index i
      }
    }
  }

  // ─── DRAW ────────────────────────────────────────────────────────────────────

  /**
   * Render all particles onto the canvas using the camera's world-to-screen transform.
   *
   * CHANGED from original: instead of using hardcoded canvas dimensions to compute
   * a fixed screenX/Y, this now delegates to camera.worldToScreen() which applies
   * the camera's position, zoom, and shake. This means particles correctly follow
   * the rocket even when the camera has panned or zoomed.
   *
   * @param ctx          Canvas 2D rendering context.
   * @param camera       Active camera (provides world→screen transform + zoom).
   * @param canvasWidth  Current canvas pixel width (for culling off-screen particles).
   * @param canvasHeight Current canvas pixel height (for culling off-screen particles).
   */
  public draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    canvasWidth: number,
    canvasHeight: number
  ): void {
    for (const p of this.particles) {
      // Convert world-space particle position to screen-space pixels via camera transform.
      // This accounts for camera pan (x, y), zoom level, and shake offsets.
      const { x: screenX, y: screenY } = camera.worldToScreen(
        p.x,
        p.y,
        canvasWidth,
        canvasHeight
      );

      // Cull particles that are outside the visible canvas area.
      // Skipping off-screen particles saves fillRect/arc calls and improves performance.
      // The ±50 px margin prevents particles just at the edge from popping in/out.
      if (
        screenX < -50 || screenX > canvasWidth + 50 ||
        screenY < -50 || screenY > canvasHeight + 50
      ) {
        continue; // This particle is off-screen — skip drawing it
      }

      // Convert particle size from world-space meters to screen-space pixels.
      // At zoom=1.0: 1 m = PIXELS_PER_METER px. At zoom=0.5: 1 m = 0.5 × PPM px.
      const screenRadius = Math.max(1, camera.worldLengthToPixels(p.size));
      // Math.max(1) ensures particles never become sub-pixel (invisible at high zoom-out).

      // Build the color string with the current opacity injected.
      // The color was stored as "rgba(R, G, B, 1)"; we replace the "1)" at the end
      // with the current opacity value so transparency fades correctly.
      const colorWithOpacity = p.color.replace(
        /[\d.]+\)$/, // Match the last number before the closing paren (the alpha channel)
        `${p.opacity})` // Replace with current opacity (0→1)
      );

      ctx.fillStyle = colorWithOpacity;

      // Draw as a filled circle centered on the screen position.
      ctx.beginPath();
      ctx.arc(screenX, screenY, screenRadius, 0, Math.PI * 2); // Full circle
      ctx.fill();
    }
  }

  // ─── QUERIES ─────────────────────────────────────────────────────────────────

  /**
   * Return a copy of all active particles (for debugging only).
   * External code should NOT mutate particles directly — use the public create methods.
   */
  public getParticles(): Particle[] {
    return [...this.particles]; // Shallow copy prevents external mutation
  }

  /** Remove all particles immediately. Used on reset to clear exhaust trails. */
  public clear(): void {
    this.particles = []; // Replace with empty array — GC handles old array
  }

  /**
   * Return the current number of active particles.
   * Used by PerformanceMonitor to track particle load.
   */
  public getParticleCount(): number {
    return this.particles.length;
  }
}
