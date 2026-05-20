/**
 * ROCKET SIMULATOR - PARTICLE SYSTEM
 * ==================================
 * A simple particle system for creating visual effects like exhaust trails,
 * smoke, and flame particles that follow the rocket as it moves.
 * 
 * Particles are small elements that spawn, move, fade out, and disappear.
 * They create a visual sense of motion and thrust without heavy computation.
 */

/**
 * A single particle in the world.
 * Particles have position, velocity, and fade out over time.
 */
export interface Particle {
  // Position in world space (meters)
  x: number;
  y: number;

  // Velocity in world space (meters/second)
  vx: number;
  vy: number;

  // Visual properties
  size: number; // Radius of the particle (pixels)
  color: string; // Color to draw (RGB or RGBA)
  opacity: number; // Transparency 0-1 (1 = fully opaque)

  // Lifetime
  age: number; // How long the particle has existed (seconds)
  lifetime: number; // How long until particle disappears (seconds)
}

/**
 * The particle system manages all particles in the world.
 * It creates particles, updates them, and removes dead ones.
 */
export class ParticleSystem {
  // Array of all active particles
  private particles: Particle[] = [];

  /**
   * Create a new particle and add it to the system
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
    // Create particle with defaults
    const particle: Particle = {
      x: options.x,
      y: options.y,
      vx: options.vx || 0,
      vy: options.vy || 0,
      size: options.size || 5,
      color: options.color || "rgba(255, 100, 0, 1)",
      opacity: 1,
      age: 0,
      lifetime: options.lifetime || 1, // Default 1 second lifetime
    };

    // Add to particle array
    this.particles.push(particle);
  }

  /**
   * Create an explosion of particles in a circular pattern
   * Useful for burst effects when rocket lands or fuel runs out
   */
  public createBurst(
    x: number,
    y: number,
    count: number = 10,
    color: string = "rgba(255, 150, 0, 1)",
    speed: number = 20
  ): void {
    // Create particles radiating outward in all directions
    for (let i = 0; i < count; i++) {
      // Random angle (0 to 2π)
      const angle = (Math.random() * Math.PI * 2);

      // Random speed (0 to max speed)
      const randomSpeed = Math.random() * speed;

      // Calculate velocity components
      const vx = Math.cos(angle) * randomSpeed;
      const vy = Math.sin(angle) * randomSpeed;

      this.createParticle({
        x,
        y,
        vx,
        vy,
        size: Math.random() * 3 + 2, // Random size 2-5
        color,
        lifetime: Math.random() * 0.5 + 0.3, // Random lifetime 0.3-0.8 seconds
      });
    }
  }

  /**
   * Create an exhaust trail from rocket engine
   * Spawns particles continuously to follow the rocket
   */
  public createExhaustTrail(
    rocketX: number,
    rocketY: number,
    rocketVelocityX: number,
    rocketVelocityY: number,
    thrustPercentage: number = 50
  ): void {
    // Only create particles if thrusting
    if (thrustPercentage <= 0) return;

    // Number of particles based on thrust (more thrust = more particles)
    const particleCount = Math.floor(thrustPercentage / 10) + 2;

    for (let i = 0; i < particleCount; i++) {
      // Particles spawn below the rocket (where flame comes out)
      const spawnX = rocketX + (Math.random() - 0.5) * 5; // Slight horizontal spread
      const spawnY = rocketY - 5; // Below rocket

      // Particles move downward and slightly disperse
      const baseVelocity = -rocketVelocityY * 0.3; // Inherit some rocket motion
      const vx = (Math.random() - 0.5) * 10; // Random horizontal drift
      const vy = baseVelocity - Math.random() * 15; // Move downward

      // Color varies from orange to yellow based on thrust
      const heatColor = Math.floor(255 * (thrustPercentage / 100));
      const color = `rgba(255, ${100 + heatColor}, 0, 1)`;

      this.createParticle({
        x: spawnX,
        y: spawnY,
        vx,
        vy,
        size: Math.random() * 2 + 1, // Small particles (1-3)
        color,
        lifetime: 0.5, // Quick fade
      });
    }
  }

  /**
   * Update all particles (move them, age them, remove dead ones)
   * Call this once per frame
   */
  public update(deltaTime: number): void {
    // Loop through particles backwards so we can remove while iterating
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];

      // === UPDATE POSITION ===
      // Move particle based on velocity
      particle.x += particle.vx * deltaTime;
      particle.y += particle.vy * deltaTime;

      // === AGE PARTICLE ===
      particle.age += deltaTime;

      // === FADE OUT ===
      // Opacity decreases as particle approaches end of life
      // This creates a smooth fade effect instead of sudden disappearance
      const lifetimePercent = particle.age / particle.lifetime;
      particle.opacity = Math.max(0, 1 - lifetimePercent);

      // === REMOVE DEAD PARTICLES ===
      // If particle has lived its lifetime, remove it from array
      if (particle.age >= particle.lifetime) {
        this.particles.splice(i, 1);
      }
    }
  }

  /**
   * Draw all particles on a canvas
   */
  public draw(
    ctx: CanvasRenderingContext2D,
    pixelsPerMeter: number,
    canvasWidth: number,
    canvasHeight: number
  ): void {
    for (const particle of this.particles) {
      // Convert world coordinates to screen coordinates
      // Center on screen horizontally, flip Y (screen has Y=0 at top)
      const screenX = (canvasWidth / 2) + (particle.x * pixelsPerMeter);
      const screenY = canvasHeight - 20 - (particle.y * pixelsPerMeter);

      // Skip particles outside view
      if (screenX < -20 || screenX > canvasWidth + 20 ||
          screenY < -20 || screenY > canvasHeight + 20) {
        continue;
      }

      // Set particle color with current opacity
      // Parse the color string and modify alpha
      const colorWithOpacity = particle.color.replace(
        /[\d.]+\)$/,
        `${particle.opacity})`
      );
      ctx.fillStyle = colorWithOpacity;

      // Draw particle as a circle
      ctx.beginPath();
      ctx.arc(screenX, screenY, particle.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Get all particles (for debugging or analysis)
   */
  public getParticles(): Particle[] {
    return [...this.particles]; // Return a copy so external code can't modify
  }

  /**
   * Clear all particles at once
   */
  public clear(): void {
    this.particles = [];
  }

  /**
   * Get particle count (useful for performance monitoring)
   */
  public getParticleCount(): number {
    return this.particles.length;
  }
}