/**
 * ROCKET SIMULATOR - DRAWING HELPER FUNCTIONS
 * ============================================
 * Pure canvas-drawing functions used by RocketSimulator's game loop.
 * Each function takes a ctx + explicit parameters so there are NO closures
 * over React state — the game loop can call them without stale-value concerns.
 *
 * Functions defined here:
 *   drawBackground   — sky gradient that darkens with altitude
 *   drawStars        — 300-star parallax field
 *   drawGround       — green surface line at world Y=0
 *   drawGoalLine     — dashed altitude target line
 *   drawRocket       — detailed tapered body, fins, porthole, flame, glow
 *   drawTelemetry    — HUD overlay panel (bottom-right)
 *   drawPerfStats    — performance overlay (top-left, debug only)
 */

import type { Camera } from "./Camera";
import type { MultiStageRocketState } from "../physics/engine";
import type { MultiStageRocketConfig } from "../physics/MultiStageSystem";
import type { Parachute, LandingGear } from "../physics/LandingMechanics";
import type { PerformanceMetrics } from "./PerformanceMonitor";
import { COLORS, FONT_SIZE_SMALL, FONT_SIZE_MEDIUM } from "./constants";
// Import temperature model to compute stagnation temperature for heating glow.
// Stagnation temperature = T_ambient × (1 + 0.2 × M²) — how hot the nose cone gets.
import { getTemperature } from "../physics/AtmosphereModel";

// ─── ATMOSPHERIC TELEMETRY DATA TYPE ─────────────────────────────────────────

/**
 * Bundle of atmospheric and structural readings computed each frame.
 * Passed from the game loop (where physics run) into the draw functions.
 * Keeping them in one interface avoids adding many individual parameters.
 */
export interface AtmosphericTelemetry {
  /** Current Mach number (dimensionless, 0 = subsonic at rest). */
  machNumber: number; // e.g., 2.4 = travelling at 2.4× speed of sound

  /** Current dynamic pressure Q = 0.5 × ρ × v² in Pascals. */
  dynamicPressure: number; // Pa — structural loading from airstream

  /** Peak dynamic pressure (Max-Q) reached this flight in Pascals. */
  maxDynamicPressure: number; // Pa — the single highest Q recorded

  /** Altitude in meters where Max-Q occurred (for the callout label). */
  maxQAltitude: number; // m — e.g., 12400 m for Falcon 9

  /** Current acceleration in G-forces (1 G = 9.81 m/s²). */
  currentGForce: number; // G — e.g., 3.2 G is a heavy fighter-jet turn

  /** Structural integrity 0–100% — how intact the rocket is. */
  structuralIntegrity: number; // % — 100 = pristine, 0 = broke apart

  /** Nose cone stagnation temperature in Kelvin.
   *  T_stag = T_ambient × (1 + 0.2 × M²) — kinetic heating formula.
   *  At Mach 3: ~800 K (orange glow). At Mach 5: ~1800 K (white hot). */
  stagnationTemperature: number; // K — how hot the nose cone is getting
}

// ─── STAR TYPE ────────────────────────────────────────────────────────────────

/**
 * A single star in the background star field.
 * Stars are stored in normalized screen-fraction coordinates (0–1) so they
 * can be drawn at any canvas size without re-generating.
 */
export interface Star {
  baseX: number;      // Normalized X position 0–1 (multiply by canvasWidth to get pixels)
  baseY: number;      // Normalized Y position 0–1 (multiply by canvasHeight to get pixels)
  size: number;       // Radius in pixels (0.5–2.0)
  brightness: number; // Opacity 0–1 (varies per star for natural look)
  layer: number;      // 0=far (barely parallax), 1=mid, 2=near (more parallax)
}

// ─── BACKGROUND ──────────────────────────────────────────────────────────────

/**
 * Draw the sky background gradient from ground horizon up to deep space.
 * Color transitions from dark navy at the bottom to pure black at the top
 * as altitude increases — simulating the thinning atmosphere.
 *
 * At altitude 0 km:  deep blue gradient (dense atmosphere)
 * At altitude 50 km: very dark blue (upper atmosphere)
 * At altitude 100+km: near-black (space)
 *
 * @param ctx          Canvas 2D context.
 * @param canvasWidth  Canvas width in pixels.
 * @param canvasHeight Canvas height in pixels.
 * @param altitude     Current rocket altitude in meters (state.position.y).
 */
export function drawBackground(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  altitude: number
): void {
  // Compute how "space-like" the sky is (0 = ground, 1 = full space at 80km+).
  // We use Math.min to cap at 1.0 once we're fully in space.
  const spaceRatio = Math.min(1, altitude / 80000);
  // spaceRatio=0 at ground → rich blue sky.
  // spaceRatio=1 at 80 km+ → pure black space.

  // Create a vertical linear gradient filling the entire canvas.
  const gradient = ctx.createLinearGradient(
    0, 0,             // Gradient start: top of canvas
    0, canvasHeight   // Gradient end: bottom of canvas
  );

  // Interpolate background colors with altitude.
  // At ground: top=medium navy (#0a1628), bottom=slightly lighter (#0d2040).
  // In space: top=pure black, bottom=very dark navy (still shows some atmosphere at bottom).

  // Top color: space black mixed with atmosphere blue.
  // lerp(a, b, t) = a + (b - a) * t where a=space, b=atmosphere.
  const topR = Math.round(0   + (10  - 0)   * (1 - spaceRatio)); // 10  → 0  as altitude rises
  const topG = Math.round(0   + (14  - 0)   * (1 - spaceRatio)); // 14  → 0
  const topB = Math.round(10  + (50  - 10)  * (1 - spaceRatio)); // 50  → 10
  gradient.addColorStop(0, `rgb(${topR},${topG},${topB})`);
  // Color stop 0 = top of canvas (deep space / upper sky).

  // Bottom color: always slightly lighter to show horizon glow.
  const botR = Math.round(5   + (20  - 5)   * (1 - spaceRatio));
  const botG = Math.round(5   + (30  - 5)   * (1 - spaceRatio));
  const botB = Math.round(30  + (80  - 30)  * (1 - spaceRatio));
  gradient.addColorStop(1, `rgb(${botR},${botG},${botB})`);
  // Color stop 1 = bottom of canvas (near-ground atmosphere / horizon).

  // Fill the entire canvas with this gradient.
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
}

// ─── STARS ────────────────────────────────────────────────────────────────────

/**
 * Draw the parallax star field.
 * Stars in different "layers" move at different speeds as the camera pans,
 * creating a sense of depth (near stars move more than far stars).
 *
 * PARALLAX MATH:
 *   The camera's position (in meters) is normalized to a [0,1] range by dividing
 *   by a reference distance (100 km altitude, 50 km horizontal). This normalized
 *   offset is multiplied by a layer-specific parallax factor and added to the
 *   star's base position, then wrapped with modulo so stars tile seamlessly.
 *
 * Stars also become more opaque as altitude increases (darker sky = more visible stars).
 *
 * @param ctx          Canvas 2D context.
 * @param stars        Pre-generated star array (see generateStars()).
 * @param canvasWidth  Canvas width in pixels.
 * @param canvasHeight Canvas height in pixels.
 * @param camera       Active camera (provides position for parallax calculation).
 * @param altitude     Current rocket altitude in meters (controls star visibility).
 */
