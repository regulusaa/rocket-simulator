/**
 * CAMERA SYSTEM FOR ROCKET SIMULATOR
 * ===================================
 * The Camera class solves the "rocket flies off screen" problem.
 *
 * Without a camera, if the rocket reaches 1 km altitude with PIXELS_PER_METER=2,
 * it would need to be 2000 pixels high on screen — far outside any canvas.
 * The camera fixes this by:
 *
 *   1. TRACKING — Following the rocket so it always stays on screen.
 *   2. ZOOMING  — Zooming out logarithmically as altitude increases so we see more world.
 *   3. SMOOTHING — Using lerp (linear interpolation) so camera movements feel fluid.
 *   4. SHAKE    — Adding random offsets during thrust/staging for cinematic punch.
 *
 * TWO COORDINATE SYSTEMS:
 *   World space  — meters. X=0 is launch pad, Y=0 is ground, Y increases upward.
 *   Screen space — pixels. X=0 is top-left, Y=0 is top, Y increases DOWNWARD.
 *
 * FUNDAMENTAL TRANSFORM (world → screen):
 *   screenX = (worldX - camera.x) * zoom * PPM + canvasWidth  / 2
 *   screenY = canvasHeight / 2  - (worldY - camera.y) * zoom * PPM
 *
 * When camera.x == worldX: object sits at horizontal center of screen.
 * When camera.y == worldY: object sits at vertical center of screen.
 * The minus sign on Y flips the axis (world Y up ↔ screen Y down).
 */

import { PIXELS_PER_METER } from "./constants";
// Import the pixels-per-meter ratio so we know how many pixels represent one real meter.
// At PIXELS_PER_METER=2, one meter = 2 pixels at zoom 1.0.

/**
 * Camera manages the viewport for the rocket simulator.
 *
 * It holds two sets of position/zoom values:
 *  - "current" (this.x, this.y, this.zoom) — used for rendering right now
 *  - "target"  (private targetX, targetY, targetZoom) — where the camera wants to be
 *
 * Each frame, update() lerps the current values toward the target, creating smooth motion.
 */
export class Camera {
  // ─── CURRENT RENDERING VALUES ────────────────────────────────────────────────
  // These are the values actually used when converting world → screen each frame.
  // They lag slightly behind the target values; that lag is the smooth-follow effect.

  /** Current horizontal center of the view in world space (meters). */
  public x: number;

  /** Current vertical center of the view in world space (meters, altitude). */
  public y: number;

  /**
   * Current zoom level.
   *   1.0 = natural scale: 1 meter = PIXELS_PER_METER px on screen.
   *   0.5 = 2× zoomed out: 1 meter = PIXELS_PER_METER * 0.5 px — world looks smaller.
   *   0.1 = 10× zoomed out: rocket is tiny but we see much more of the world.
   */
  public zoom: number;

  // ─── TARGET VALUES (camera interpolates toward these) ─────────────────────────
  // These are updated every frame based on rocket position and altitude.

  /** Desired horizontal center in world space. Camera glides toward this. */
  private targetX: number;

  /** Desired vertical center in world space. Camera glides toward this. */
  private targetY: number;

  /** Desired zoom level. Camera slowly scales toward this. */
  private targetZoom: number;

  // ─── SMOOTHING COEFFICIENTS ───────────────────────────────────────────────────

  /**
   * Position smoothing factor per frame (0 = frozen, 1 = snap instantly).
   * At 0.08: each frame the camera covers 8% of remaining distance to target.
   * After 60 frames (1 second at 60fps) it has covered 1 - 0.92^60 ≈ 99.3% of
   * the distance — so it feels responsive but never abruptly jumps.
   */
  private readonly POSITION_SMOOTHING: number = 0.08;

  /**
   * Zoom smoothing factor per frame.
   * Deliberately slower than position (0.05 vs 0.08) because sudden zoom changes
   * feel disorienting. Zooming out feels gradual and intentional at this rate.
   */
  private readonly ZOOM_SMOOTHING: number = 0.05;

  // ─── LOOK-AHEAD OFFSET ────────────────────────────────────────────────────────