export function drawStars(
  ctx: CanvasRenderingContext2D,
  stars: Star[],
  canvasWidth: number,
  canvasHeight: number,
  camera: Camera,
  altitude: number
): void {
  // Stars become fully visible as we leave the lower atmosphere (fully visible at 20 km).
  // Below 5 km: barely visible (sky is still somewhat bright).
  // Above 20 km: fully visible (dark sky, no light scattering).
  const starVisibility = Math.min(1, Math.max(0, (altitude - 5000) / 15000));
  // starVisibility=0 at ground/low alt → stars hidden.
  // starVisibility=1 at 20km+ → stars fully bright.

  // If stars are not visible at all, skip drawing them entirely (performance).
  if (starVisibility <= 0) return;

  // Parallax factors per layer: far=0.05, mid=0.12, near=0.22
  // A factor of 0.1 means stars shift by 10% of the canvas per "unit" of camera movement.
  const parallaxX = [0.05, 0.12, 0.22]; // Horizontal parallax per layer
  const parallaxY = [0.03, 0.08, 0.15]; // Vertical parallax per layer (less than X because we fly mostly vertical)

  // Normalize camera position to [0, ref_distance] range.
  // We divide by a large reference distance so the star shift is small (not jarring).
  const camNormX = camera.x / 50000;  // 50 km horizontal reference
  const camNormY = camera.y / 100000; // 100 km vertical reference (Kármán line)

  for (const star of stars) {
    // Select this star's parallax factors based on its depth layer.
    const pxFactor = parallaxX[star.layer]; // How much this layer moves horizontally
    const pyFactor = parallaxY[star.layer]; // How much this layer moves vertically

    // Compute parallax-shifted position, wrapped to stay on screen.
    // ((value % 1) + 1) % 1 handles both positive and negative modulo correctly.
    // Without the (+1)%1 trick, negative values would give negative screen coords.
    const shiftedX = ((star.baseX - camNormX * pxFactor) % 1 + 1) % 1;
    // Stars shift LEFT as camera moves RIGHT (camera.x increases → shiftedX decreases).
    const shiftedY = ((star.baseY + camNormY * pyFactor) % 1 + 1) % 1;
    // Stars shift DOWN as camera moves UP (camera.y increases → shiftedY increases).
    // This is opposite to world objects because stars are "behind" the world.

    // Convert normalized position to pixel coordinates.
    const screenX = shiftedX * canvasWidth;
    const screenY = shiftedY * canvasHeight;

    // Compute final star opacity: product of its brightness and the altitude-based visibility.
    const opacity = star.brightness * starVisibility;

    // Draw star as a small filled circle.
    ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
    ctx.beginPath();
    ctx.arc(screenX, screenY, star.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Generate a random star field for the background.
 * Called ONCE at startup and stored in a ref — not re-generated each frame.
 *
 * @param count Number of stars to generate (recommend 250–350).
 * @returns     Array of Star objects with randomized properties.
 */
export function generateStars(count: number): Star[] {
  return Array.from({ length: count }, () => ({
    baseX: Math.random(),            // Random normalized X position 0–1
    baseY: Math.random(),            // Random normalized Y position 0–1
    size: 0.5 + Math.random() * 1.5, // Size range: 0.5–2.0 pixels
    brightness: 0.3 + Math.random() * 0.7, // Brightness range: 0.3–1.0
    layer: Math.floor(Math.random() * 3),   // Layer 0, 1, or 2
  }));
}

// ─── GROUND ──────────────────────────────────────────────────────────────────

/**
 * Draw the ground surface at world Y=0.
 * The ground is a thick green band at the camera-transformed screen position.
 * If the ground is above the canvas bottom (rocket has flown high), we still
 * draw it so there's always a visible reference line.
 *
 * @param ctx          Canvas 2D context.
 * @param canvasWidth  Canvas width in pixels.
 * @param canvasHeight Canvas height in pixels.
 * @param camera       Active camera for world→screen transform.
 */
export function drawGround(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  camera: Camera
): void {
  // Get screen Y position of world Y=0 (ground level).
  // worldX doesn't matter for ground line — use camera.x so it stays horizontal.
  const { y: groundScreenY } = camera.worldToScreen(camera.x, 0, canvasWidth, canvasHeight);

  // Only draw the ground band if it's within the visible canvas area.
  // The ±200 margin allows drawing slightly off-screen for smooth scrolling.
  if (groundScreenY < -200 || groundScreenY > canvasHeight + 200) return;

  // Draw the ground as a thick rectangle (20 px tall green band).
  ctx.fillStyle = COLORS.ground; // Dark green (#2d5016)
  ctx.fillRect(0, groundScreenY, canvasWidth, 30);
  // 30 px tall ground band so it's clearly visible at all zoom levels.

  // Draw a bright border line at the top of the ground band for a clean horizon.
  ctx.strokeStyle = "#4a8020"; // Slightly brighter green for the top edge
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundScreenY);
  ctx.lineTo(canvasWidth, groundScreenY);
  ctx.stroke();

  // Draw a launch pad marker at horizontal center (x=0 in world space).
  const { x: padScreenX } = camera.worldToScreen(0, 0, canvasWidth, canvasHeight);
  // Draw the launch pad as a gray rectangle centered at world origin.
  ctx.fillStyle = "#888888"; // Gray concrete pad
  const padWidthPx = Math.max(20, camera.worldLengthToPixels(8)); // 8 meters wide, min 20 px
  const padHeightPx = Math.max(4, camera.worldLengthToPixels(1)); // 1 meter tall, min 4 px
  ctx.fillRect(padScreenX - padWidthPx / 2, groundScreenY - padHeightPx, padWidthPx, padHeightPx);
}

// ─── GOAL LINE ────────────────────────────────────────────────────────────────

/**
 * Draw a dashed horizontal line at the target altitude, with a label.
 * Helps the player know how high they need to fly.
 *
 * @param ctx          Canvas 2D context.
 * @param canvasWidth  Canvas width in pixels.
 * @param canvasHeight Canvas height in pixels.
 * @param camera       Active camera for world→screen transform.
 * @param goalAltitude Target altitude in meters.
 * @param goalName     Display name for the goal (e.g., "Kármán Line").
 */
export function drawGoalLine(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  camera: Camera,
  goalAltitude: number,
  goalName: string
): void {
  // Get screen Y position of the goal altitude.
  const { y: goalScreenY } = camera.worldToScreen(camera.x, goalAltitude, canvasWidth, canvasHeight);

  // Only draw if the goal line is visible on screen.
  if (goalScreenY < 0 || goalScreenY > canvasHeight) return;

  // Dashed cyan line spanning the full canvas width.
  ctx.strokeStyle = COLORS.trajectory; // Cyan (#00ffff)
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]); // 8 px dash, 6 px gap — dashed pattern
  ctx.beginPath();
  ctx.moveTo(0, goalScreenY);
  ctx.lineTo(canvasWidth, goalScreenY);
  ctx.stroke();
  ctx.setLineDash([]); // Reset to solid line for all subsequent drawing

  // Label text showing goal name and altitude.
  ctx.fillStyle = COLORS.trajectory;
  ctx.font = `${FONT_SIZE_SMALL}px monospace`;
  const altKm = (goalAltitude / 1000).toFixed(0); // Convert meters to km for display
  ctx.fillText(`▶ ${goalName} (${altKm} km)`, 10, goalScreenY - 6);
  // Position: 10 px from left edge, 6 px above the dashed line.
}

// ─── ROCKET ──────────────────────────────────────────────────────────────────

/**
 * Draw the rocket at its camera-transformed screen position, rotated by its angle.
 *
 * VISUAL FEATURES:
 *   - Tapered body: each stage is a trapezoid (wider at bottom, narrower at top)
 *   - Panel lines: faint horizontal lines every ~10 px suggesting hull panels
 *   - Porthole window: small blue circle near the top of the uppermost stage
 *   - Fins: two triangles at the bottom of the first stage, angled outward
 *   - Interstage rings: slightly wider bands at stage junctions
 *   - Curved nose cone: uses quadratic bezier for a realistic pointed tip
 *   - Exhaust flame: flickering tip, throttle-responsive color, glow effect
 *   - Parachute (if deployed): semicircle above the rocket
 *   - Landing gear (if near ground): two diagonal struts at the nozzle base
 *
 * COORDINATE SYSTEM DURING DRAWING:
 *   After ctx.translate(screenX, screenY) and ctx.rotate(-state.angle):
 *     (0, 0)       = nozzle (bottom of rocket)
 *     (0, -height) = nose tip (top of rocket)
 *   Negative Y = toward nose (up along rocket axis)
 *   Positive Y = away from nozzle (where flame/fins extend)
 *
 * @param ctx          Canvas 2D context.
 * @param canvasWidth  Canvas width in pixels.
 * @param canvasHeight Canvas height in pixels.
 * @param camera       Active camera.
 * @param state        Current flight state (position, angle, etc.).
 * @param config       Rocket configuration (stages, fuel levels).
 * @param parachute    Parachute state for visual deployment indicator.
 * @param landingGear  Landing gear state for strut visual.
 */
export function drawRocket(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  camera: Camera,
  state: MultiStageRocketState,
  config: MultiStageRocketConfig,
  parachute: Parachute,
  landingGear: LandingGear,
  machNumber: number = 0 // NEW: current Mach number for aerodynamic heating visualization
): void {
  // Get screen-space position of the rocket's nozzle (base).
  // state.position represents the bottom of the rocket (nozzle end).
  const { x: screenX, y: screenY } = camera.worldToScreen(
    state.position.x,
    state.position.y,
    canvasWidth,
    canvasHeight
  );

  // Determine pixel dimensions scaled by camera zoom.
  // Math.max enforces a minimum size so the rocket is always visible even when far away.
  const bw = Math.max(5, camera.worldLengthToPixels(2.5)); // Body half-width in pixels (2.5 m radius → 5 m diameter)
  const stageBaseHeight = Math.max(10, camera.worldLengthToPixels(15)); // Base height per stage segment

  // Find the active stage (currently burning) for throttle display.
  const activeStage = config.stages.find((s) => s.isActive && !s.isSeparated);
  const currentThrottle = activeStage ? activeStage.thrustPercentage : 0; // Current throttle 0-100%

  // Save ctx state before applying transform (we'll restore after drawing).
  ctx.save();

  // Move drawing origin to the nozzle's screen position.
  ctx.translate(screenX, screenY);

  // Rotate coordinate system so the rocket points in its actual angle direction.
  // ctx.rotate() is clockwise-positive, but our angle convention is:
  //   +angle = tilt right (nose upper-right in world space = clockwise on screen)
  // So we pass state.angle directly to match.
  ctx.rotate(state.angle);
  // After this rotation: local -Y axis points along the rocket's nose direction.

  // Track the "current drawing Y" in local space, starting at 0 (nozzle).
  // We move upward (toward -Y) as we stack stages.
  let currentLocalY = 0;

  // ── DRAW STAGES (bottom to top) ──────────────────────────────────────────
  for (let i = 0; i < config.stages.length; i++) {
    const stage = config.stages[i];
    if (stage.isSeparated) continue; // Skip separated stages (they've fallen away)

    // Each stage is slightly different size for visual variety.
    // Higher stages (larger i) are slightly narrower and shorter (less mass).
    const stageHeight = stageBaseHeight * (1.0 - i * 0.1); // 10% shorter per stage
    const bottomWidth = bw * (1.0 - i * 0.05); // 5% narrower per stage
    const topWidth = bottomWidth * 0.88; // Taper: top is 88% as wide as bottom

    // Compute fuel level for the fuel-bar color (green=full, red=empty).
    const fuelPercent = stage.fuelMass / stage.fuelCapacity; // 0–1
    const fuelR = Math.round(255 * (1 - fuelPercent)); // More red as fuel depletes
    const fuelG = Math.round(255 * fuelPercent);       // More green when full
    const fuelColor = `rgb(${fuelR}, ${fuelG}, 0)`;

    // Stage base color: lighter for upper stages (stacked visually different).
    const baseGray = 180 - i * 25; // 180, 155, 130 for stages 0, 1, 2
    ctx.fillStyle = `rgb(${baseGray}, ${baseGray}, ${baseGray + 10})`;
    // Slight blue tint (+10 on B channel) for a metallic look.

    // Draw stage body as a trapezoid (wider at bottom, narrower at top).
    // Trapezoid vertices in local space:
    //   Bottom-left:  (-bottomWidth, currentLocalY)
    //   Bottom-right: (+bottomWidth, currentLocalY)
    //   Top-right:    (+topWidth, currentLocalY - stageHeight)
    //   Top-left:     (-topWidth, currentLocalY - stageHeight)
    ctx.beginPath();
    ctx.moveTo(-bottomWidth, currentLocalY);           // Bottom-left corner
    ctx.lineTo(bottomWidth, currentLocalY);            // Bottom-right corner
    ctx.lineTo(topWidth, currentLocalY - stageHeight); // Top-right corner
    ctx.lineTo(-topWidth, currentLocalY - stageHeight);// Top-left corner
    ctx.closePath();
    ctx.fill();

    // Draw thin outline for the stage body.
    ctx.strokeStyle = "rgba(100, 100, 120, 0.8)"; // Dark border
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw a thin fuel-level bar inside the stage body.
    // The bar width represents current fuel remaining (full → empty bar shrinks).
    if (stageHeight > 12) {
      // Only draw fuel bar if stage is large enough to show it legibly.
      const barHeight = Math.min(4, stageHeight * 0.15); // Bar height: 15% of stage or 4px max
      const barY = currentLocalY - barHeight - 2;        // Position 2px from bottom of stage
      const maxBarWidth = (topWidth + bottomWidth) * 0.7; // Max bar width: 70% of stage width
      const barWidth = maxBarWidth * fuelPercent;          // Current bar width proportional to fuel
      ctx.fillStyle = fuelColor;
      // Draw centered bar showing fuel remaining.
      ctx.fillRect(-barWidth / 2, barY, barWidth, barHeight);
    }

    // Draw panel lines: faint horizontal lines across the body every ~10 px.
    // These simulate structural hull panels for a detailed look.
    if (stageHeight > 20) {
      // Only draw panel lines when stage is visually large enough to show them.
      ctx.strokeStyle = "rgba(80, 80, 100, 0.4)"; // Very faint darker line
      ctx.lineWidth = 0.5;
      const panelSpacing = 10; // 10 px between panel lines
      for (let py = currentLocalY - panelSpacing; py > currentLocalY - stageHeight + 3; py -= panelSpacing) {
        // Interpolate width at this Y level (between bottom and top width).
        const t = (currentLocalY - py) / stageHeight; // 0 at bottom, 1 at top
        const lineHalfW = bottomWidth + (topWidth - bottomWidth) * t; // Interpolated half-width
        ctx.beginPath();
        ctx.moveTo(-lineHalfW + 1, py);  // 1px inset so lines don't overlap the border
        ctx.lineTo(lineHalfW - 1, py);
        ctx.stroke();
      }
    }

    // ── PORTHOLE: small window on the uppermost non-separated stage ──────────
    if (i === config.stages.filter((s) => !s.isSeparated).length - 1) {
      // This is the topmost visible stage — draw the porthole near its top.
      if (stageHeight > 18) {
        // Only draw porthole if stage is large enough to see it.
        const portY = currentLocalY - stageHeight * 0.75; // 75% up the stage from nozzle end
        const portR = Math.max(2, bw * 0.25); // Porthole radius: 25% of body half-width
        // Outer ring (dark frame).
        ctx.fillStyle = "rgba(60, 60, 60, 1)";
        ctx.beginPath();
        ctx.arc(0, portY, portR + 1, 0, Math.PI * 2);
        ctx.fill();
        // Inner glass (light blue).
        ctx.fillStyle = "rgba(100, 180, 255, 0.9)";
        ctx.beginPath();
        ctx.arc(0, portY, portR, 0, Math.PI * 2);
        ctx.fill();
        // Highlight glint (top-left quarter-circle, white).
        ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
        ctx.beginPath();
        ctx.arc(0, portY, portR * 0.5, Math.PI, Math.PI * 1.5);
        ctx.fill();
      }
    }

    // Move the drawing cursor upward to stack the next stage above this one.
    currentLocalY -= stageHeight;

    // ── INTERSTAGE RING: wider band where adjacent stages connect ─────────────
    // Real rockets have interstage adapters that are slightly wider than either stage.
    if (i < config.stages.length - 1 && !config.stages[i + 1].isSeparated) {
      const ringH = Math.max(3, stageBaseHeight * 0.08); // Ring height: 8% of base stage height
      const ringW = topWidth + Math.max(2, bw * 0.15);   // Ring is slightly wider than the stage top

      // Dark gray interstage ring.
      ctx.fillStyle = "rgba(80, 80, 90, 1)";
      ctx.fillRect(-ringW, currentLocalY - ringH, ringW * 2, ringH);

      // Bright highlight stripe on top of the ring for a machined-metal look.
      ctx.fillStyle = "rgba(160, 160, 170, 0.7)";
      ctx.fillRect(-ringW, currentLocalY - 1, ringW * 2, 1);

      currentLocalY -= ringH; // Move cursor above the ring for the next stage
    }
  }

  // ── NOSE CONE: curved pointed tip at the top of the rocket ─────────────────
  const nosePx = Math.max(8, camera.worldLengthToPixels(4)); // Nose height in pixels
  const lastTopWidth = bw * 0.6; // Width at base of nose cone (matching last stage top)

  ctx.fillStyle = "#e84444"; // Bright red nose cone for visual distinctiveness
  ctx.beginPath();
  ctx.moveTo(-lastTopWidth, currentLocalY);  // Left base of nose
  // Quadratic bezier for left curve: control point curves inward toward center.
  ctx.quadraticCurveTo(
    -lastTopWidth * 0.3,   // Control point X: slightly left of center
    currentLocalY - nosePx * 0.5, // Control point Y: halfway up
    0, currentLocalY - nosePx     // End point: the very tip of the nose
  );
  // Quadratic bezier for right curve: mirrors the left side.
  ctx.quadraticCurveTo(
    lastTopWidth * 0.3,    // Control point X: slightly right of center
    currentLocalY - nosePx * 0.5, // Control point Y: halfway up
    lastTopWidth, currentLocalY   // End point: right base of nose
  );
  ctx.closePath();
  ctx.fill();

  // Thin dark outline on nose cone.
  ctx.strokeStyle = "rgba(180, 20, 20, 0.8)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── AERODYNAMIC HEATING GLOW ───────────────────────────────────────────────
  // At high speeds, air molecules pile up in front of the nose cone and can't
  // get out of the way fast enough. The kinetic energy converts to heat through
  // compression and friction. This is called aerodynamic (or ram) heating.
  //
  // STAGNATION TEMPERATURE: T_stag = T_ambient × (1 + 0.2 × M²)
  //   - At Mach 2: T_stag ≈ 288 × (1 + 0.8) = 518 K (~245°C) — no visible glow yet
  //   - At Mach 3: T_stag ≈ 288 × (1 + 1.8) = 806 K (~533°C) — dull orange glow
  //   - At Mach 5: T_stag ≈ 288 × (1 + 5.0) = 1728 K (~1455°C) — bright orange-white
  //
  // Space Shuttle tiles were designed to survive 1650°C (re-entry at Mach 25).
  // The Columbia disaster occurred because heat shield tiles were damaged at launch.
  //
  // We draw the glow as a radial gradient centered on the nose tip — it grows
  // in size and intensity as Mach number increases above 2.
  if (machNumber > 2.0 && state.isFlying) {
    // The nose tip is at local position (0, currentLocalY - nosePx) in the rotated frame.
    const noseTipY = currentLocalY - nosePx; // Y coordinate of the nose tip in local space

    // Compute ambient temperature at current altitude for stagnation formula.
    const ambientTemp = getTemperature(state.position.y); // K — ISA temperature at altitude

    // Stagnation temperature: T_stag = T_ambient × (1 + 0.2 × M²)
    // This is the adiabatic stagnation temperature for a flat plate at Mach M.
    const stagnationTemp = ambientTemp * (1 + 0.2 * machNumber * machNumber); // K

    // Map stagnation temperature to a 0–1 glow intensity for visual brightness.
    // Glow starts at 500 K (barely visible red heat) and peaks at 2000 K (white hot).
    const glowIntensity = Math.min(1.0, Math.max(0, (stagnationTemp - 500) / 1500)); // 0–1

    // Glow radius grows with Mach: larger at higher speeds (bigger shock stand-off).
    // At Mach 2: nosePx × 0.4; at Mach 5: nosePx × 1.0 (wider shock envelope).
    const glowRadius = nosePx * 0.2 + nosePx * 0.8 * glowIntensity; // pixels

    // Create a radial gradient centered on the nose tip.
    // Center is hotter (white/orange), edges fade to transparent.
    const gradient = ctx.createRadialGradient(
      0, noseTipY, 0,          // Inner circle: center at nose tip, radius 0
      0, noseTipY, glowRadius  // Outer circle: center at nose tip, fade radius
    );

    // Color stops: center = hot white core, middle = orange plasma, edge = transparent.
    // Temperature → color mapping (approximate blackbody radiation colors):
    //   600 K: dark red glow
    //   800 K: orange
    //   1200 K: bright orange
    //   1800 K+: orange-white to white
    const innerAlpha = glowIntensity * 0.9; // Core brightness (0–0.9)
    const outerAlpha = glowIntensity * 0.4; // Edge brightness (0–0.4)

    // Inner hot core: white/yellow at extreme temperatures, orange at moderate.
    const coreGreen = Math.round(100 + glowIntensity * 100); // 100–200 green channel
    const coreBlue = Math.round(glowIntensity * 80); // 0–80 blue channel (hotter = bluer)
    gradient.addColorStop(0, `rgba(255, ${coreGreen}, ${coreBlue}, ${innerAlpha})`); // Core

    // Mid zone: bright orange plasma ring around the nose.
    gradient.addColorStop(0.3, `rgba(255, 140, 0, ${outerAlpha * 0.8})`); // Orange ring

    // Edge: transparent — glow fades into darkness around it.
    gradient.addColorStop(1.0, `rgba(255, 60, 0, 0)`); // Fade to transparent

    // Draw the glow as a filled circle with the radial gradient.
    ctx.fillStyle = gradient; // Apply gradient fill
    ctx.beginPath();
    ctx.arc(0, noseTipY, glowRadius, 0, Math.PI * 2); // Circle centered on nose tip
    ctx.fill(); // Draw the heating glow

    // If temperature is critical (> 2000 K): add an extra bright inner flash.
    // Above 2000 K the nose cone material is at its thermal limit — visible as white.
    if (stagnationTemp > 2000) {
      const criticalGlow = ctx.createRadialGradient(
        0, noseTipY, 0, // Center: nose tip
        0, noseTipY, glowRadius * 0.4 // Small intense inner core
      );
      criticalGlow.addColorStop(0, `rgba(255, 240, 200, 0.8)`); // Near-white hot core
      criticalGlow.addColorStop(1, `rgba(255, 180, 50, 0)`); // Fade out
      ctx.fillStyle = criticalGlow;
      ctx.beginPath();
      ctx.arc(0, noseTipY, glowRadius * 0.4, 0, Math.PI * 2); // Small inner glow
      ctx.fill(); // Draw critical temperature inner flash
    }
  }

  // ── FINS: triangular fins at the bottom of the first stage ───────────────
  // Fins are attached at the nozzle (local Y=0) and extend downward and outward.
  if (!config.stages[0].isSeparated) {
    // Only draw fins if the first stage hasn't been jettisoned.
    const finHeight = Math.max(6, bw * 1.2); // Fin height: 120% of half-body-width
    const finOutreach = Math.max(4, bw * 0.8); // How far fins extend outward

    ctx.fillStyle = "rgba(120, 120, 135, 1)"; // Slightly darker than body — metallic gray

    // Left fin: triangle pointing down-left.
    ctx.beginPath();
    ctx.moveTo(-bw, 0);                      // Root: where fin meets the nozzle edge
    ctx.lineTo(-bw - finOutreach, finHeight); // Tip: downward and outward
    ctx.lineTo(-bw * 0.6, finHeight * 0.4);  // Inner trailing edge
    ctx.closePath();
    ctx.fill();

    // Right fin: mirror of left fin.
    ctx.beginPath();
    ctx.moveTo(bw, 0);                       // Root: right side of nozzle
    ctx.lineTo(bw + finOutreach, finHeight); // Tip: downward and outward
    ctx.lineTo(bw * 0.6, finHeight * 0.4);  // Inner trailing edge
    ctx.closePath();
    ctx.fill();

    // Thin outline on fins for definition.
    ctx.strokeStyle = "rgba(80, 80, 95, 0.8)";
    ctx.lineWidth = 1;
  }

  // ── FLAME: exhaust from the active engine ────────────────────────────────
  if (activeStage && activeStage.isThrusting && activeStage.fuelMass > 0) {
    const flameH = Math.max(5,
      camera.worldLengthToPixels(1) + // Minimum 1-meter flame
      (camera.worldLengthToPixels(18) * (currentThrottle / 100)) // Grows with throttle
    );
    // flameH: scales from ~1m at 0% throttle to ~19m at 100% throttle.

    // Flame tip flicker: add a random ±10% variation to the tip position each frame.
    // This creates a convincing flickering effect without any animation state.
    const flickerAmount = flameH * 0.1; // 10% of flame height as flicker range
    const flickeredHeight = flameH + (Math.random() - 0.5) * 2 * flickerAmount;

    // ── GLOW EFFECT: large semi-transparent circle behind the flame base ───
    // Simulates the bright luminous zone around a real rocket engine bell.
    const glowRadius = bw * 1.5 + (currentThrottle / 100) * bw;
    // Glow color transitions with throttle:
    //   Low throttle: orange glow
    //   High throttle: blue-white glow (hotter plasma)
    const glowAlpha = 0.15 + (currentThrottle / 100) * 0.2; // 0.15–0.35 opacity
    const glowBlue = Math.round((currentThrottle / 100) * 200); // 0–200 blue channel
    ctx.fillStyle = `rgba(255, 180, ${glowBlue}, ${glowAlpha})`;
    ctx.beginPath();
    ctx.arc(0, 0, glowRadius, 0, Math.PI * 2); // Circle centered at nozzle
    ctx.fill();

    // ── OUTER FLAME: wide orange/red cone (visible outer flame envelope) ────
    // Color: low throttle=deep orange, high throttle=yellow-orange.
    const outerGreen = Math.round(80 + (currentThrottle / 100) * 120); // 80–200 green
    ctx.fillStyle = `rgba(255, ${outerGreen}, 0, 0.85)`;
    ctx.beginPath();
    ctx.moveTo(-bw * 0.9, 0);            // Left base at nozzle
    ctx.lineTo(bw * 0.9, 0);             // Right base at nozzle
    ctx.lineTo(bw * 0.3, flickeredHeight);  // Right side of flame tip (narrowed)
    ctx.lineTo(0, flickeredHeight * 1.1); // Center tip (slightly longer with flicker)
    ctx.lineTo(-bw * 0.3, flickeredHeight); // Left side of flame tip
    ctx.closePath();
    ctx.fill();

    // ── INNER FLAME: narrower, brighter core ─────────────────────────────
    // At high throttle the core is nearly white/blue (super-hot combustion zone).
    const innerBlue = Math.round((currentThrottle / 100) * 200); // 0–200 blue channel
    const innerGreen = Math.round(180 + (currentThrottle / 100) * 75); // 180–255 green
    ctx.fillStyle = `rgba(255, ${innerGreen}, ${innerBlue}, 0.95)`;
    ctx.beginPath();
    ctx.moveTo(-bw * 0.45, 0);              // Left base (narrower than outer)
    ctx.lineTo(bw * 0.45, 0);              // Right base
    ctx.lineTo(0, flickeredHeight * 0.65); // Tip (shorter — inner flame is concentrated)
    ctx.closePath();
    ctx.fill();
  }

  // ── PARACHUTE: deployed during descent ────────────────────────────────────
  if (parachute.isDeployed && parachute.deploymentProgress > 0) {
    // The parachute appears above the nose cone.
    const chuteTip = currentLocalY - nosePx; // Y position of the nose tip in local space
    const chuteRadius = Math.max(8, bw * 3 * parachute.deploymentProgress);
    // Radius grows from 0 to full size as deploymentProgress goes from 0 to 1.

    const chuteY = chuteTip - chuteRadius - 5; // Center of the parachute canopy (above nose)

    // Canopy fill: semi-transparent red.
    ctx.fillStyle = "rgba(255, 80, 80, 0.65)";
    ctx.beginPath();
    ctx.arc(0, chuteY, chuteRadius, Math.PI, 0); // Half-circle (dome facing up)
    ctx.fill();

    // Canopy outline.
    ctx.strokeStyle = "rgba(255, 80, 80, 1)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Four shroud lines from canopy to nose tip.
    ctx.strokeStyle = "rgba(255, 120, 120, 0.6)";
    ctx.lineWidth = 0.8;
    for (let lineIdx = 0; lineIdx < 4; lineIdx++) {
      const t = lineIdx / 3;                       // 0, 0.33, 0.67, 1
      const attachAngle = Math.PI + t * Math.PI;  // Spread from π to 2π (bottom half of canopy)
      const attachX = Math.cos(attachAngle) * chuteRadius;
      const attachY = chuteY + Math.sin(attachAngle) * chuteRadius;
      ctx.beginPath();
      ctx.moveTo(attachX, attachY); // From canopy attachment point
      ctx.lineTo(0, chuteTip);      // To nose tip
      ctx.stroke();
    }
  }

  // ── LANDING GEAR: diagonal struts visible when near the ground ────────────
  if (state.position.y <= 5 && state.isFlying === false || state.position.y <= 20) {
    // Show landing gear when rocket is close to the ground (within 20 m).
    const gearLength = Math.max(8, bw * 1.5); // Gear strut length

    // Color changes based on damage state.
    const gearColor = landingGear.isBroken
      ? "#ff4444"   // Red = broken
      : landingGear.damageState > 0.5
        ? "#ffaa00" // Orange = damaged
        : "#44ff44"; // Green = healthy

    ctx.strokeStyle = gearColor;
    ctx.lineWidth = Math.max(1.5, bw * 0.15); // Scale stroke width with body size

    // Left gear strut: from bottom-left of nozzle outward and downward.
    ctx.beginPath();
    ctx.moveTo(-bw * 0.8, 0);                         // Start at nozzle left
    ctx.lineTo(-bw * 0.8 - gearLength * 0.6, gearLength); // End: outward and down
    ctx.stroke();

    // Right gear strut: mirror of left.
    ctx.beginPath();
    ctx.moveTo(bw * 0.8, 0);
    ctx.lineTo(bw * 0.8 + gearLength * 0.6, gearLength);
    ctx.stroke();
  }

  // Restore canvas state to remove the translate+rotate transform.
  ctx.restore();
}