  /**
   * Number of pixels below screen center where the rocket will appear.
   * By placing the rocket below center, we expose more sky above it — giving
   * the player a better view of the trajectory the rocket is flying toward.
   *
   * Derivation: if we want the rocket at screenY = canvasH/2 + LOOK_AHEAD_PIXELS,
   * we must set camera.y = rocketY + LOOK_AHEAD_PIXELS / (zoom * PPM).
   * (See setTarget() for the algebra.)
   */
  private readonly LOOK_AHEAD_PIXELS: number = 180;

  // ─── CAMERA SHAKE ─────────────────────────────────────────────────────────────

  /**
   * Horizontal screen-space shake offset in pixels added to every rendered position.
   * Randomized each frame when shakeIntensity > 0 to simulate vibration.
   */
  public shakeX: number = 0;

  /**
   * Vertical screen-space shake offset in pixels.
   * Same behavior as shakeX — randomized each frame during active shake.
   */
  public shakeY: number = 0;

  /**
   * Maximum random offset in pixels each frame while shaking.
   * Decays toward zero over time (see SHAKE_DECAY_RATE).
   * Set by addShake():  2 px = gentle engine rumble,  5 px = stage separation jolt.
   */
  private shakeIntensity: number = 0;

  /**
   * How fast shake intensity decreases per second.
   * At 8.0: intensity drops 80% per 0.1s (frame at 60fps ≈ 0.016s → drops 13% per frame).
   * This means a shake burst of 5 px fades to near-zero in about 0.6 seconds.
   */
  private readonly SHAKE_DECAY_RATE: number = 8.0;

  // ─── CONSTRUCTOR ──────────────────────────────────────────────────────────────