// ─── TELEMETRY PANEL ─────────────────────────────────────────────────────────

/**
 * Draw the HUD telemetry panel in the bottom-right corner of the canvas.
 * Shows altitude, velocity, fuel, throttle, stage, status, and (when provided)
 * Mach number, dynamic pressure, Max-Q record, G-forces, structural integrity,
 * and stagnation temperature.
 *
 * @param ctx              Canvas 2D context.
 * @param canvasWidth      Canvas width in pixels.
 * @param canvasHeight     Canvas height in pixels.
 * @param state            Current flight state.
 * @param config           Rocket configuration.
 * @param timeMultiplier   Active time multiplier (0=paused, 1-10=speed).
 * @param isPaused         Whether simulation is currently paused.
 * @param atmoData         Optional atmospheric & structural telemetry (new systems).
 */
export function drawTelemetry(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  state: MultiStageRocketState,
  config: MultiStageRocketConfig,
  timeMultiplier: number,
  isPaused: boolean,
  atmoData?: AtmosphericTelemetry // NEW: optional atmospheric/structural data
): void {
  const panelW = 240; // Panel width in pixels
  // Panel height grows when atmospheric data is present (6 extra rows at 22px each = 132px).
  const panelH = atmoData ? 450 : 320; // Extra rows for MACH, Q, MAX-Q, G, STRUCT, TEMP
  const margin = 16;  // Gap from canvas edge

  // Position panel in the bottom-right corner.
  const panelX = canvasWidth - panelW - margin;
  const panelY = canvasHeight - panelH - margin;

  // Background: semi-transparent dark overlay.
  ctx.fillStyle = "rgba(5, 8, 20, 0.80)";
  ctx.fillRect(panelX, panelY, panelW, panelH);

  // Border in UI blue.
  ctx.strokeStyle = COLORS.ui;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  // Helper: draw one line of text at a given offset from the panel top.
  const line = (text: string, yOffset: number, color: string = COLORS.text) => {
    ctx.fillStyle = color;
    ctx.fillText(text, panelX + 10, panelY + 22 + yOffset);
  };

  ctx.font = `bold ${FONT_SIZE_MEDIUM}px monospace`;
  line("TELEMETRY", 0, COLORS.trajectory); // Title in cyan

  // Separator line under title.
  ctx.strokeStyle = "rgba(74, 111, 165, 0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(panelX + 8, panelY + 28);
  ctx.lineTo(panelX + panelW - 8, panelY + 28);
  ctx.stroke();

  ctx.font = `${FONT_SIZE_SMALL}px monospace`;
  const lh = 22; // Line height in pixels
  let y = 18;    // Current Y offset from panel top (starts below title separator)

  // ── Altitude ──
  const alt = state.position.y;
  const altStr = alt > 100000
    ? `${(alt / 1000).toFixed(1)} km`
    : `${alt.toFixed(0)} m`;
  line(`ALT: ${altStr}`, y); y += lh;

  // Max altitude reached.
  const maxAlt = state.maxAltitudeReached;
  const maxAltStr = maxAlt > 100000
    ? `MAX: ${(maxAlt / 1000).toFixed(1)} km`
    : `MAX: ${maxAlt.toFixed(0)} m`;
  line(maxAltStr, y, "#aaccff"); y += lh; // Slightly blue-tinted for secondary info

  // ── Velocity ──
  const vy = state.velocity.y;
  const vx = state.velocity.x;
  const speed = Math.sqrt(vx * vx + vy * vy).toFixed(1); // Total speed magnitude
  const vyStr = vy >= 0 ? `+${vy.toFixed(1)}` : vy.toFixed(1); // + prefix when ascending
  line(`VY: ${vyStr} m/s`, y); y += lh;
  line(`SPD: ${speed} m/s`, y, "#aaccff"); y += lh;

  // ── Angle ──
  const angleDeg = (state.angle * 180 / Math.PI).toFixed(1); // Convert radians to degrees
  const angleColor = Math.abs(state.angle) > 0.5 ? "#ffaa00" : COLORS.text; // Orange if tilted significantly
  line(`TILT: ${angleDeg}°`, y, angleColor); y += lh;

  // ── Fuel ──
  let totalFuel = 0;
  let totalCapacity = 0;
  for (const s of config.stages) {
    if (!s.isSeparated) {
      totalFuel += s.fuelMass;
      totalCapacity += s.fuelCapacity;
    }
  }
  const fuelPct = totalCapacity > 0 ? (totalFuel / totalCapacity * 100) : 0;
  const fuelColor = fuelPct < 20 ? "#ff4444" : fuelPct < 50 ? "#ffaa00" : "#44ff44";
  line(`FUEL: ${fuelPct.toFixed(0)}%`, y, fuelColor); y += lh;

  // ── Throttle ──
  const activeStage = config.stages.find((s) => s.isActive && !s.isSeparated);
  const throttle = activeStage ? activeStage.thrustPercentage.toFixed(0) : "0";
  line(`THR: ${throttle}%`, y); y += lh;

  // ── Stage info ──
  line(`STAGE: ${state.activeStageNumber + 1}/${config.stages.length}`, y); y += lh;

  // ── Time ──
  const mins = Math.floor(state.timeElapsed / 60);
  const secs = (state.timeElapsed % 60).toFixed(1);
  line(`TIME: ${mins}m ${secs}s`, y); y += lh;

  // ── Status ──
  let status = "STANDBY";
  let statusColor = "#aaaaaa";
  if (state.isFlying)  { status = "FLYING";   statusColor = "#44ff44"; }
  if (state.hasLanded) { status = "LANDED";   statusColor = "#ffaa00"; }
  line(`STATUS: ${status}`, y, statusColor); y += lh;

  // ── ATMOSPHERIC & STRUCTURAL TELEMETRY (new rows, only when data is available) ──
  if (atmoData) {
    // Thin separator line to visually divide legacy telemetry from the new readings.
    ctx.strokeStyle = "rgba(74, 111, 165, 0.4)"; // Faint blue separator line
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(panelX + 8, panelY + 22 + y - 4); // 4px above the separator position
    ctx.lineTo(panelX + panelW - 8, panelY + 22 + y - 4); // Across the panel
    ctx.stroke(); // Draw separator

    // ── MACH NUMBER ────────────────────────────────────────────────────────
    // Mach number = vehicle speed / local speed of sound.
    // Color coding: green = subsonic, orange = transonic, red = supersonic warning.
    // Transonic (M 0.8–1.2) is the most dangerous structural regime (peak Cd).
    const M = atmoData.machNumber; // Current Mach number (dimensionless)
    const machColor =
      M < 0.8  ? COLORS.text :   // White — subsonic, no concern
      M < 1.2  ? "#ffaa00" :     // Orange — transonic drag rise, Max-Q region
      M < 5.0  ? "#ff7722" :     // Dark orange — supersonic
                 "#ff4444";      // Red — hypersonic, heating critical
    line(`MACH: ${M.toFixed(2)}`, y, machColor); // e.g., "MACH: 2.45"
    y += lh; // Advance to next row

    // ── DYNAMIC PRESSURE (Q) ────────────────────────────────────────────────
    // Q = 0.5 × ρ × v² — the aerodynamic loading on the structure.
    // Displayed in kPa (kiloPascals) for readability. 1 kPa = 1000 Pa.
    // Red warning when Q exceeds 80% of the structural limit (33 kPa).
    const qKPa = atmoData.dynamicPressure / 1000; // Convert Pa to kPa for display
    const qLimit = 33.0; // kPa — structural pressure limit (33 kPa)
    const qColor =
      qKPa > qLimit       ? "#ff3333" :   // Red: structural limit exceeded
      qKPa > qLimit * 0.8 ? "#ffaa00" :   // Orange: approaching limit (> 26.4 kPa)
                            COLORS.text;  // White: safe
    line(`Q: ${qKPa.toFixed(1)} kPa`, y, qColor); // e.g., "Q: 28.5 kPa"
    y += lh;

    // ── MAX-Q RECORD ────────────────────────────────────────────────────────
    // Peak dynamic pressure reached so far this flight.
    // Shown in yellow — it's an important historical milestone in every launch.
    // Format: "MAX-Q: 33.2 kPa @ 12.4km" (matching SpaceX launch commentary).
    const maxQKPa = atmoData.maxDynamicPressure / 1000; // Pa → kPa
    const maxQAltKm = (atmoData.maxQAltitude / 1000).toFixed(1); // m → km
    const maxQColor = maxQKPa > qLimit ? "#ff8844" : "#ffdd44"; // Orange if over limit, yellow if safe
    line(
      maxQKPa > 0 // Only show if Max-Q has been recorded
        ? `MAX-Q: ${maxQKPa.toFixed(1)} kPa @${maxQAltKm}km` // Show peak Q with altitude
        : `MAX-Q: --`, // Not yet reached
      y,
      maxQColor // Yellow or orange depending on severity
    );
    y += lh;

    // ── G-FORCE ─────────────────────────────────────────────────────────────
    // Current acceleration in multiples of standard gravity (9.81 m/s²).
    // 1 G = standing on Earth. 3 G = aggressive fighter turn. 7 G = structural limit.
    // Color: green < 3G (comfortable), orange 3–6G (high), red > 6G (near structural limit).
    const G = atmoData.currentGForce; // Current G-force
    const gColor =
      G > 7.0 ? "#ff3333" :  // Red: exceeding structural G limit
      G > 5.0 ? "#ffaa00" :  // Orange: high G, approaching limit
      G > 3.0 ? "#ffdd44" :  // Yellow: elevated but manageable
               COLORS.text;  // White: comfortable range
    line(`G: ${G.toFixed(1)} G`, y, gColor); // e.g., "G: 3.2 G"
    y += lh;

    // ── STRUCTURAL INTEGRITY ─────────────────────────────────────────────────
    // Health of the rocket's structure (0–100%).
    // Decreases when Q or G limits are exceeded, or when flying at high AoA supersonically.
    // Green > 70%, orange 30–70%, red < 30% (near breakup).
    const integrity = atmoData.structuralIntegrity; // %
    const integrityColor =
      integrity < 30  ? "#ff3333" : // Red: critical — imminent breakup
      integrity < 70  ? "#ffaa00" : // Orange: degraded — reduce stress immediately
                        "#44ff44";  // Green: healthy structure
    line(`STRUCT: ${integrity.toFixed(0)}%`, y, integrityColor); // e.g., "STRUCT: 98%"
    y += lh;

    // ── STAGNATION TEMPERATURE ───────────────────────────────────────────────
    // Nose cone temperature: T_stag = T_ambient × (1 + 0.2 × M²)
    // Displayed in Kelvin — warmer than ambient even at subsonic speeds.
    // Critical above 2000 K (nose cone material near melting without heat shield).
    // Color: white < 500K, orange 500–1500K, red 1500–2000K, bright red > 2000K.
    const T = atmoData.stagnationTemperature; // K
    const tempColor =
      T > 2000 ? "#ff3333" :  // Red: CRITICAL — material failure risk
      T > 1500 ? "#ff7722" :  // Dark orange: very hot
      T > 800  ? "#ffaa00" :  // Orange: aerodynamic heating visible
      T > 400  ? "#ffdd88" :  // Warm yellow: elevated but safe
               COLORS.text;  // White: near-ambient
    line(`TEMP: ${T.toFixed(0)} K`, y, tempColor); // e.g., "TEMP: 1240 K"
    y += lh;
  }

  // ── Time multiplier indicator ──
  const timeStr = isPaused ? "⏸ PAUSED" : timeMultiplier === 1 ? "▶ 1×" : `▶▶ ${timeMultiplier}×`;
  const timeColor = isPaused ? "#ff8844" : timeMultiplier > 1 ? "#ffff44" : "#44ff88";
  line(timeStr, y, timeColor);
}

// ─── PERFORMANCE STATS (DEBUG) ────────────────────────────────────────────────

/**
 * Draw the performance stats panel in the top-left corner.
 * Only visible when debug mode is active (P key toggles it).
 *
 * @param ctx     Canvas 2D context.
 * @param metrics Performance metrics from PerformanceMonitor.
 */
export function drawPerfStats(
  ctx: CanvasRenderingContext2D,
  metrics: PerformanceMetrics
): void {
  const panelW = 260;
  const panelH = 180;
  const px = 10; // Panel X (left side)
  const py = 10; // Panel Y (top)

  ctx.fillStyle = "rgba(0, 0, 0, 0.80)";
  ctx.fillRect(px, py, panelW, panelH);

  // Get performance status color from utility function.
  // We import this function lazily to avoid circular deps.
  const fps = metrics.framesPerSecond;
  const statusColor = fps >= 55 ? "#44ff44" : fps >= 30 ? "#ffaa00" : "#ff4444";

  ctx.strokeStyle = statusColor;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px, py, panelW, panelH);

  const line = (text: string, y: number, color: string = COLORS.text) => {
    ctx.fillStyle = color;
    ctx.fillText(text, px + 10, py + 18 + y);
  };

  ctx.font = `bold ${FONT_SIZE_SMALL}px monospace`;
  line("PERFORMANCE", 0, statusColor);

  ctx.font = `${FONT_SIZE_SMALL}px monospace`;
  const lh = 18;
  let y = lh + 2;

  line(`FPS: ${fps.toFixed(0)}`, y); y += lh;
  line(`Frame: ${metrics.frameTime.toFixed(1)} ms`, y); y += lh;
  line(`Physics: ${metrics.physicsTime.toFixed(1)} ms`, y); y += lh;
  line(`Render: ${metrics.renderTime.toFixed(1)} ms`, y); y += lh;
  line(`Particles: ${metrics.particleCount}`, y); y += lh;
  line(`Trajectory pts: ${metrics.trajectoryPointCount}`, y); y += lh;
  line(`Health: ${metrics.healthScore.toFixed(0)}/100`, y);
}