  /**
   * Create a Camera centered on the launch pad.
   * The rocket starts at world (0, 0), so we aim slightly above ground
   * to see both the rocket on the pad and some sky above it.
   */
  constructor() {
    // Start looking at x=0 (launch pad horizontal center).
    this.x = 0;
    // Look slightly above ground so some sky is visible before launch.
    // 50 meters above ground at zoom=1 with PPM=2 means 100 px of sky visible above center.
    this.y = 50;
    // Begin at natural 1:1 scale — see fine detail at ground level.
    this.zoom = 1.0;

    // Initialize targets to match current values so the camera doesn't drift at startup.
    this.targetX = 0;
    this.targetY = 50;
    this.targetZoom = 1.0;
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────────────

  /**
   * Update camera state for this frame: lerp position/zoom toward targets, decay shake.
   * Call this ONCE per frame AFTER calling setTarget() and setTargetZoom(),
   * and BEFORE calling worldToScreen() for any rendering.
   *
   * @param deltaTime Seconds elapsed since the last frame (e.g., 0.016 at 60fps).
   *                  Required for frame-rate-independent shake decay.
   */
  public update(deltaTime: number): void {
    // ── LERP POSITION ──
    // Linear interpolation formula: x_new = x_old + (target - x_old) * factor
    // Each frame we close the gap by POSITION_SMOOTHING fraction.
    // Over many frames this converges exponentially toward the target.
    this.x += (this.targetX - this.x) * this.POSITION_SMOOTHING;
    // Apply the same lerp vertically.
    this.y += (this.targetY - this.y) * this.POSITION_SMOOTHING;

    // ── LERP ZOOM ──
    // Zoom uses a slower smoothing rate so zoom-out feels graceful, not snappy.
    this.zoom += (this.targetZoom - this.zoom) * this.ZOOM_SMOOTHING;

    // Clamp zoom to a sane range to prevent rendering artifacts.
    // Min 0.01: even at extreme altitude the rocket is a tiny visible dot.
    // Max 3.0: zooming in beyond 3× makes the rocket disappear off screen edges.
    this.zoom = Math.max(0.01, Math.min(3.0, this.zoom));

    // ── DECAY SHAKE ──
    // Reduce shake intensity toward zero over real time (not game time)
    // so shake always fades at the same pace regardless of time multiplier.
    this.shakeIntensity -= this.SHAKE_DECAY_RATE * deltaTime;
    // Clamp to zero — shake intensity cannot be negative.
    if (this.shakeIntensity < 0) this.shakeIntensity = 0;

    if (this.shakeIntensity > 0) {
      // Generate fresh random offsets in the range [-intensity, +intensity].
      // (Math.random()-0.5) gives [-0.5, +0.5]; multiplying by 2*intensity gives the full range.
      this.shakeX = (Math.random() - 0.5) * 2 * this.shakeIntensity;
      this.shakeY = (Math.random() - 0.5) * 2 * this.shakeIntensity;
    } else {
      // No shake active: zero out offsets so rendering is perfectly clean.
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /**
   * Tell the camera where the rocket is so it can follow it.
   * The camera will smoothly glide toward the supplied position over subsequent frames.
   *
   * We deliberately place the rocket BELOW screen center (by LOOK_AHEAD_PIXELS) so
   * the player sees the sky ahead of the rocket, not just what's already been flown past.
   *
   * ALGEBRA for the Y offset:
   *   We want: screenY_rocket = canvasH/2 + LOOK_AHEAD_PIXELS
   *   The transform is: screenY = canvasH/2 - (worldY - camera.y) * zoom * PPM
   *   Substituting screenY_rocket = canvasH/2 + LOOK_AHEAD_PIXELS, worldY = rocketY:
   *     canvasH/2 + LOOK_AHEAD_PIXELS = canvasH/2 - (rocketY - camera.y) * zoom * PPM
   *     LOOK_AHEAD_PIXELS            = -(rocketY - camera.y) * zoom * PPM
   *     rocketY - camera.y           = -LOOK_AHEAD_PIXELS / (zoom * PPM)
   *     camera.y                     = rocketY + LOOK_AHEAD_PIXELS / (zoom * PPM)
   * So camera.y is set ABOVE the rocket in world space → rocket appears BELOW center. ✓
   *
   * @param rocketWorldX Rocket's horizontal position in meters.
   * @param rocketWorldY Rocket's altitude in meters (state.position.y).
   */
  public setTarget(rocketWorldX: number, rocketWorldY: number): void {
    // Follow rocket horizontally with no offset — rocket stays near horizontal center.
    this.targetX = rocketWorldX;

    // Compute how many world-space meters equal LOOK_AHEAD_PIXELS at current zoom.
    // We use this.zoom (current, not target) so the offset doesn't jump when zoom changes.
    const worldOffset = this.LOOK_AHEAD_PIXELS / (this.zoom * PIXELS_PER_METER);
    // Set vertical target above the rocket by that world offset → rocket appears below center.
    this.targetY = rocketWorldY + worldOffset;
  }

  /**
   * Set the desired zoom level based on the rocket's current altitude.
   * Uses logarithmic scaling so the zoom-out feels natural at all altitudes.
   *
   * Approximate zoom values produced by this formula:
   *   0 m   → zoom ≈ 1.00  (ground level, full detail)
   *   800 m → zoom ≈ 0.50  (1 km, 2× zoomed out)
   *   2400m → zoom ≈ 0.25  (4× zoomed out)
   *   7200m → zoom ≈ 0.125 (8× zoomed out)
   *   ~65 km→ zoom ≈ 0.031 (near minimum)
   *
   * FORMULA DERIVATION:
   *   doublings = log₃(1 + altitude/800)
   *     — At alt=0:   doublings=0 (zoom halved 0 times → zoom=1.0)
   *     — At alt=800: doublings=1 (zoom halved once  → zoom=0.5)
   *     — At alt=2400:doublings=2 (zoom halved twice → zoom=0.25)
   *   zoom = 1 / 2^doublings = Math.pow(0.5, doublings)
   *   This creates a "halves every 3× altitude" progression.
   *
   * @param altitude Current altitude in meters (state.position.y).
   */
  public setTargetZoom(altitude: number): void {
    // Number of "doublings" (zoom halvings) based on altitude.
    // Math.log(x)/Math.log(3) computes log base 3 of x because: log₃(x) = ln(x)/ln(3).
    const doublings = Math.log(1 + altitude / 800) / Math.log(3);

    // Zoom halves once per doubling. 1/2^doublings = 2^(-doublings).
    // Clamp to minimum 0.02 so the rocket never becomes a sub-pixel invisible dot.
    this.targetZoom = Math.max(0.02, 1.0 / Math.pow(2, doublings));
  }

  /**
   * Snap the camera back to the launch-pad view instantly (no lerp delay).
   * Called when the player hits Reset so the camera doesn't slowly drift downward.
   */
  public reset(): void {
    // Snap both current values AND targets to the initial state.
    // If only targets were set, the camera would lerp down over several seconds — jarring.
    this.x = 0;
    this.y = 50; // 50 m above ground so some sky is visible.
    this.zoom = 1.0;
    this.targetX = 0;
    this.targetY = 50;
    this.targetZoom = 1.0;
    // Remove any lingering shake so the reset view is perfectly stable.
    this.shakeIntensity = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }

  /**
   * Trigger a camera shake burst. Stronger shakes override weaker ones (no stacking).
   * The shake fades automatically via SHAKE_DECAY_RATE in update().
   *
   * Recommended intensities:
   *   2 px — subtle engine vibration when throttle > 50%
   *   5 px — violent jolt during stage separation
   *
   * @param intensity Maximum random pixel offset per frame (pixels).
   */
  public addShake(intensity: number): void {
    // Math.max prevents multiple weak events from accumulating into nausea.
    // A strong event (stage separation at 5) dominates a gentle rumble (engine at 2).
    this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
  }

  /**
   * Convert a world-space position to canvas pixel coordinates.
   * Every object drawn on the canvas must pass through this transform.
   *
   * MATH:
   *   effectivePPM = PIXELS_PER_METER * zoom
   *     — Zoom scales how many pixels represent one real meter.
   *   screenX = (worldX - camera.x) * effectivePPM + canvasWidth/2  + shakeX
   *     — Shift by camera offset, scale to pixels, center horizontally, add shake.
   *   screenY = canvasHeight/2 - (worldY - camera.y) * effectivePPM + shakeY
   *     — Minus sign: world +Y is up, screen +Y is DOWN, so we negate the offset.
   *
   * @param worldX   Horizontal position in world space (meters).
   * @param worldY   Vertical position in world space (meters, altitude).
   * @param canvasWidth  Canvas width in pixels (use current canvas.width).
   * @param canvasHeight Canvas height in pixels (use current canvas.height).
   * @returns         {x, y} in screen-space pixels, ready to pass to ctx.* calls.
   */
  public worldToScreen(
    worldX: number,
    worldY: number,
    canvasWidth: number,
    canvasHeight: number
  ): { x: number; y: number } {
    // Combine base pixels-per-meter with current zoom to get the effective scale.
    // At zoom=0.5: 1 meter → PIXELS_PER_METER * 0.5 px (world appears half-size).
    const effectivePPM = PIXELS_PER_METER * this.zoom;

    // Horizontal: distance from camera center scaled to pixels, then centered + shake.
    const screenX =
      (worldX - this.x) * effectivePPM + canvasWidth / 2 + this.shakeX;

    // Vertical: distance from camera center negated (flip Y axis), then centered + shake.
    // Positive worldY (above camera) → negative offset → smaller screenY → higher on canvas. ✓
    const screenY =
      canvasHeight / 2 - (worldY - this.y) * effectivePPM + this.shakeY;

    return { x: screenX, y: screenY };
  }

  /**
   * Convert a world-space length (meters) to a pixel length at the current zoom level.
   * Use this for sizing drawn elements (rocket width, flame height, etc.)
   * so they scale correctly as the camera zooms in and out.
   *
   * @param meters Length in world space (meters).
   * @returns      Equivalent length in screen pixels.
   */
  public worldLengthToPixels(meters: number): number {
    // effectivePPM = PIXELS_PER_METER * zoom.
    // A 1-meter length becomes 2 px at zoom=1.0, or 1 px at zoom=0.5.
    return meters * PIXELS_PER_METER * this.zoom;
  }
}