// ─── MAX-Q FLASH ──────────────────────────────────────────────────────────────

/**
 * Draw the "MAX-Q" callout text centered on the canvas.
 * Shown for 2 seconds when the rocket passes through its maximum dynamic pressure.
 *
 * WHY MAX-Q IS CALLED OUT IN REAL LAUNCHES:
 *   "Vehicle is passing through Max-Q" is a standard milestone announced in every
 *   SpaceX, NASA, and ULA launch webcast. It marks the moment of greatest
 *   aerodynamic stress on the vehicle — the product of high air density (still
 *   relatively dense atmosphere) and high speed (rocket is accelerating fast).
 *   After Max-Q, the air thins faster than the rocket speeds up, so structural
 *   loads decrease. The rocket is "over the hump" and flying into thinner air.
 *
 * VISUAL DESIGN:
 *   Large yellow bold text in the center of the screen.
 *   Alpha fades from 1.0 (at timer=2s) to 0 (at timer=0s) for a smooth fade-out.
 *
 * @param ctx          Canvas 2D context.
 * @param canvasWidth  Canvas width in pixels.
 * @param canvasHeight Canvas height in pixels.
 * @param alpha        Opacity 0–1 (caller fades this out over 2 seconds).
 */
export function drawMaxQFlash(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  alpha: number // 0–1, caller reduces this over 2 seconds until it reaches 0
): void {
  // Clamp alpha to valid range in case of floating-point drift.
  const a = Math.max(0, Math.min(1, alpha)); // 0–1

  // Center of the screen where the callout appears.
  const cx = canvasWidth / 2;  // Horizontal center
  const cy = canvasHeight / 2 - 40; // Slightly above vertical center (not covering telemetry)

  // ── BACKGROUND BADGE ──────────────────────────────────────────────────────
  // Dark semi-transparent pill behind the text for legibility against any background.
  ctx.fillStyle = `rgba(0, 0, 0, ${a * 0.6})`; // Dark background, fades with alpha
  const badgeW = 300; // Badge width in pixels
  const badgeH = 60;  // Badge height in pixels
  ctx.beginPath();
  ctx.roundRect(cx - badgeW / 2, cy - badgeH / 2, badgeW, badgeH, 8); // Rounded rect
  ctx.fill(); // Draw dark badge

  // ── "MAX-Q" TEXT ──────────────────────────────────────────────────────────
  // Large bold yellow text. Yellow is used for callouts in aerospace (warning but not failure).
  ctx.font = "bold 42px monospace"; // Large, bold, monospace to match HUD style
  ctx.textAlign = "center"; // Center the text horizontally
  ctx.textBaseline = "middle"; // Center the text vertically

  // Subtle glow/shadow behind the text for depth.
  ctx.shadowColor = `rgba(255, 220, 0, ${a * 0.8})`; // Yellow glow
  ctx.shadowBlur = 12; // Soft glow radius

  ctx.fillStyle = `rgba(255, 220, 0, ${a})`; // Yellow text, fades with alpha
  ctx.fillText("MAX-Q", cx, cy); // Draw the callout text

  // ── SUBTITLE ─────────────────────────────────────────────────────────────
  // Small label explaining what Max-Q means — educational context for new players.
  ctx.font = `12px monospace`; // Smaller subtitle font
  ctx.fillStyle = `rgba(255, 200, 80, ${a * 0.7})`; // Softer yellow, slightly faded
  ctx.shadowBlur = 0; // No glow on subtitle
  ctx.fillText("MAX AERODYNAMIC PRESSURE", cx, cy + 26); // Subtitle below main text

  // ── RESTORE CONTEXT STATE ─────────────────────────────────────────────────
  // Reset shadow and text alignment so subsequent draw calls are not affected.
  ctx.shadowBlur = 0; // Clear shadow so it doesn't leak to other elements
  ctx.textAlign = "left"; // Reset text alignment to default (left)
  ctx.textBaseline = "alphabetic"; // Reset text baseline to default
}

// ─── WARNING BANNER ──────────────────────────────────────────────────────────

/**
 * Draw a red warning banner at the top of the canvas.
 * Used for engine failure alerts, aerodynamic heating warnings, and structural warnings.
 *
 * Shows a red background bar with the warning message in white/yellow text.
 * Multiple warnings queue and the most recent one is shown.
 *
 * @param ctx          Canvas 2D context.
 * @param canvasWidth  Canvas width in pixels.
 * @param message      Warning message to display (e.g., "⚠ ENGINE 3 FLAMEOUT").
 * @param alpha        Opacity 0–1 (caller fades this out as the warning timer counts down).
 * @param yOffset      Vertical offset for stacking multiple banners (0 = top banner).
 */
export function drawWarningBanner(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  message: string,  // The warning text to display
  alpha: number,    // Opacity: 1=fully visible, 0=invisible
  yOffset: number = 50 // Y position from top (50px = below the top control bar)
): void {
  // Clamp alpha to valid range.
  const a = Math.max(0, Math.min(1, alpha)); // 0–1

  // ── BACKGROUND BAR ────────────────────────────────────────────────────────
  // Dark red background bar spanning the full canvas width.
  // The red color immediately communicates "danger" to the player.
  ctx.fillStyle = `rgba(180, 10, 10, ${a * 0.85})`; // Dark red, semi-transparent
  const bannerH = 32; // Banner height in pixels
  ctx.fillRect(0, yOffset, canvasWidth, bannerH); // Span full width

  // Top and bottom accent lines for a polished look.
  ctx.fillStyle = `rgba(255, 80, 80, ${a * 0.8})`; // Bright red accent
  ctx.fillRect(0, yOffset, canvasWidth, 2);         // Top accent line
  ctx.fillRect(0, yOffset + bannerH - 2, canvasWidth, 2); // Bottom accent line

  // ── WARNING TEXT ──────────────────────────────────────────────────────────
  // White bold text centered vertically in the banner.
  ctx.font = "bold 14px monospace"; // Bold monospace matches the HUD style
  ctx.textAlign = "center"; // Center horizontally
  ctx.textBaseline = "middle"; // Center vertically

  // Subtle glow for urgency.
  ctx.shadowColor = `rgba(255, 100, 100, ${a * 0.6})`; // Red glow
  ctx.shadowBlur = 6; // Soft glow

  ctx.fillStyle = `rgba(255, 240, 240, ${a})`; // Near-white text
  ctx.fillText(message, canvasWidth / 2, yOffset + bannerH / 2); // Centered text

  // ── RESTORE CONTEXT ───────────────────────────────────────────────────────
  ctx.shadowBlur = 0;         // Clear shadow to prevent bleeding onto other elements
  ctx.textAlign = "left";     // Reset alignment
  ctx.textBaseline = "alphabetic"; // Reset baseline
}

// ─── STRUCTURAL FAILURE OVERLAY ──────────────────────────────────────────────

/**
 * Draw the "STRUCTURAL FAILURE" full-screen overlay.
 * Shown when structural integrity reaches 0% and the rocket breaks apart.
 *
 * WHAT STRUCTURAL FAILURE LOOKS LIKE IN REAL LIFE:
 *   During the 1986 Challenger disaster, aerodynamic forces after an SRB O-ring
 *   failure caused the external tank to breach and the vehicle broke apart at Max-Q
 *   (altitude: ~14 km, Mach ~1.9). The vehicle was not destroyed by explosion —
 *   it broke apart from aerodynamic loads, then the propellants dispersed.
 *   In more recent history, failures during high-dynamic-pressure flight are rare
 *   but illustrate why Max-Q management is critical.
 *
 * The overlay is drawn on top of everything else on the canvas.
 * A semi-transparent dark red tint fills the screen with large text.
 * The player can still hit Reset to try again.
 *
 * @param ctx          Canvas 2D context.
 * @param canvasWidth  Canvas width in pixels.
 * @param canvasHeight Canvas height in pixels.
 */
export function drawStructuralFailureOverlay(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number
): void {
  // ── DARK RED SCREEN TINT ──────────────────────────────────────────────────
  // A red-tinted overlay signals catastrophic failure without completely hiding the scene.
  ctx.fillStyle = "rgba(120, 0, 0, 0.55)"; // Semi-transparent dark red
  ctx.fillRect(0, 0, canvasWidth, canvasHeight); // Fill entire canvas

  // ── CENTER PANEL ─────────────────────────────────────────────────────────
  // Dark panel in the center with the failure message.
  const panelW = 460; // Panel width in pixels
  const panelH = 150; // Panel height in pixels
  const panelX = (canvasWidth - panelW) / 2; // Centered horizontally
  const panelY = (canvasHeight - panelH) / 2; // Centered vertically

  ctx.fillStyle = "rgba(15, 0, 0, 0.92)"; // Very dark red panel background
  ctx.beginPath();
  ctx.roundRect(panelX, panelY, panelW, panelH, 8); // Rounded corners
  ctx.fill(); // Draw panel

  ctx.strokeStyle = "#cc2222"; // Red border
  ctx.lineWidth = 2;
  ctx.stroke(); // Draw border

  // ── TITLE TEXT: "STRUCTURAL FAILURE" ─────────────────────────────────────
  ctx.textAlign = "center"; // Center all text
  ctx.textBaseline = "middle"; // Vertically centered

  // Glow effect for dramatic emphasis.
  ctx.shadowColor = "rgba(255, 0, 0, 0.8)"; // Red glow
  ctx.shadowBlur = 20; // Wide glow

  ctx.font = "bold 28px monospace"; // Large bold font
  ctx.fillStyle = "#ff3333"; // Bright red text
  ctx.fillText("STRUCTURAL FAILURE", canvasWidth / 2, panelY + 38); // Title line

  ctx.shadowBlur = 0; // Turn off glow for smaller text

  // ── SUBTITLE: "MAX-Q EXCEEDED — VEHICLE BREAK-UP" ────────────────────────
  ctx.font = "16px monospace"; // Smaller subtitle
  ctx.fillStyle = "#ffaaaa"; // Light red/pink text
  ctx.fillText("MAX-Q EXCEEDED — VEHICLE BREAK-UP", canvasWidth / 2, panelY + 72); // Subtitle

  // ── INSTRUCTION TEXT ─────────────────────────────────────────────────────
  // Prompt the player to reset and try again with a different flight profile.
  ctx.font = "13px monospace"; // Smallest text size
  ctx.fillStyle = "#ff8888"; // Lighter red
  ctx.fillText("Throttle back earlier or fly more prograde. Press ↺ Reset to try again.", canvasWidth / 2, panelY + 108); // Instruction

  // ── RESTORE CONTEXT ───────────────────────────────────────────────────────
  ctx.textAlign = "left"; // Reset to default
  ctx.textBaseline = "alphabetic"; // Reset to default
}
