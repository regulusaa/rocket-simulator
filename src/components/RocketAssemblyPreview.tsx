/**
 * ROCKET ASSEMBLY PREVIEW
 * =======================
 * Canvas-based React component that renders a real-time, proportionally accurate
 * 2D side-view of the user's assembled rocket.  Every time a part is added or
 * removed the canvas redraws instantly to reflect the new configuration.
 *
 * COORDINATE SYSTEM (HTML canvas convention):
 *   (0, 0) = top-left corner of the canvas.
 *   Y increases DOWNWARD.  The rocket is drawn from its ENGINE BOTTOM at the
 *   canvas bottom up to the NOSE CONE TIP at the top — so we start at a high
 *   Y value and decrement it as we stack parts upward.
 *
 * SCALING (proportional accuracy):
 *   pixelsPerMeter (ppm) = min(
 *     (canvasHeight * 0.80) / totalRocketHeightMeters,   ← height constraint
 *     (availableWidth * 0.65) / maxBodyDiameterMeters     ← width constraint
 *   )
 *   Each part's on-screen size = realDimensionMeters × ppm.
 *   Minimum on-screen height = MIN_PART_PX (15 px) — prevents tiny parts vanishing.
 *
 * ANIMATION SYSTEM:
 *   A requestAnimationFrame loop runs continuously.
 *   — During assembly (ghost pulsing) or flash/particle effects → 60 FPS
 *   — Otherwise (static rocket, no effects)                     → 30 FPS
 *   Static rendering is not cached: the canvas is small enough that a full
 *   redraw at 30 FPS costs negligible CPU.
 *
 * PART STACKING ORDER (bottom to top, matching real rockets):
 *   Engines → Tanks → (RCS on tank sides) → Interstage → (repeat for upper stages)
 *   → Nose Cone at the very top.
 *   Fins and Landing Legs extend OUTWARD from the base of Stage 1 — they do not
 *   add to the vertical stack height.
 */

import React, {
  useRef,
  useEffect,
  useCallback,
  useState,
} from "react";
// React and hooks: the component is a functional React component that uses
// refs (for the canvas), effects (for the animation loop), and state (for hover/select).

import type {
  AnyRocketPart,
  Engine,
  FuelTank,
  NoseCone,
  RCSThruster,
  Fin,
  InterstageAdapter,
  LandingLeg,
} from "../data/RocketPartsCatalog";
// Import every part type so the drawing functions can type-narrow using
// `part.category === 'engine'` discriminated union checks.

import type { BuildStage, AssemblyInProgress } from "./RocketBuilder";
// BuildStage and AssemblyInProgress are exported from RocketBuilder.tsx so both
// files share the exact same type definitions — no risk of structural drift.

// ─── LAYOUT PADDING CONSTANTS ─────────────────────────────────────────────────

const PAD_TOP = 28;
// px — empty space above the nose cone tip; leaves room for dimension text.

const PAD_BOTTOM = 18;
// px — empty space below the engine nozzle exits; represents the launch pad gap.

const PAD_LEFT = 58;
// px — reserved on the left side for stage labels (e.g., "— STAGE 1 —").

const PAD_RIGHT = 82;
// px — reserved on the right side for dimension annotations (height arrows).

const MIN_PART_PX = 15;
// px — minimum on-screen height for any part; ensures even tiny parts (e.g., a
// 0.6 m Rutherford engine) remain visible when the rocket is scaled down.

const INTERSTAGE_HEIGHT_M = 1.5;
// meters — visual height used for every InterstageAdapter in the stack.
// Real interstages are 1–3 m; 1.5 m is a good representative value since
// the catalog's InterstageAdapter type does not carry a `lengthM` field.

const RCS_VISUAL_HEIGHT_M = 0.4;
// meters — small visual height given to each RCS thruster row in the stack.
// RCS thrusters are actually mounted on the side of tanks (not in the stack),
// but we give them a tiny stack presence so the hover bounding box works.

const FLASH_DURATION_MS = 220;
// ms — how long the white "solidification flash" overlay lasts after a part is
// first installed; matches the welding-arc visual metaphor.

const PARTICLE_DURATION_MS = 500;
// ms — how long each connection-point particle lives before fading out.

const GHOST_PULSE_PERIOD_MS = 900;
// ms — time for one full opacity oscillation of the assembly ghost outline.
// At 900 ms the pulse is slow enough to read but fast enough to feel active.

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * On-screen bounding box for one drawn part, used for hover hit-testing and
 * overlay positioning.  Stored in a ref so it survives across animation frames
 * without triggering React re-renders.
 */
interface PartBBox {
  key: string;              // Unique key: "${partId}_${stageIndex}_${instanceIdx}"
  part: AnyRocketPart;      // Full part object — needed for the tooltip spec lines
  stageIndex: number;       // Which stage this part belongs to
  x: number;                // Canvas X of the bounding box left edge
  y: number;                // Canvas Y of the bounding box top edge
  w: number;                // Width in canvas pixels
  h: number;                // Height in canvas pixels
}

/** A single particle in the connection-point burst effect. */
interface Particle {
  x: number;    // Current canvas X position
  y: number;    // Current canvas Y position
  vx: number;   // Horizontal velocity (px/ms)
  vy: number;   // Vertical velocity (px/ms); negative = upward
  birth: number; // Date.now() when the particle was created
}

/** Per-stage layout information used when drawing stage dividers and labels. */
interface StageRange {
  stageIndex: number;
  topY: number;  // Canvas Y of the TOP edge of this stage's parts
  botY: number;  // Canvas Y of the BOTTOM edge of this stage's parts
}

// ─── PROPS ────────────────────────────────────────────────────────────────────

interface RocketAssemblyPreviewProps {
  stages: BuildStage[];
  // The current rocket configuration; changes trigger a re-render.

  assembly: AssemblyInProgress | null;
  // Non-null while a part is being installed; drives the ghost animation.

  assemblyProgress: number;
  // 0.0–1.0: filled fraction of the assembly bar; used only to choose
  // the ghost's "ASSEMBLING" text (already tracked in the parent).

  onRemovePart: (part: AnyRocketPart, stageIndex: number) => void;
  // Callback invoked when the user clicks "Remove" in the selection action menu.

  onRequestCatalogTab?: (tab: string) => void;
  // Optional callback: when "Replace" is clicked, this tells the parent to switch
  // the catalog panel to the matching category tab so the user can pick a replacement.
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Return the visual height (in meters) that a part contributes to the rocket stack.
 * Parts that extend OUTWARD (fins, landing legs) contribute 0 height to the stack;
 * they are drawn as outward extensions, not as vertical segments.
 */
function partHeightM(part: AnyRocketPart): number {
  switch (part.category) {
    case "engine":            return (part as Engine).lengthM;
    case "fuelTank":          return (part as FuelTank).lengthM;
    case "noseCone":          return (part as NoseCone).lengthM;
    case "rcsThruster":       return RCS_VISUAL_HEIGHT_M; // Small stack presence for bbox
    case "interstageAdapter": return INTERSTAGE_HEIGHT_M;
    case "fin":               return 0; // Fins extend outward; 0 vertical contribution
    case "landingLeg":        return 0; // Legs extend outward; 0 vertical contribution
  }
}

/**
 * Return the visual diameter (in meters) for a part.
 * For parts without an explicit diameter field, a reasonable default is returned.
 */
function partDiamM(part: AnyRocketPart): number {
  switch (part.category) {
    case "engine":            return (part as Engine).diameterM;
    case "fuelTank":          return (part as FuelTank).diameterM;
    case "noseCone":          return (part as NoseCone).diameterM;
    case "rcsThruster":       return 0.3;  // RCS pod diameter: small nub
    case "interstageAdapter": {
      const a = part as InterstageAdapter;
      return Math.max(a.topDiameterM, a.bottomDiameterM); // Widest face for scale calc
    }
    case "fin":               return 0;
    case "landingLeg":        return 0;
  }
}

/**
 * Format a number as "X.X m" for dimension annotations.
 * Keeps one decimal to avoid "10.0 m" looking cluttered.
 */
function fmtM(m: number): string {
  return m.toFixed(1) + " m";
}

/**
 * Format a mass value in kg or tonnes for tooltip display.
 */
function fmtKg(kg: number): string {
  if (kg >= 1000) return (kg / 1000).toFixed(1) + " t";
  return Math.round(kg) + " kg";
}

/**
 * Format a thrust in N / kN / MN.
 */
function fmtN(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + " MN";
  if (n >= 1000)      return (n / 1000).toFixed(0) + " kN";
  return Math.round(n) + " N";
}

/**
 * Build a tooltip spec string for the given part type.
 * Different categories show different fields; mirrors the prompt requirements.
 */
function buildSpecLines(part: AnyRocketPart): string[] {
  switch (part.category) {
    case "engine": {
      const e = part as Engine;
      return [
        `Thrust: ${fmtN(e.thrustSeaLevel)} (SL) / ${fmtN(e.thrustVacuum)} (vac)`,
        `Isp: ${e.specificImpulseSeaLevel}s (SL) / ${e.specificImpulseVacuum}s (vac)`,
        `Mass: ${fmtKg(e.mass)}  |  Propellant: ${e.propellant}`,
        `Throttleable: ${e.throttleable ? `${e.throttleRangeMin}–${e.throttleRangeMax}%` : "No"}  |  Restartable: ${e.restartable ? "Yes" : "No"}`,
      ];
    }
    case "fuelTank": {
      const t = part as FuelTank;
      return [
        `Capacity: ${fmtKg(t.capacityKg)}  |  Dry Mass: ${fmtKg(t.dryMassKg)}`,
        `Propellant: ${t.propellantType}  |  Material: ${t.material}`,
        `Size: ⌀ ${t.diameterM} m × ${t.lengthM} m tall`,
      ];
    }
    case "noseCone": {
      const n = part as NoseCone;
      return [
        `Mass: ${fmtKg(n.mass)}  |  Cd reduction: −${n.dragCoefficientReduction.toFixed(2)}`,
        `Material: ${n.material}`,
        `Payload cap: ${fmtKg(n.payloadCapacityKg)}  |  Size: ⌀ ${n.diameterM} m`,
      ];
    }
    case "rcsThruster": {
      const r = part as RCSThruster;
      return [
        `Thrust: ${fmtN(r.thrustN)}  |  Isp: ${r.specificImpulseS}s`,
        `Propellant: ${r.propellant}  |  Mass: ${fmtKg(r.mass)}`,
        `Included propellant: ${fmtKg(r.includedFuelMassKg)}`,
      ];
    }
    case "fin": {
      const f = part as Fin;
      return [
        `Mass: ${fmtKg(f.mass)} (set of ${f.setOf})`,
        `Material: ${f.material}  |  Controllable: ${f.controllable ? "Yes" : "No"}`,
        `Stability: +${(f.stabilityContribution * 100).toFixed(0)}%  |  Drag penalty: +${f.dragPenalty.toFixed(3)} Cd`,
      ];
    }
    case "interstageAdapter": {
      const a = part as InterstageAdapter;
      return [
        `Mass: ${fmtKg(a.mass)}  |  Material: ${a.material}`,
        `Top ⌀: ${a.topDiameterM} m  |  Bottom ⌀: ${a.bottomDiameterM} m`,
      ];
    }
    case "landingLeg": {
      const l = part as LandingLeg;
      return [
        `Mass: ${fmtKg(l.mass)} (set of ${l.setOf})`,
        `Shock absorption: ${(l.shockAbsorptionJ / 1000).toFixed(0)} kJ`,
        `Deployable: ${l.deployable ? "Yes" : "No"}`,
      ];
    }
  }
}

// ─── DRAWING HELPERS ──────────────────────────────────────────────────────────

/**
 * Draw a rounded rectangle path on the canvas context.
 * Used for tank dome ends and general rounded shapes.
 * We implement this manually because Canvas 2D's `roundRect` has limited browser support.
 *
 * @param ctx     2D rendering context
 * @param x, y    Top-left corner
 * @param w, h    Width and height
 * @param r       Corner radius in px (clamped to half of min(w,h))
 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const clampR = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  // Clamp radius so it never exceeds half the smaller dimension — prevents NaN paths.

  ctx.beginPath();
  ctx.moveTo(x + clampR, y);                              // Start at top-left arc end
  ctx.lineTo(x + w - clampR, y);                          // Top edge
  ctx.arcTo(x + w, y,     x + w, y + clampR,     clampR); // Top-right corner arc
  ctx.lineTo(x + w, y + h - clampR);                      // Right edge
  ctx.arcTo(x + w, y + h, x + w - clampR, y + h, clampR); // Bottom-right corner arc
  ctx.lineTo(x + clampR, y + h);                          // Bottom edge
  ctx.arcTo(x,     y + h, x,     y + h - clampR, clampR); // Bottom-left corner arc
  ctx.lineTo(x,     y + clampR);                          // Left edge
  ctx.arcTo(x,     y,     x + clampR, y,          clampR); // Top-left corner arc
  ctx.closePath();
}

/**
 * Draw one engine bell nozzle at the given bounding box.
 *
 * Visual structure:
 *   ┌────┐  ← Combustion chamber: narrow rectangle at top of bbox
 *   │    │
 *  /      \  ← Bell nozzle: trapezoid flaring from chamber width at top
 * /        \    to full bbox width at bottom
 * ──────────  ← Nozzle exit plane (bottom of bbox)
 *
 * WHY A TRAPEZOID: Real rocket nozzles are truncated cones (bells).
 * In side-view 2D, a cone becomes a trapezoid — narrow at the combustion
 * chamber throat and wide at the nozzle exit plane where thrust is generated.
 *
 * @param ctx       2D context
 * @param bx, by    Bounding box top-left corner
 * @param bw, bh    Bounding box width and height
 * @param cx        Center X of the engine (for symmetry)
 * @param highlight True = draw with cyan highlight border for hover/select
 * @param isSelect  True = thicker cyan border for click-selected state
 */
function drawEngine(
  ctx: CanvasRenderingContext2D,
  _bx: number, by: number, bw: number, bh: number, cx: number,
  highlight: boolean, isSelect: boolean,
): void {
  const chamberW = Math.max(bw * 0.38, 4);
  // Combustion chamber width = 38% of nozzle exit width.
  // The chamber is narrower because propellant combustion happens under high pressure
  // in a small volume before expanding through the nozzle.

  const chamberH = Math.max(bh * 0.22, 4);
  // Chamber height = top 22% of the engine bounding box.

  const chamberX = cx - chamberW / 2;
  // Center the chamber horizontally within the engine bounding box.

  // ── Combustion chamber body ────────────────────────────────────────────────
  ctx.fillStyle = "#4a4a4a";
  // Dark grey for the outer wall of the combustion chamber.
  roundRect(ctx, chamberX, by, chamberW, chamberH, 2);
  ctx.fill();

  // ── Bell nozzle (trapezoid) ────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(chamberX,              by + chamberH);    // Top-left of trap (chamber left)
  ctx.lineTo(chamberX + chamberW,   by + chamberH);    // Top-right of trap (chamber right)
  ctx.lineTo(cx + bw / 2,           by + bh);           // Bottom-right at nozzle exit
  ctx.lineTo(cx - bw / 2,           by + bh);           // Bottom-left at nozzle exit
  ctx.closePath();
  ctx.fillStyle = "#555555";
  // Medium dark grey for the nozzle wall exterior.
  ctx.fill();

  // ── Inner nozzle surface (lighter, simulates depth / interior view) ────────
  const innerInset = Math.max(bw * 0.06, 2);
  // Inset from the outer nozzle wall to show the internal expansion surface.

  ctx.beginPath();
  ctx.moveTo(chamberX + 2,             by + chamberH + 2); // Slightly inside top-left
  ctx.lineTo(chamberX + chamberW - 2,  by + chamberH + 2); // Slightly inside top-right
  ctx.lineTo(cx + bw / 2 - innerInset, by + bh - 1);       // Inside bottom-right
  ctx.lineTo(cx - bw / 2 + innerInset, by + bh - 1);       // Inside bottom-left
  ctx.closePath();
  ctx.fillStyle = "#777777";
  // Lighter grey = interior nozzle surface is hotter and reflects more light.
  ctx.fill();

  // ── Nozzle outline ──────────────────────────────────────────────────────────
  ctx.strokeStyle = isSelect ? "#00FFFF" : highlight ? "#00DDDD" : "rgba(255,255,255,0.6)";
  // Cyan border when hovered/selected to provide visual feedback.
  ctx.lineWidth = isSelect ? 2.5 : highlight ? 1.5 : 0.8;
  // Thicker border when selected so the selection is clearly visible.

  ctx.beginPath();
  ctx.moveTo(chamberX,            by + chamberH);
  ctx.lineTo(chamberX + chamberW, by + chamberH);
  ctx.lineTo(cx + bw / 2,         by + bh);
  ctx.lineTo(cx - bw / 2,         by + bh);
  ctx.closePath();
  ctx.stroke();

  // ── Gimbal mount (small circle at top of engine) ───────────────────────────
  // The gimbal is the pivoting joint that lets the engine rotate for steering.
  // It's always at the TOP of the engine where it attaches to the stage structure.
  const gimbalR = Math.max(Math.min(chamberW * 0.18, 4), 2);
  ctx.beginPath();
  ctx.arc(cx, by + gimbalR + 1, gimbalR, 0, Math.PI * 2);
  ctx.fillStyle = "#888888";
  // Mid-grey gimbal ring — darker than chamber to distinguish components.
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

/**
 * Draw a fuel tank (cylindrical pressure vessel with domed ends).
 *
 * Visual structure:
 *    ___
 *   (   )  ← Top dome: semi-ellipse curving upward (pressure vessel end cap)
 *   |   |
 *   |---| ← Weld seam line at 1/3 height (structural manufacturing joint)
 *   |:::| ← Propellant fill level indicator (semi-transparent colored band)
 *   |---| ← Weld seam line at 2/3 height
 *   |   |
 *   (   )  ← Bottom dome: semi-ellipse curving downward
 *
 * WHY DOMED ENDS: Real fuel tanks are pressure vessels.  The cylindrical
 * mid-section handles hoop stress; the domed end caps distribute the axial
 * pressure load without stress concentrations at flat corners.
 *
 * COLOR CODING by propellant:
 *   LOX/RP-1  → silver-grey (#C0C0C0) with orange tint (kerosene hue)
 *   LOX/LH2   → white (#E8E8E8) with blue tint (hydrogen "frosty" appearance)
 *   LOX/CH4   → light grey (#D0D0D0) with green tint (methane)
 *   LOX/LNG   → cream (#D8CCBB) with amber tint (LNG color)
 *   other     → neutral grey (#CCCCCC)
 */
function drawFuelTank(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number, bw: number, bh: number, cx: number,
  tank: FuelTank,
  highlight: boolean, isSelect: boolean,
): void {
  const domeH = Math.max(bh * 0.12, 5);
  // Dome height = 12% of tank total height.  Real tank domes are hemispherical or
  // ellipsoidal; 12% is a visually convincing ratio for 2D side-view.

  const bodyY  = by + domeH;
  // Y coordinate where the cylindrical body starts (just below the top dome).

  const bodyH  = bh - domeH * 2;
  // Height of the straight cylindrical section (total minus both dome heights).

  // ── Choose fill color based on propellant type ─────────────────────────────
  let tankColor = "#CCCCCC"; // Default neutral grey
  let tintColor = "transparent"; // Tint overlay drawn on top of the body
  if (tank.propellantType === "LOX/RP-1") {
    tankColor = "#C4C4C4"; // Silver-grey for kerolox
    tintColor = "rgba(200,120,40,0.12)"; // Subtle orange tint: RP-1 is orange-tinted
  } else if (tank.propellantType === "LOX/LH2") {
    tankColor = "#E8E8E8"; // Near-white: LH2 tanks are heavily insulated (white foam)
    tintColor = "rgba(80,140,220,0.10)"; // Blue tint: liquid hydrogen appears blue
  } else if (tank.propellantType === "LOX/CH4") {
    tankColor = "#D4D4D4"; // Light grey for methalox
    tintColor = "rgba(60,180,80,0.09)"; // Green tint: methane gas association
  } else if (tank.propellantType === "LOX/LNG") {
    tankColor = "#D6CCBA"; // Warm cream: LNG has amber/cream appearance
    tintColor = "rgba(180,130,40,0.10)"; // Amber tint: LNG contains heavier hydrocarbons
  }

  // ── Main cylindrical body ──────────────────────────────────────────────────
  ctx.fillStyle = tankColor;
  ctx.fillRect(bx, bodyY, bw, bodyH);
  // Simple rectangle for the straight section; domes added on top.

  // ── Propellant tint overlay ────────────────────────────────────────────────
  if (tintColor !== "transparent") {
    ctx.fillStyle = tintColor;
    ctx.fillRect(bx, bodyY, bw, bodyH);
    // Draw the tint over the body to subtly color it by propellant type.
  }

  // ── Top dome (semi-ellipse curving upward) ─────────────────────────────────
  ctx.beginPath();
  ctx.ellipse(
    cx, bodyY,              // Center of the ellipse is at the top of the body
    bw / 2, domeH,          // Half-axes: half the tank width and dome height
    0,                      // No rotation
    Math.PI, 0,             // Draw only the upper half (from π to 0 = upward arc)
    false,                  // Counterclockwise? No — draw upper semicircle
  );
  ctx.fillStyle = tankColor;
  ctx.fill();
  if (tintColor !== "transparent") {
    ctx.fillStyle = tintColor;
    ctx.beginPath();
    ctx.ellipse(cx, bodyY, bw / 2, domeH, 0, Math.PI, 0, false);
    ctx.fill();
  }

  // ── Bottom dome (semi-ellipse curving downward) ────────────────────────────
  ctx.beginPath();
  ctx.ellipse(
    cx, bodyY + bodyH,      // Center is at the bottom edge of the body section
    bw / 2, domeH,
    0,
    0, Math.PI,             // Draw lower half (from 0 to π = downward arc)
    false,
  );
  ctx.fillStyle = tankColor;
  ctx.fill();
  if (tintColor !== "transparent") {
    ctx.fillStyle = tintColor;
    ctx.beginPath();
    ctx.ellipse(cx, bodyY + bodyH, bw / 2, domeH, 0, 0, Math.PI, false);
    ctx.fill();
  }

  // ── Weld seam panel lines ──────────────────────────────────────────────────
  // Horizontal lines at 1/3 and 2/3 of the body height represent manufacturing
  // weld seams where separate tank sections are joined.  Real tanks like Falcon 9's
  // Al-Li tanks have visible horizontal ring welds at barrel section joints.
  if (bodyH > 20) {
    // Only draw seams if the body is tall enough to show them without crowding.
    ctx.strokeStyle = "rgba(180,180,180,0.4)"; // Subtle grey line
    ctx.lineWidth = 0.7;
    const seam1Y = bodyY + bodyH * 0.33; // 1/3 up from body bottom
    const seam2Y = bodyY + bodyH * 0.67; // 2/3 up from body bottom
    ctx.beginPath(); ctx.moveTo(bx, seam1Y); ctx.lineTo(bx + bw, seam1Y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx, seam2Y); ctx.lineTo(bx + bw, seam2Y); ctx.stroke();
  }

  // ── Propellant fill indicator ──────────────────────────────────────────────
  // Show a semi-transparent colored band representing the propellant level.
  // At assembly time the tank is 100% full; this is just a static visual.
  const fillH = bodyH * 0.9; // 90% filled level (top 10% is ullage/pressurant)
  const fillColor =
    tank.propellantType === "LOX/RP-1" ? "rgba(200,100,30,0.18)"  :
    tank.propellantType === "LOX/LH2"  ? "rgba(80,140,230,0.15)"  :
    tank.propellantType === "LOX/CH4"  ? "rgba(50,170,70,0.15)"   :
    tank.propellantType === "LOX/LNG"  ? "rgba(180,120,30,0.15)"  :
    "rgba(150,150,150,0.15)";
  ctx.fillStyle = fillColor;
  ctx.fillRect(bx + 1, bodyY + (bodyH - fillH), bw - 2, fillH);
  // Inset 1 px from edges so the fill doesn't overlap the tank border.

  // ── Tank outline ───────────────────────────────────────────────────────────
  // Draw the full tank outline (body + domes) as a single continuous path.
  ctx.beginPath();
  ctx.moveTo(bx, bodyY);           // Top-left of body
  ctx.lineTo(bx + bw, bodyY);      // Top-right of body
  ctx.lineTo(bx + bw, bodyY + bodyH); // Bottom-right of body
  // Bottom dome arc (right to left, going downward):
  ctx.arc(cx, bodyY + bodyH, bw / 2, 0, Math.PI, false);
  ctx.lineTo(bx, bodyY);           // Close with left side
  ctx.strokeStyle = isSelect ? "#00FFFF" : highlight ? "#00DDDD" : "rgba(200,200,200,0.5)";
  ctx.lineWidth = isSelect ? 2.5 : highlight ? 1.5 : 0.8;
  ctx.stroke();

  // Draw top dome outline separately (arc path above the body):
  ctx.beginPath();
  ctx.moveTo(bx, bodyY);
  ctx.arc(cx, bodyY, bw / 2, Math.PI, 0, false); // Upper arc
  ctx.lineTo(bx + bw, bodyY);
  ctx.strokeStyle = isSelect ? "#00FFFF" : highlight ? "#00DDDD" : "rgba(200,200,200,0.5)";
  ctx.lineWidth = isSelect ? 2.5 : highlight ? 1.5 : 0.8;
  ctx.stroke();

  // ── Pipe connectors ────────────────────────────────────────────────────────
  // Small filled circles at top and bottom center of tank indicating propellant
  // feed/fill lines.  Real tanks have multiple valves; we show one each side.
  const pipeR = Math.max(bw * 0.045, 2);
  ctx.fillStyle = "#666666"; // Dark grey pipe fitting
  // Top connector:
  ctx.beginPath(); ctx.arc(cx, by, pipeR, 0, Math.PI * 2); ctx.fill();
  // Bottom connector:
  ctx.beginPath(); ctx.arc(cx, by + bh, pipeR, 0, Math.PI * 2); ctx.fill();
}

/**
 * Draw a nose cone / payload fairing using a bezier ogive profile.
 *
 * Visual structure (side-view):
 *    *         ← Tip: pointed (small ogive) or blunt (large fairing)
 *   / \
 *  /   \       ← Bezier curve sides giving the ogive shape
 * /     \
 * ───────     ← Base: matches the stage width below
 *
 * WHY BEZIER: Real nose cones follow an ogive curve (arc from a circle whose
 * radius is much larger than the cone length) to minimise wave drag.
 * A quadratic Bézier between the tip and each shoulder approximates this
 * shape with a single control point.
 *
 * @param sharpness  0.0–1.0: higher = more pointed tip (taller control point).
 *                   Small ogive → 0.85, medium fairing → 0.65, large fairing → 0.5
 */
function drawNoseCone(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number, bw: number, bh: number, cx: number,
  sharpness: number,
  highlight: boolean, isSelect: boolean,
): void {
  const tipX  = cx;                // Tip is always centered horizontally
  const tipY  = by;                // Tip is at the very top of the bounding box
  const baseL = bx;                // Left edge of the base
  const baseR = bx + bw;          // Right edge of the base
  const baseY = by + bh;          // Y of the base (bottom of nose cone)

  // Control point for the Bézier curve: the higher the sharpness, the closer
  // the control point is to the tip, producing a more pointed profile.
  const cpY = by + bh * (1 - sharpness);
  // When sharpness=1.0, cpY=by (control at tip → sharp linear sides).
  // When sharpness=0.5, cpY=by+bh*0.5 (control at midpoint → rounder sides).

  // ── Fairing body fill ──────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);                    // Start at the tip
  ctx.quadraticCurveTo(baseR, cpY, baseR, baseY); // Right side: ogive curve
  ctx.lineTo(baseL, baseY);                  // Base line (bottom)
  ctx.quadraticCurveTo(baseL, cpY, tipX, tipY);   // Left side: mirror curve
  ctx.closePath();

  // Color: white for fairings (as they are in real life — white thermal coating)
  ctx.fillStyle = "#F0F0F0";
  ctx.fill();

  // ── Horizontal stripe pattern (two alternating white/off-white bands) ──────
  // Real payload fairings have horizontal reference bands painted on them for
  // optical tracking and roll reference during flight.
  if (bh > 30) {
    // Only draw stripes if the nose cone is tall enough to show them.
    ctx.fillStyle = "rgba(200,200,200,0.25)"; // Slightly darker off-white band
    const stripe1Y = by + bh * 0.3;
    const stripe2Y = by + bh * 0.6;
    const stripeH  = bh * 0.15;

    // For each stripe: clip to the nose cone shape by redrawing the path.
    // We draw the stripe as a horizontal rect clipped to the nose cone path.
    ctx.save();
    ctx.clip(); // Clips to the last path (nose cone outline)
    ctx.fillRect(bx, stripe1Y, bw, stripeH);
    ctx.fillRect(bx, stripe2Y, bw, stripeH);
    ctx.restore();
  }

  // ── Separation line at base ────────────────────────────────────────────────
  // The fairing separates horizontally at this line during flight (~110 km).
  // The dashed line indicates the split/release interface.
  ctx.setLineDash([3, 3]); // 3 px dash, 3 px gap
  ctx.strokeStyle = "rgba(150,150,150,0.5)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(bx, baseY - 3);       // 3 px above the true base (the ring release point)
  ctx.lineTo(bx + bw, baseY - 3);
  ctx.stroke();
  ctx.setLineDash([]); // Reset dash to solid for subsequent drawing calls

  // ── Faint payload silhouette ───────────────────────────────────────────────
  // Suggests that the fairing encloses a satellite or spacecraft payload.
  if (bh > 20) {
    const payW = bw * 0.35; // Payload icon width = 35% of fairing base
    const payH = bh * 0.35; // Payload height = 35% of fairing height
    const payX = cx - payW / 2;
    const payY = baseY - payH - bh * 0.08; // Position near the base of the fairing
    ctx.strokeStyle = "rgba(120,180,220,0.25)"; // Faint blue — satellite color
    ctx.lineWidth = 0.6;
    ctx.strokeRect(payX, payY, payW, payH); // Satellite bus rectangle
    // Solar panel wings:
    ctx.beginPath();
    ctx.moveTo(payX - payW * 0.3, payY + payH * 0.4);
    ctx.lineTo(payX, payY + payH * 0.4);
    ctx.moveTo(payX + payW, payY + payH * 0.4);
    ctx.lineTo(payX + payW + payW * 0.3, payY + payH * 0.4);
    ctx.stroke();
  }

  // ── Nose cone outline ──────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.quadraticCurveTo(baseR, cpY, baseR, baseY);
  ctx.lineTo(baseL, baseY);
  ctx.quadraticCurveTo(baseL, cpY, tipX, tipY);
  ctx.closePath();
  ctx.strokeStyle = isSelect ? "#00FFFF" : highlight ? "#00DDDD" : "rgba(180,180,180,0.7)";
  ctx.lineWidth = isSelect ? 2.5 : highlight ? 1.5 : 0.9;
  ctx.stroke();
}

/**
 * Draw a small RCS thruster nub on the SIDE of the rocket body.
 *
 * RCS thrusters are not part of the vertical stack — they're mounted on the
 * tank sides and fire perpendicular to the rocket axis for attitude control.
 * We draw them as small rectangular pods with a tiny nozzle cone pointing outward.
 *
 * @param side  "left" or "right" — which side of the rocket body to attach to
 */
function drawRCSThruster(
  ctx: CanvasRenderingContext2D,
  tankBx: number, _tankY: number, tankW: number, tankH: number,
  rcsY: number,          // Y center of this RCS thruster in the stack
  side: "left" | "right",
  highlight: boolean, isSelect: boolean,
): void {
  const podW = Math.max(tankW * 0.14, 6);   // Pod width = 14% of tank width
  const podH = Math.max(tankH * 0.14, 4);   // Pod height = 14% of tank height (visual)
  const nozzleH = podH * 0.5;             // Nozzle length sticking outward

  const bodyEdgeX = side === "left" ? tankBx : tankBx + tankW;
  // X coordinate of the tank edge where the RCS pod attaches.

  const podX = side === "left"
    ? bodyEdgeX - podW               // Pod hangs off the left side
    : bodyEdgeX;                     // Pod hangs off the right side

  const podY = rcsY - podH / 2;     // Center the pod vertically at rcsY

  // ── Pod body ───────────────────────────────────────────────────────────────
  ctx.fillStyle = "#444444"; // Dark grey RCS pod housing
  ctx.fillRect(podX, podY, podW, podH);

  // ── Nozzle cone (pointing outward from rocket body) ────────────────────────
  if (side === "left") {
    // Left side: nozzle points LEFT (exits from the pod's left edge)
    ctx.beginPath();
    ctx.moveTo(podX,           podY + podH * 0.25);      // Pod left top attachment
    ctx.lineTo(podX,           podY + podH * 0.75);      // Pod left bottom attachment
    ctx.lineTo(podX - nozzleH, podY + podH / 2);         // Nozzle exit tip (pointing left)
    ctx.closePath();
    ctx.fillStyle = "#555555";
    ctx.fill();
  } else {
    // Right side: nozzle points RIGHT
    ctx.beginPath();
    ctx.moveTo(podX + podW,           podY + podH * 0.25);
    ctx.lineTo(podX + podW,           podY + podH * 0.75);
    ctx.lineTo(podX + podW + nozzleH, podY + podH / 2);  // Nozzle exit tip (pointing right)
    ctx.closePath();
    ctx.fillStyle = "#555555";
    ctx.fill();
  }

  // ── Pod outline ────────────────────────────────────────────────────────────
  ctx.strokeStyle = isSelect ? "#00FFFF" : highlight ? "#00DDDD" : "rgba(150,150,150,0.5)";
  ctx.lineWidth = isSelect ? 2 : highlight ? 1.2 : 0.5;
  ctx.strokeRect(podX, podY, podW, podH);
}

/**
 * Draw an interstage adapter between two stages.
 *
 * Visual: a trapezoid (frustum cross-section) connecting the lower stage's
 * full width at the bottom to the upper stage's (potentially narrower) width at top.
 *
 * Real interstage adapters are conical or cylindrical aluminum/CFRP structures
 * that carry the compressive loads between stages and house the separation bolts.
 */
function drawInterstage(
  ctx: CanvasRenderingContext2D,
  cx: number, topY: number, botY: number,
  topW: number, botW: number,           // widths in pixels
  highlight: boolean, isSelect: boolean,
): void {
  const h = botY - topY; // Height in pixels (negative if drawing upward — use abs)

  ctx.beginPath();
  ctx.moveTo(cx - topW / 2, topY);  // Top-left
  ctx.lineTo(cx + topW / 2, topY);  // Top-right
  ctx.lineTo(cx + botW / 2, botY);  // Bottom-right
  ctx.lineTo(cx - botW / 2, botY);  // Bottom-left
  ctx.closePath();

  ctx.fillStyle = "#3a3a3a"; // Darker grey than tank — interstages are bare metal/CFRP
  ctx.fill();

  // ── Bolt rings (thin white lines at top and bottom edges) ──────────────────
  // In real rockets, the separation bolt ring is clearly visible as a
  // thin metal flange at each end of the interstage.
  if (h > 4) {
    // Only draw if tall enough to show the lines without them crowding.
    ctx.strokeStyle = "rgba(220,220,220,0.5)"; // White-ish bolt ring
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - topW / 2, topY + 2); ctx.lineTo(cx + topW / 2, topY + 2);
    ctx.moveTo(cx - botW / 2, botY - 2); ctx.lineTo(cx + botW / 2, botY - 2);
    ctx.stroke();
  }

  // ── Interstage outline ─────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(cx - topW / 2, topY);
  ctx.lineTo(cx + topW / 2, topY);
  ctx.lineTo(cx + botW / 2, botY);
  ctx.lineTo(cx - botW / 2, botY);
  ctx.closePath();
  ctx.strokeStyle = isSelect ? "#00FFFF" : highlight ? "#00DDDD" : "rgba(160,160,160,0.4)";
  ctx.lineWidth = isSelect ? 2.5 : highlight ? 1.5 : 0.7;
  ctx.stroke();
}

/**
 * Draw a set of aerodynamic fins at the base of stage 1.
 *
 * In side-view, we see 2 fins — one on each side.  Each fin is a triangle:
 *   - Root (long edge): along the rocket body
 *   - Tip: extends outward and downward at an angle
 *
 * Grid fins (titanium, controllable): drawn with a crosshatch pattern.
 * Carbon fiber and aluminum fins: drawn as solid triangles.
 */
function drawFins(
  ctx: CanvasRenderingContext2D,
  cx: number, stageTopY: number, stageBotY: number, stageWidthPx: number,
  fin: Fin,
  highlight: boolean, isSelect: boolean,
): void {
  const finH = Math.max((stageBotY - stageTopY) * 0.55, 12);
  // Fin height (root length along the body) = 55% of stage height, min 12 px.

  const finSpan = stageWidthPx * 0.55;
  // Fin span (how far it extends outward) = 55% of stage width.

  const rootTopY = stageBotY - finH;  // Top of the fin root (attachment point)
  const rootBotY = stageBotY;         // Bottom of the fin root (matches stage bottom)

  // Choose fin color based on material:
  const finColor =
    fin.material.toLowerCase().includes("titanium") ? "#888888" :
    fin.material.toLowerCase().includes("carbon")   ? "#333333" :
    "#A0A0A0"; // Default aluminum color

  for (const side of ["left", "right"] as const) {
    const dir = side === "left" ? -1 : 1;
    // dir = -1 for left (outward = negative X), +1 for right

    const rootEdgeX = cx + dir * stageWidthPx / 2;
    // X coordinate where the fin root meets the rocket body edge.

    const tipX = cx + dir * (stageWidthPx / 2 + finSpan);
    // X coordinate of the fin tip — how far outward it extends.

    const tipY = stageBotY - finH * 0.1;
    // Y of fin tip: very slightly above the absolute bottom, giving a swept appearance.

    // ── Main fin triangle ──────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(rootEdgeX, rootTopY);   // Top of root attachment
    ctx.lineTo(tipX,      tipY);       // Fin tip (outermost point)
    ctx.lineTo(rootEdgeX, rootBotY);   // Bottom of root attachment
    ctx.closePath();

    ctx.fillStyle = finColor;
    ctx.fill();

    // ── Grid fin crosshatch (titanium grid fins only) ──────────────────────
    // Grid fins (like Falcon 9's) have an open-lattice structure that allows
    // airflow through them while providing aerodynamic surface area.
    if (fin.material.toLowerCase().includes("titanium") && fin.controllable) {
      ctx.save();
      ctx.clip(); // Clip crosshatch to the fin triangle shape

      ctx.strokeStyle = "rgba(180,180,180,0.4)";
      ctx.lineWidth = 0.5;
      // Draw horizontal grid lines across the fin:
      const gridStep = Math.max(finSpan / 6, 4); // 6 cells across, min 4px spacing
      for (let gx = 0; gx < finSpan + gridStep; gx += gridStep) {
        const gLineX = rootEdgeX + dir * gx;
        ctx.beginPath(); ctx.moveTo(gLineX, rootTopY); ctx.lineTo(gLineX, rootBotY); ctx.stroke();
      }
      for (let gy = 0; gy < finH + gridStep; gy += gridStep) {
        const gLineY = rootTopY + gy;
        ctx.beginPath(); ctx.moveTo(rootEdgeX, gLineY); ctx.lineTo(tipX, gLineY); ctx.stroke();
      }
      ctx.restore();
    }

    // ── Fin outline ──────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(rootEdgeX, rootTopY);
    ctx.lineTo(tipX,      tipY);
    ctx.lineTo(rootEdgeX, rootBotY);
    ctx.closePath();
    ctx.strokeStyle = isSelect ? "#00FFFF" : highlight ? "#00DDDD" : "rgba(180,180,180,0.4)";
    ctx.lineWidth = isSelect ? 2 : highlight ? 1.2 : 0.7;
    ctx.stroke();

    // ── Faint "×2 more behind" indicator ────────────────────────────────────
    // In 2D side-view we see 2 of the 4 fins; a lighter version behind indicates
    // the additional fins.
    const behindX = cx + dir * (stageWidthPx / 2 + finSpan * 0.8);
    ctx.globalAlpha = 0.25; // Very faint — represents unseen fins
    ctx.beginPath();
    ctx.moveTo(rootEdgeX, rootTopY + finH * 0.1);
    ctx.lineTo(behindX,   tipY + 2);
    ctx.lineTo(rootEdgeX, rootBotY - 2);
    ctx.closePath();
    ctx.fillStyle = finColor;
    ctx.fill();
    ctx.globalAlpha = 1.0; // Restore full opacity
  }
}

/**
 * Draw a set of landing legs at the base of stage 1.
 *
 * Structure: each leg is a V-shaped strut pair:
 *   - Upper strut: from the rocket body outward and downward
 *   - Lower strut: from the foot pad meeting the upper strut
 *   - Foot pad: small horizontal rectangle at the ground contact point
 *
 * In side-view we show 2 legs (one each side); "×4" label indicates total count.
 */
function drawLandingLegs(
  ctx: CanvasRenderingContext2D,
  cx: number, stageTopY: number, stageBotY: number, stageWidthPx: number,
  highlight: boolean, isSelect: boolean,
): void {
  const legSpan = stageWidthPx * 0.80;
  // How far each leg extends outward from the rocket body center.

  const legH = Math.max((stageBotY - stageTopY) * 0.65, 14);
  // Height of each leg from attachment point to foot.

  const strutColor = isSelect ? "#00FFFF" : highlight ? "#00DDDD" : "#666666";
  // Strut color changes for hover/select feedback.

  for (const side of ["left", "right"] as const) {
    const dir = side === "left" ? -1 : 1;

    const attachX = cx + dir * stageWidthPx / 2;
    // X where the upper strut attaches to the rocket body (mid-height of stage base area).

    const attachY = stageBotY - legH * 0.1;
    // Y attachment point: near the bottom of the stage.

    const footX = cx + dir * (stageWidthPx / 2 + legSpan / 2);
    // X of the foot pad: outward from the attachment point by half legSpan.

    const footY = stageBotY + legH * 0.4;
    // Y of the foot pad: below the stage bottom (below the engine nozzle exits).

    const kinkX = cx + dir * (stageWidthPx / 2 + legSpan * 0.3);
    // X of the V-kink: where upper and lower struts meet.

    const kinkY = stageBotY + legH * 0.15;
    // Y of the V-kink: slightly below the stage bottom.

    // ── Upper strut (from body to kink) ────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(attachX, attachY);
    ctx.lineTo(kinkX,   kinkY);
    ctx.strokeStyle = strutColor;
    ctx.lineWidth = isSelect ? 2 : 1.5;
    ctx.stroke();

    // ── Lower strut (from kink to foot) ────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(kinkX, kinkY);
    ctx.lineTo(footX, footY);
    ctx.strokeStyle = strutColor;
    ctx.lineWidth = isSelect ? 2 : 1.5;
    ctx.stroke();

    // ── Foot pad (small horizontal rectangle) ──────────────────────────────
    const padW = Math.max(stageWidthPx * 0.14, 6);
    // Pad width = 14% of stage width; min 6 px.

    const padH = 3; // Foot pad height: 3 px flat horizontal rectangle
    ctx.fillStyle = "#FF8800";
    // Orange foot pad — matches Falcon 9's orange aluminum honeycomb crush cores.
    ctx.fillRect(footX - padW / 2, footY, padW, padH);
    ctx.strokeStyle = "rgba(255,200,50,0.6)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(footX - padW / 2, footY, padW, padH);
  }

  // ── ×4 count label ──────────────────────────────────────────────────────────
  // We show 2 legs in side-view but indicate 4 total (standard for stability).
  ctx.font = "8px monospace";
  ctx.fillStyle = "rgba(180,180,180,0.5)";
  ctx.textAlign = "center";
  ctx.fillText("×4", cx, stageBotY + 8);
}

// ─── LAYOUT COMPUTATION ───────────────────────────────────────────────────────

/**
 * Walk the stage array bottom-to-top and compute the canvas position of every
 * part.  Returns:
 *   - layouts: array of PartBBox for each part (used for hit-testing and drawing)
 *   - ppm: pixels per meter (the computed scale factor)
 *   - rocketHeightM: total rocket height in meters
 *   - stageRanges: per-stage top/bottom Y for stage labels and tints
 *   - rocketWidthPx: width of the widest stage in pixels
 */
function computeLayout(
  stages: BuildStage[],
  canvasW: number,
  canvasH: number,
): {
  layouts: PartBBox[];
  ppm: number;
  rocketHeightM: number;
  stageRanges: StageRange[];
  rocketWidthPx: number;
} {
  // ── Step 1: measure total rocket height and max diameter in meters ──────────

  let totalHeightM = 0;
  // Accumulate the height of every part that contributes to the stack.

  let maxDiamM = 0.5;
  // The widest diameter determines how wide the rocket body appears on screen.
  // Start at 0.5 m so even a rocket with no parts has a non-zero scale.

  for (const stage of stages) {
    // Engine height contribution: engines are SIDE BY SIDE (one row), so the
    // stage engine height = the tallest single engine (not sum of all engines).
    const maxEngH = stage.engines.reduce((m, e) => Math.max(m, e.lengthM), 0);
    totalHeightM += maxEngH;

    // All engines in the cluster share the same height slot, but the widest
    // engine affects the total body diameter:
    for (const e of stage.engines) {
      maxDiamM = Math.max(maxDiamM, e.diameterM);
    }

    // Fuel tanks stack vertically: add each tank's height individually.
    for (const t of stage.fuelTanks) {
      totalHeightM += t.lengthM;
      maxDiamM = Math.max(maxDiamM, t.diameterM);
    }

    // Interstage adapter contributes a fixed visual height.
    if (stage.interstageAdapter) {
      totalHeightM += INTERSTAGE_HEIGHT_M;
      maxDiamM = Math.max(maxDiamM,
        Math.max(
          stage.interstageAdapter.topDiameterM,
          stage.interstageAdapter.bottomDiameterM,
        ),
      );
    }

    // RCS thrusters contribute a tiny stack height for bounding box coverage.
    if (stage.rcsThrusters.length > 0 && stage.fuelTanks.length > 0) {
      totalHeightM += RCS_VISUAL_HEIGHT_M * Math.ceil(stage.rcsThrusters.length / 2);
      // Each pair of RCS thrusters (left + right) occupies one row in the stack.
    }
  }

  // Nose cone at the very top of the rocket.
  const topStage = stages[stages.length - 1];
  if (topStage?.noseCone) {
    totalHeightM += topStage.noseCone.lengthM;
    maxDiamM = Math.max(maxDiamM, topStage.noseCone.diameterM);
  }

  if (totalHeightM <= 0) {
    // Empty rocket (no parts): return a minimal layout for the empty state.
    return { layouts: [], ppm: 20, rocketHeightM: 0, stageRanges: [], rocketWidthPx: 0 };
  }

  // ── Step 2: compute pixels-per-meter (the universal scale factor) ───────────

  const availH = canvasH - PAD_TOP - PAD_BOTTOM;
  // Vertical canvas space available for the rocket, after reserving padding.

  const availW = canvasW - PAD_LEFT - PAD_RIGHT;
  // Horizontal canvas space available for the rocket (between labels and annotations).

  const ppmH = availH / totalHeightM;
  // ppm from height constraint: how many pixels each meter gets if the rocket
  // fills the full available canvas height.

  const ppmW = (availW * 0.62) / maxDiamM;
  // ppm from width constraint: limits the width so the rocket body never spans
  // more than 62% of the available horizontal space, leaving room for fins/legs.

  let ppm = Math.min(ppmH, ppmW);
  // Take the more restrictive (smaller) scale factor so the rocket fits both ways.

  // Enforce the minimum part-height constraint: every part must be at least
  // MIN_PART_PX pixels tall so tiny parts (like a 0.3 m RCS row) are visible.
  const minPartHM = stages.flatMap((s) => [
    ...s.engines.map((e) => e.lengthM),
    ...s.fuelTanks.map((t) => t.lengthM),
    ...(topStage?.noseCone ? [topStage.noseCone.lengthM] : []),
    ...(s.interstageAdapter ? [INTERSTAGE_HEIGHT_M] : []),
  ]).filter((h) => h > 0).reduce((m, h) => Math.min(m, h), Infinity);
  // Find the shortest part in the rocket.

  if (isFinite(minPartHM) && minPartHM > 0) {
    ppm = Math.max(ppm, MIN_PART_PX / minPartHM);
    // If the scale is too small to show the shortest part at MIN_PART_PX, scale up.
  }

  // ── Step 3: establish the rocket center X ──────────────────────────────────

  const cx = PAD_LEFT + availW / 2;
  // Center the rocket in the available horizontal space between labels and annotations.

  // ── Step 4: walk stages bottom-to-top and compute each part's canvas bbox ──

  const layouts: PartBBox[] = [];
  const stageRanges: StageRange[] = [];

  let curY = canvasH - PAD_BOTTOM;
  // Start at the canvas bottom (high Y value) and move upward (decrement Y).

  for (let si = 0; si < stages.length; si++) {
    const stage = stages[si];
    const stageBotY = curY; // Y of the bottom of this stage (changes as we add parts)

    // ── Engine cluster ──────────────────────────────────────────────────────
    if (stage.engines.length > 0) {
      const maxEngHm = stage.engines.reduce((m, e) => Math.max(m, e.lengthM), 0);
      const engHeightPx = Math.max(maxEngHm * ppm, MIN_PART_PX);
      // Height of the engine row in pixels; all engines are the same visual height.

      const engTopY = curY - engHeightPx; // Top of the engine row
      const engCount = stage.engines.length;

      // The stage body width is set by the widest tank (or widest engine if no tank):
      const stageBodyDiamM = Math.max(
        ...stage.fuelTanks.map((t) => t.diameterM),
        ...stage.engines.map((e) => e.diameterM),
        0.5,
      );
      const stageWidthPx = stageBodyDiamM * ppm;

      if (engCount === 1) {
        // Single engine: centered in the stage body.
        const e = stage.engines[0];
        const ew = Math.max(e.diameterM * ppm, 8);
        layouts.push({
          key: `${e.id}_${si}_0`,
          part: e,
          stageIndex: si,
          x: cx - ew / 2,
          y: engTopY,
          w: ew,
          h: engHeightPx,
        });
      } else if (engCount <= 3) {
        // 2–3 engines: evenly spaced across the stage body.
        const totalEngW = stageWidthPx * 0.9;
        // Use 90% of stage width to avoid engines touching the body edge.
        const spacing = totalEngW / engCount;
        const startX = cx - totalEngW / 2;
        stage.engines.forEach((e, ei) => {
          const ew = Math.max(e.diameterM * ppm, 6);
          const ecx = startX + spacing * (ei + 0.5); // Engine center X
          layouts.push({
            key: `${e.id}_${si}_${ei}`,
            part: e,
            stageIndex: si,
            x: ecx - ew / 2,
            y: engTopY,
            w: ew,
            h: engHeightPx,
          });
        });
      } else {
        // 4–9 engines: show 3 across the front (as seen in side-view) and note total count.
        // In 3D the engines form a ring; in 2D side-view we see the 3 front-facing ones.
        const visibleCount = Math.min(engCount, 3); // Show up to 3 in side-view
        const totalEngW = stageWidthPx * 0.88;
        const spacing = totalEngW / visibleCount;
        const startX = cx - totalEngW / 2;
        for (let vi = 0; vi < visibleCount; vi++) {
          const e = stage.engines[vi];
          const ew = Math.max(e.diameterM * ppm, 6);
          const ecx = startX + spacing * (vi + 0.5);
          layouts.push({
            key: `${e.id}_${si}_${vi}`,
            part: e,
            stageIndex: si,
            x: ecx - ew / 2,
            y: engTopY,
            w: ew,
            h: engHeightPx,
          });
        }
        // For 4–9 engines the remaining engines share the bbox of the first three —
        // we store them as additional entries with the SAME y/h but offset x so the
        // hover system can still find any of them.
        for (let ei = visibleCount; ei < engCount; ei++) {
          const e = stage.engines[ei];
          const ew = Math.max(e.diameterM * ppm, 6);
          // Place extra engine bboxes behind the visible ones (offset by -2px each):
          layouts.push({
            key: `${e.id}_${si}_${ei}`,
            part: e,
            stageIndex: si,
            x: cx - ew / 2 - (ei - visibleCount + 1) * 2,
            y: engTopY,
            w: ew,
            h: engHeightPx,
          });
        }
      }

      curY = engTopY; // Move the stacking cursor up past the engine row
    }

    // ── Fuel tanks ──────────────────────────────────────────────────────────
    for (let ti = 0; ti < stage.fuelTanks.length; ti++) {
      const t = stage.fuelTanks[ti];
      const tankH = Math.max(t.lengthM * ppm, MIN_PART_PX);
      const tankW = Math.max(t.diameterM * ppm, 10);
      const tankTopY = curY - tankH;
      layouts.push({
        key: `${t.id}_${si}_${ti}`,
        part: t,
        stageIndex: si,
        x: cx - tankW / 2,
        y: tankTopY,
        w: tankW,
        h: tankH,
      });
      curY = tankTopY; // Move cursor up past this tank
    }

    // ── RCS thrusters ────────────────────────────────────────────────────────
    // Grouped into pairs (left+right at same Y level); each pair occupies one
    // visual row in the stack.  The bboxes are placed ON THE SIDES of the last tank.
    if (stage.rcsThrusters.length > 0 && stage.fuelTanks.length > 0) {
      const rowCount = Math.ceil(stage.rcsThrusters.length / 2);
      // Each pair of RCS thrusters (one per side) gets one row.

      const rowH = Math.max(RCS_VISUAL_HEIGHT_M * ppm, MIN_PART_PX);
      // Height of each RCS row.

      const lastTank = stage.fuelTanks[stage.fuelTanks.length - 1];
      const tankW = Math.max(lastTank.diameterM * ppm, 10);
      const rcsPodW = Math.max(tankW * 0.14, 6); // Pod width = 14% of tank width

      for (let ri = 0; ri < stage.rcsThrusters.length; ri++) {
        const r = stage.rcsThrusters[ri];
        const rowIdx = Math.floor(ri / 2); // Which row this thruster is in
        const isLeft  = ri % 2 === 0;      // Even index = left side
        const rowTopY = curY - (rowIdx + 1) * rowH;
        // Y for this row's top: each row stacks upward from curY.

        layouts.push({
          key: `${r.id}_${si}_${ri}`,
          part: r,
          stageIndex: si,
          x: isLeft ? cx - tankW / 2 - rcsPodW : cx + tankW / 2,
          // Left thrusters sit to the left of the tank; right thrusters sit to the right.
          y: rowTopY,
          w: rcsPodW,
          h: rowH,
        });
      }
      curY -= rowCount * rowH;
      // Advance cursor up by the total height of all RCS rows.
    }

    // ── Interstage adapter ───────────────────────────────────────────────────
    if (stage.interstageAdapter) {
      const adapter = stage.interstageAdapter;
      const adapterH = Math.max(INTERSTAGE_HEIGHT_M * ppm, MIN_PART_PX);
      const adapterTopW = Math.max(adapter.topDiameterM * ppm, 10);
      const adapterBotW = Math.max(adapter.bottomDiameterM * ppm, 10);
      const adapterTopY = curY - adapterH;
      const maxW = Math.max(adapterTopW, adapterBotW);
      layouts.push({
        key: `${adapter.id}_${si}_0`,
        part: adapter,
        stageIndex: si,
        x: cx - maxW / 2,
        y: adapterTopY,
        w: maxW,
        h: adapterH,
      });
      curY = adapterTopY;
    }

    const stageTopY = curY; // Top of this stage after adding all parts
    stageRanges.push({ stageIndex: si, topY: stageTopY, botY: stageBotY });
  }

  // ── Nose cone ─────────────────────────────────────────────────────────────
  if (topStage?.noseCone) {
    const nc = topStage.noseCone;
    const ncH = Math.max(nc.lengthM * ppm, MIN_PART_PX);
    const ncW = Math.max(nc.diameterM * ppm, 10);
    const ncTopY = curY - ncH;
    layouts.push({
      key: `${nc.id}_${stages.length - 1}_0`,
      part: nc,
      stageIndex: stages.length - 1,
      x: cx - ncW / 2,
      y: ncTopY,
      w: ncW,
      h: ncH,
    });
  }

  // Compute the widest part's pixel width for annotation reference:
  const rocketWidthPx = maxDiamM * ppm;

  return { layouts, ppm, rocketHeightM: totalHeightM, stageRanges, rocketWidthPx };
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export const RocketAssemblyPreview: React.FC<RocketAssemblyPreviewProps> = ({
  stages,
  assembly,
  assemblyProgress,
  onRemovePart,
  onRequestCatalogTab,
}) => {

  // ── Canvas and container refs ────────────────────────────────────────────────
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  // The canvas element: all rocket rendering happens here.

  const containerRef = useRef<HTMLDivElement>(null);
  // The wrapper div: observed for size changes so the canvas dimensions stay in sync.

  // ── Canvas size state (drives canvas width/height attributes) ────────────────
  const [canvasSize, setCanvasSize] = useState({ w: 320, h: 640 });
  // Updated by the ResizeObserver when the container changes size.
  // Stored in state because changing it triggers a React re-render which
  // resets the canvas (clearing it for the next animation frame).

  // ── Hover / selection state ──────────────────────────────────────────────────
  const [hoveredKey,  setHoveredKey]  = useState<string | null>(null);
  // Key of the currently highlighted part (committed after 200ms debounce).

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Key of the currently selected part (persists until another click or ESC).

  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  // Current cursor position in canvas pixels; used to position the tooltip.

  // ── Bounding box ref (not state: updated every frame without re-rendering) ───
  const bboxesRef = useRef<PartBBox[]>([]);
  // Array of all part bounding boxes from the most recent drawScene() call.
  // Used by mousemove to identify which part the cursor is over.

  // ── Hover debounce timer ref ──────────────────────────────────────────────────
  const hoverTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHoverRef  = useRef<string | null>(null);
  // When the cursor moves over a part, we start a 200ms timer (pendingHoverRef).
  // Only after 200ms does the hover become "committed" (hoveredKey state update).
  // This prevents tooltip flicker when the user moves the mouse quickly across parts.

  // ── Flash effects (white solidification flash on assembly complete) ───────────
  const flashMapRef = useRef<Map<string, number>>(new Map());
  // Maps partKey → Date.now() of when the flash started.
  // The draw loop reads this and overlays a fading white rectangle over the part.

  // ── Particle effects ─────────────────────────────────────────────────────────
  const particlesRef = useRef<Particle[]>([]);
  // Active connection-point particles: small white dots that burst outward and fade.

  // ── Previous stages ref (for detecting newly-added parts) ────────────────────
  const prevStagesRef = useRef<BuildStage[]>(stages);
  // Compared against the current stages each time stages changes.
  // If a new part appears, we start its flash effect and spawn particles.

  // ── Animation frame ID ────────────────────────────────────────────────────────
  const rafRef = useRef<number | null>(null);

  // ── Last frame timestamp (for frame-rate limiting) ────────────────────────────
  const lastFrameTimeRef = useRef<number>(0);
  // Used to skip frames when running at 30 FPS (static state).

  // ── Detect newly-installed parts and trigger effects ─────────────────────────
  useEffect(() => {
    const prev = prevStagesRef.current;
    // Compare each stage against the previous snapshot to find new parts.

    for (let si = 0; si < stages.length; si++) {
      const stage    = stages[si];
      const prevStage = prev[si];
      if (!prevStage) continue; // New stage added: skip (no previous state to diff)

      // Helper: check if a part is new (was not in the previous version of this stage)
      const isNew = (p: AnyRocketPart, prevArr: AnyRocketPart[]) =>
        !prevArr.some((pp) => pp.id === p.id);
      // Comparison by ID is sufficient because each part instance shares its catalog ID.

      // Scan each part category for newly-added parts:
      [...stage.engines].forEach((e) => {
        if (isNew(e, prevStage.engines)) {
          const key = `${e.id}_${si}_0`;
          flashMapRef.current.set(key, Date.now());
          // Start the white solidification flash for this engine.
        }
      });
      stage.fuelTanks.forEach((t, ti) => {
        if (isNew(t, prevStage.fuelTanks)) {
          flashMapRef.current.set(`${t.id}_${si}_${ti}`, Date.now());
        }
      });
      if (stage.noseCone && !prevStage.noseCone) {
        flashMapRef.current.set(`${stage.noseCone.id}_${si}_0`, Date.now());
      }
      if (stage.fins && !prevStage.fins) {
        // Fins don't have a canvas bbox but we record a flash key for completeness.
        flashMapRef.current.set(`${stage.fins.id}_${si}_0`, Date.now());
      }
      if (stage.landingLegs && !prevStage.landingLegs) {
        flashMapRef.current.set(`${stage.landingLegs.id}_${si}_0`, Date.now());
      }
      if (stage.interstageAdapter && !prevStage.interstageAdapter) {
        flashMapRef.current.set(`${stage.interstageAdapter.id}_${si}_0`, Date.now());
      }
      stage.rcsThrusters.forEach((r, ri) => {
        if (isNew(r, prevStage.rcsThrusters)) {
          flashMapRef.current.set(`${r.id}_${si}_${ri}`, Date.now());
        }
      });
    }

    prevStagesRef.current = stages;
    // Update the snapshot so the NEXT change is diffed against the current state.
  }, [stages]);

  // ── Key listener: ESC deselects the selected part ────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedKey(null);
      // ESC is the standard "deselect / cancel" key per the spec.
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── ResizeObserver: keep canvas dimensions in sync with container ─────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 10 && height > 10) {
          // Only update if dimensions are meaningful (avoid zero-size flash on mount).
          setCanvasSize({ w: Math.floor(width), h: Math.floor(height) });
        }
      }
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Main drawing function ─────────────────────────────────────────────────────
  const drawScene = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    // Clear the canvas to a dark semi-transparent background each frame.
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(3, 5, 15, 0.97)";
    // Very dark blue-black: matches the overall simulator color scheme (#03050f).
    ctx.fillRect(0, 0, w, h);

    // ── Empty state ────────────────────────────────────────────────────────────
    const hasAnyPart = stages.some(
      (s) => s.engines.length > 0 || s.fuelTanks.length > 0 ||
             s.noseCone || s.fins || s.landingLegs ||
             s.interstageAdapter || s.rcsThrusters.length > 0,
    );

    if (!hasAnyPart) {
      // Draw a ghostly placeholder rocket outline and instructional text.
      const cx = w / 2;
      const midY = h / 2;
      const plW = Math.min(w * 0.22, 60);
      const plH = Math.min(h * 0.52, 200);

      ctx.globalAlpha = 0.13;
      // Very faint (13% opacity) so it reads as a placeholder, not real content.

      ctx.strokeStyle = "#38bdf8";
      // Use the UI accent color (matching the border/header theme) for the placeholder.

      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]); // Dashed to clearly signal "placeholder"

      // Rocket body rectangle:
      ctx.strokeRect(cx - plW / 2, midY - plH * 0.4, plW, plH * 0.7);

      // Nose cone triangle:
      ctx.beginPath();
      ctx.moveTo(cx,              midY - plH * 0.4 - plH * 0.18); // Tip
      ctx.lineTo(cx - plW / 2,    midY - plH * 0.4);               // Base-left
      ctx.lineTo(cx + plW / 2,    midY - plH * 0.4);               // Base-right
      ctx.closePath();
      ctx.stroke();

      // Flame/nozzle at bottom:
      ctx.beginPath();
      ctx.moveTo(cx - plW * 0.3, midY - plH * 0.4 + plH * 0.7);   // Left nozzle
      ctx.lineTo(cx,             midY - plH * 0.4 + plH * 0.7 + plW * 0.5); // Flame tip
      ctx.lineTo(cx + plW * 0.3, midY - plH * 0.4 + plH * 0.7);   // Right nozzle
      ctx.stroke();

      ctx.setLineDash([]); // Reset dash
      ctx.globalAlpha = 1.0;

      // Instructional text:
      ctx.font = "11px monospace";
      ctx.fillStyle = "rgba(100,120,160,0.7)";
      ctx.textAlign = "center";
      ctx.fillText("Add parts from the catalog", cx, midY + plH * 0.4);
      ctx.fillText("to start building your rocket", cx, midY + plH * 0.4 + 16);

      // Left-pointing arrow toward catalog panel:
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.font = "16px monospace";
      ctx.fillText("◀", PAD_LEFT + 10, midY);

      bboxesRef.current = []; // No bounding boxes when empty
      return; // Skip all further drawing
    }

    // ── Compute layout ─────────────────────────────────────────────────────────
    const { layouts, ppm, rocketHeightM, stageRanges } =
      computeLayout(stages, w, h);

    // Store bounding boxes for hit-testing in event handlers:
    bboxesRef.current = layouts;

    const cx = PAD_LEFT + (w - PAD_LEFT - PAD_RIGHT) / 2;
    // Rocket center X: midpoint of the drawing area (between labels and annotations).

    // ── Stage background tints ──────────────────────────────────────────────────
    // Very faint colored rectangles behind each stage to visually group their parts.
    const stageTintColors = [
      "rgba(0,100,255,0.03)",   // Stage 1: faint blue (fires first, most powerful)
      "rgba(0,255,100,0.03)",   // Stage 2: faint green
      "rgba(136,0,255,0.03)",   // Stage 3: faint purple
    ];
    stageRanges.forEach(({ stageIndex, topY, botY }) => {
      const tintColor = stageTintColors[stageIndex] ?? "rgba(255,255,255,0.02)";
      ctx.fillStyle = tintColor;
      // The tint spans the full canvas width within the drawing area:
      ctx.fillRect(PAD_LEFT, topY, w - PAD_LEFT - PAD_RIGHT, botY - topY);
    });

    // ── Draw each part ─────────────────────────────────────────────────────────
    for (const bbox of layouts) {
      const { part, x, y, w: bw, h: bh, key } = bbox;
      const bx = x; // bounding box left edge
      const by = y; // bounding box top edge

      const isHov = key === hoveredKey;  // Is this part currently hovered?
      const isSel = key === selectedKey; // Is this part currently selected?

      // ── Hover / selection highlight overlay (drawn BEHIND the part) ──────────
      if (isHov || isSel) {
        ctx.save();
        ctx.globalAlpha = isSel ? 0.18 : 0.12;
        ctx.fillStyle = "#00FFFF"; // Cyan fill tint
        ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
        ctx.restore();
        // Slightly expanded fill behind the part to indicate selection without
        // interfering with the part's own drawing.
      }

      // ── Part-specific drawing ─────────────────────────────────────────────
      switch (part.category) {

        case "engine": {
          // Engines: bell nozzle shape with combustion chamber and gimbal mount.
          const partCx = x + bw / 2;
          // Engine center X = midpoint of its individual bounding box
          // (multi-engine clusters have separate bboxes per engine).
          drawEngine(ctx, bx, by, bw, bh, partCx, isHov, isSel);
          break;
        }

        case "fuelTank": {
          // Tanks: rounded cylinder with domed ends and propellant color coding.
          const partCx = x + bw / 2;
          drawFuelTank(ctx, bx, by, bw, bh, partCx, part as FuelTank, isHov, isSel);
          break;
        }

        case "noseCone": {
          // Nose cone: bezier ogive curve; sharpness varies by cone type.
          const nc = part as NoseCone;
          const partCx = x + bw / 2;

          // Determine sharpness from the cone's length-to-diameter ratio:
          // Long, narrow cone → sharp (high sharpness); short, wide fairing → blunt.
          const aspectRatio = nc.lengthM / nc.diameterM;
          const sharpness = Math.min(0.90, Math.max(0.45, aspectRatio / 8));
          // Clamp between 0.45 (blunt large fairing) and 0.90 (sharp small ogive).

          drawNoseCone(ctx, bx, by, bw, bh, partCx, sharpness, isHov, isSel);
          break;
        }

        case "rcsThruster": {
          // RCS thrusters: drawn as small side nubs at the stored bbox position.
          // The bbox for even-index thrusters is on the left, odd on the right.
          // We re-derive the side from whether the bbox is left or right of cx:
          const side = x < cx ? "left" : "right";

          // Find the last tank in this stage to get tank dimensions:
          const stage = stages[bbox.stageIndex];
          const lastTank = stage.fuelTanks[stage.fuelTanks.length - 1] ??
            { diameterM: 1.0 } as FuelTank;
          const tankW = Math.max(lastTank.diameterM * ppm, 10);

          // The RCS y-center is at the midpoint of the bbox:
          drawRCSThruster(
            ctx,
            cx - tankW / 2, by, tankW, bh, // Tank reference dimensions
            by + bh / 2,                    // Y center of this RCS row
            side,
            isHov, isSel,
          );
          break;
        }

        case "interstageAdapter": {
          // Interstage: trapezoid between two stage widths.
          const adapter = part as InterstageAdapter;
          const partCx   = x + bw / 2;
          const topDiamPx  = Math.max(adapter.topDiameterM  * ppm, 10);
          const botDiamPx  = Math.max(adapter.bottomDiameterM * ppm, 10);
          drawInterstage(ctx, partCx, by, by + bh, topDiamPx, botDiamPx, isHov, isSel);
          break;
        }

        // Fins and landing legs are drawn separately (below) because they need
        // per-stage coordinate info, not just the individual part bbox.
        case "fin":
        case "landingLeg":
          break; // Skip here; handled in the stage loop below
      }

      // ── Flash effect (white solidification flash on assembly completion) ───────
      const flashStart = flashMapRef.current.get(key);
      if (flashStart !== undefined) {
        const age = Date.now() - flashStart;
        // Age = how many ms since the flash was triggered.

        if (age < FLASH_DURATION_MS) {
          const alpha = 0.85 * (1 - age / FLASH_DURATION_MS);
          // Linear fade from 85% to 0% opacity over FLASH_DURATION_MS.
          // Starts bright to simulate the welding arc, fades quickly.
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = "#FFFFFF"; // Pure white flash
          ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
          ctx.restore();
        } else {
          flashMapRef.current.delete(key);
          // Flash expired: remove it so we don't keep drawing it.
        }
      }
    }

    // ── Draw fins and landing legs (outward extensions) ──────────────────────────
    stageRanges.forEach(({ stageIndex, topY, botY }) => {
      const stage = stages[stageIndex];
      if (!stage) return;

      // Compute stage body width in pixels for fin/leg proportions:
      const stageBodyDiamM = Math.max(
        ...stage.fuelTanks.map((t) => t.diameterM),
        ...stage.engines.map((e) => e.diameterM),
        0.5,
      );
      const stageWidthPx = stageBodyDiamM * ppm;

      // Fins: only on stage 0 (bottom stage) as per real rocket design rules.
      if (stageIndex === 0 && stage.fins) {
        const finKey = `${stage.fins.id}_${stageIndex}_0`;
        const isFinHov = finKey === hoveredKey;
        const isFinSel = finKey === selectedKey;
        drawFins(ctx, cx, topY, botY, stageWidthPx, stage.fins, isFinHov, isFinSel);

        // Add fin bbox to the list so they can be hovered (fins extend outward):
        const finSpanPx = stageWidthPx * 0.55;
        const finH = Math.max((botY - topY) * 0.55, 12);
        bboxesRef.current.push({
          key: finKey,
          part: stage.fins,
          stageIndex,
          x: cx - stageWidthPx / 2 - finSpanPx,   // Left fin left edge
          y: botY - finH,
          w: stageWidthPx + finSpanPx * 2,          // Span both sides
          h: finH,
        });
      }

      // Landing legs: only on stage 0 (bottom stage).
      if (stageIndex === 0 && stage.landingLegs) {
        const legKey = `${stage.landingLegs.id}_${stageIndex}_0`;
        const isLegHov = legKey === hoveredKey;
        const isLegSel = legKey === selectedKey;
        drawLandingLegs(ctx, cx, topY, botY, stageWidthPx, isLegHov, isLegSel);

        // Landing leg bbox: spans the deployed foot area below the stage bottom.
        const legSpan = stageWidthPx * 0.80;
        const legH    = Math.max((botY - topY) * 0.65, 14);
        bboxesRef.current.push({
          key: legKey,
          part: stage.landingLegs,
          stageIndex,
          x: cx - stageWidthPx / 2 - legSpan / 2,
          y: botY - legH,
          w: stageWidthPx + legSpan,
          h: legH + legH * 0.4 + 4, // Include the foot pad area below stage bottom
        });
      }
    });

    // ── Stage labels (left side) ───────────────────────────────────────────────
    stageRanges.forEach(({ stageIndex, topY, botY }) => {
      const stage = stages[stageIndex];
      const midY  = (topY + botY) / 2; // Vertical midpoint of this stage

      // Stage number label:
      ctx.font = "bold 9px monospace";
      ctx.fillStyle = "rgba(100,140,200,0.8)";
      ctx.textAlign = "right";
      ctx.fillText(`S${stageIndex + 1}`, PAD_LEFT - 6, midY + 4);

      // Dashed divider line between stages (only between adjacent stages, not below stage 0):
      if (stageIndex < stages.length - 1) {
        ctx.setLineDash([3, 4]); // Short dashes, slightly longer gaps
        ctx.strokeStyle = "rgba(255,255,255,0.14)"; // Faint accent-blue dashes
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(PAD_LEFT, topY);
        ctx.lineTo(w - PAD_RIGHT, topY);
        // The divider line sits at the TOP of each stage (which is the same as the
        // BOTTOM of the stage above it), visually separating the two stages.
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Per-stage thrust and mass annotation:
      const stageThrust = stage.engines.reduce((s, e) => s + e.thrustSeaLevel, 0);
      const stageFuel   = stage.fuelTanks.reduce((s, t) => s + t.capacityKg, 0);
      if (stageThrust > 0 || stageFuel > 0) {
        ctx.font = "8px monospace";
        ctx.fillStyle = "rgba(80,100,140,0.7)";
        ctx.textAlign = "right";
        if (stageThrust > 0) {
          ctx.fillText(
            fmtN(stageThrust),
            PAD_LEFT - 4,
            midY + 14,
          );
        }
      }
    });

    // ── Dimension annotations (right side) ─────────────────────────────────────
    // Draw a vertical arrow showing total rocket height on the right side.
    if (stageRanges.length > 0) {
      const rocketTopY    = stageRanges[stageRanges.length - 1].topY;
      // Top of the highest stage's parts — or nose cone top if present:
      const noseConeLayout = layouts.find((l) => l.part.category === "noseCone");
      const topAnnotY     = noseConeLayout ? noseConeLayout.y : rocketTopY;

      const rocketBotY    = stageRanges[0].botY;
      // Bottom of stage 0 (where engine nozzles end).

      const annotX = w - PAD_RIGHT + 14;
      // X position of the dimension annotation: 14 px inside the right padding.

      // Vertical dimension line:
      ctx.strokeStyle = "rgba(120,140,160,0.5)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(annotX, topAnnotY);
      ctx.lineTo(annotX, rocketBotY);
      ctx.stroke();

      // Arrowhead at top:
      ctx.beginPath();
      ctx.moveTo(annotX,     topAnnotY);
      ctx.lineTo(annotX - 3, topAnnotY + 5);
      ctx.lineTo(annotX + 3, topAnnotY + 5);
      ctx.closePath();
      ctx.fillStyle = "rgba(120,140,160,0.5)";
      ctx.fill();

      // Arrowhead at bottom:
      ctx.beginPath();
      ctx.moveTo(annotX,     rocketBotY);
      ctx.lineTo(annotX - 3, rocketBotY - 5);
      ctx.lineTo(annotX + 3, rocketBotY - 5);
      ctx.closePath();
      ctx.fill();

      // Height label:
      const midAnnotY = (topAnnotY + rocketBotY) / 2;
      ctx.save();
      ctx.translate(annotX + 10, midAnnotY);
      ctx.rotate(Math.PI / 2); // Rotate text 90° so it reads along the arrow
      ctx.font = "9px monospace";
      ctx.fillStyle = "rgba(140,160,180,0.7)";
      ctx.textAlign = "center";
      ctx.fillText(fmtM(rocketHeightM), 0, 0);
      ctx.restore();

      // Diameter annotation (horizontal arrow at the widest stage):
      const widestStageIdx = stageRanges.reduce((best, r) => {
        const s = stages[r.stageIndex];
        const diam = Math.max(
          ...s.fuelTanks.map((t) => t.diameterM),
          ...s.engines.map((e) => e.diameterM),
          0.5,
        );
        const bestDiam = Math.max(
          ...stages[best.stageIndex].fuelTanks.map((t) => t.diameterM),
          ...stages[best.stageIndex].engines.map((e) => e.diameterM),
          0.5,
        );
        return diam > bestDiam ? r : best;
      }, stageRanges[0]);

      const widestStage = stages[widestStageIdx.stageIndex];
      const widestDiamM = Math.max(
        ...widestStage.fuelTanks.map((t) => t.diameterM),
        ...widestStage.engines.map((e) => e.diameterM),
        0.5,
      );
      const widestWidthPx = widestDiamM * ppm;
      const diamAnnotY = (widestStageIdx.topY + widestStageIdx.botY) / 2;
      const diamLX = cx - widestWidthPx / 2;
      const diamRX = cx + widestWidthPx / 2;

      ctx.strokeStyle = "rgba(120,140,160,0.4)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(diamLX, diamAnnotY);
      ctx.lineTo(diamRX, diamAnnotY);
      ctx.stroke();

      // Small tick marks at each end:
      ctx.beginPath();
      ctx.moveTo(diamLX, diamAnnotY - 4); ctx.lineTo(diamLX, diamAnnotY + 4);
      ctx.moveTo(diamRX, diamAnnotY - 4); ctx.lineTo(diamRX, diamAnnotY + 4);
      ctx.stroke();

      // Diameter label below the line:
      ctx.font = "8px monospace";
      ctx.fillStyle = "rgba(140,160,180,0.6)";
      ctx.textAlign = "center";
      ctx.fillText("⌀ " + fmtM(widestDiamM), cx, diamAnnotY + 12);
    }

    // ── Assembly ghost (shown while a part is being installed) ─────────────────
    if (assembly) {
      // Compute the ghost opacity using a sine wave to create a pulsing effect.
      // The pulse period is GHOST_PULSE_PERIOD_MS milliseconds.
      const phase = (Date.now() % GHOST_PULSE_PERIOD_MS) / GHOST_PULSE_PERIOD_MS;
      // phase: 0.0 → 1.0 cycling with time

      const ghostAlpha = 0.25 + 0.20 * Math.sin(phase * Math.PI * 2);
      // Oscillates between 0.05 (dim) and 0.45 (bright) — a gentle pulse.

      // Find the ghost position: where the assembly part WOULD appear in the stack.
      // We compute a hypothetical layout that includes the ghost part and take its bbox.
      const ghostPart = assembly.part;
      const targetSI  = assembly.stageIndex;

      // Estimate ghost Y position: place it at the TOP of the target stage's current content.
      const targetRange = stageRanges.find((r) => r.stageIndex === targetSI);
      if (targetRange) {
        const ghostH = Math.max(partHeightM(ghostPart) * ppm, MIN_PART_PX);
        const ghostW = Math.max(partDiamM(ghostPart) * ppm, 20);

        // Ghost position: just above the current stage top.
        const ghostTopY = targetRange.topY - ghostH - 2;
        // The -2 gives a small gap so the ghost appears "floating" above the built part.

        const ghostX = cx - ghostW / 2;

        ctx.save();
        ctx.globalAlpha = ghostAlpha;
        ctx.setLineDash([4, 3]); // Dashed outline = "not yet installed"

        // Ghost fill (faint cyan glow):
        ctx.fillStyle = "rgba(0, 220, 255, 0.15)";
        ctx.fillRect(ghostX - 2, ghostTopY - 2, ghostW + 4, ghostH + 4);

        // Ghost border:
        ctx.strokeStyle = "#00FFFF";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ghostX, ghostTopY, ghostW, ghostH);
        ctx.setLineDash([]);

        // "ASSEMBLING..." label next to the ghost:
        ctx.globalAlpha = 0.7;
        ctx.font = "bold 9px monospace";
        ctx.fillStyle = "#00FFFF";
        ctx.textAlign = "left";
        ctx.fillText("ASSEMBLING...", cx + ghostW / 2 + 6, ghostTopY + ghostH / 2 + 3);

        // Progress fill inside the ghost (mirrors the assembly progress bar):
        if (assemblyProgress > 0) {
          ctx.globalAlpha = ghostAlpha * 0.5;
          ctx.fillStyle = "rgba(0, 255, 200, 0.4)";
          ctx.fillRect(ghostX + 1, ghostTopY + ghostH * (1 - assemblyProgress), ghostW - 2, ghostH * assemblyProgress);
          // Fill grows from bottom to top as progress goes from 0 to 1,
          // visually showing how much of the assembly has completed.
        }

        ctx.restore();
      }
    }

    // ── Particles (connection-point burst effect) ─────────────────────────────
    const now = Date.now();
    particlesRef.current = particlesRef.current.filter((p) => {
      const age = now - p.birth;
      if (age > PARTICLE_DURATION_MS) return false; // Particle expired: remove it
      const lifeRatio = 1 - age / PARTICLE_DURATION_MS; // 1.0 = new, 0.0 = expired

      // Update position: simple linear motion (no gravity simulation for particles)
      const px = p.x + p.vx * age;
      const py = p.y + p.vy * age;

      ctx.save();
      ctx.globalAlpha = lifeRatio * 0.85; // Fade out linearly
      ctx.fillStyle = "#FFFFFF";           // White particles = welding sparks
      const r = Math.max(lifeRatio * 2.5, 0.5); // Shrink over lifetime
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return true; // Keep this particle for the next frame
    });

  }, [stages, assembly, assemblyProgress, hoveredKey, selectedKey]);

  // ── Animation loop ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const animate = (timestamp: number) => {
      // Determine if any animation is active (need 60 FPS):
      const hasFlash     = flashMapRef.current.size > 0;
      const hasParticles = particlesRef.current.length > 0;
      const hasGhost     = assembly !== null;
      const isAnimating  = hasFlash || hasParticles || hasGhost;
      // When no animations are active, we run at 30 FPS (save CPU/battery).

      const targetInterval = isAnimating ? 16.67 : 33.33;
      // 16.67 ms = 60 FPS (1000/60); 33.33 ms = 30 FPS (1000/30).

      const elapsed = timestamp - lastFrameTimeRef.current;
      if (elapsed >= targetInterval) {
        lastFrameTimeRef.current = timestamp;
        drawScene(ctx, canvas.width, canvas.height);
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [drawScene, assembly]);

  // ── Mouse move handler ────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const my = (e.clientY - rect.top)  * (canvas.height / rect.height);
    // Convert CSS pixel position to canvas pixel position.
    // The multiplication by (canvas.width / rect.width) handles any CSS scaling.

    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    // Store CSS pixel position for tooltip positioning (tooltips are HTML, not canvas).

    // Find the topmost bbox that contains the cursor (iterate in reverse so parts
    // drawn later — which appear on top visually — take priority):
    let found: string | null = null;
    for (let i = bboxesRef.current.length - 1; i >= 0; i--) {
      const bb = bboxesRef.current[i];
      if (mx >= bb.x && mx <= bb.x + bb.w && my >= bb.y && my <= bb.y + bb.h) {
        found = bb.key;
        break;
      }
    }

    // Debounce the hover commitment by 200ms to prevent flickering:
    if (found !== pendingHoverRef.current) {
      pendingHoverRef.current = found;

      if (hoverTimerRef.current !== null) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }

      if (found === null) {
        // Cursor left all parts: clear hover immediately (no debounce on exit).
        setHoveredKey(null);
      } else {
        // Cursor entered a new part: commit after 200ms if it hasn't moved away.
        hoverTimerRef.current = setTimeout(() => {
          setHoveredKey(pendingHoverRef.current);
          hoverTimerRef.current = null;
        }, 200);
      }
    }
  }, []);

  // ── Mouse leave handler ───────────────────────────────────────────────────────
  const handleMouseLeave = useCallback(() => {
    // Cancel any pending hover debounce and clear hover immediately.
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    pendingHoverRef.current = null;
    setHoveredKey(null);
  }, []);

  // ── Click handler ─────────────────────────────────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const my = (e.clientY - rect.top)  * (canvas.height / rect.height);

    // Same hit-test as mousemove:
    let found: string | null = null;
    for (let i = bboxesRef.current.length - 1; i >= 0; i--) {
      const bb = bboxesRef.current[i];
      if (mx >= bb.x && mx <= bb.x + bb.w && my >= bb.y && my <= bb.y + bb.h) {
        found = bb.key;
        break;
      }
    }

    if (found !== null && found !== selectedKey) {
      setSelectedKey(found);  // Click on a new part: select it
    } else {
      setSelectedKey(null);   // Click on empty space or re-click selected: deselect
    }
  }, [selectedKey]);

  // ── Resolve the hovered/selected bbox objects for overlay rendering ───────────
  const hoveredBbox  = bboxesRef.current.find((b) => b.key === hoveredKey)  ?? null;
  const selectedBbox = bboxesRef.current.find((b) => b.key === selectedKey) ?? null;

  // ── Tooltip content ───────────────────────────────────────────────────────────
  // Render when hoveredBbox is set and no part is currently selected
  // (selected part shows the action menu instead).
  const tooltipBbox = hoveredBbox && !selectedBbox ? hoveredBbox : null;

  // ── Action menu position (for selected part) ──────────────────────────────────
  // The action menu appears to the right of the selected part (or left if near right edge).
  let actionMenuX = selectedBbox ? mousePos.x + 10 : 0;
  let actionMenuY = selectedBbox ? mousePos.y - 20 : 0;
  // Rough initial position: to the right of the cursor.
  // We adjust after render if it would go off-screen (see inline styles below).

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        // flex: 1 makes this div fill the remaining height of the center panel,
        // letting the canvas use all the space between the header and any footer.
        position: "relative",
        // position: relative makes the tooltip/action-menu overlays
        // (which use position: absolute) position relative to this container.
        overflow: "hidden",
        // Prevent scrollbars: the canvas is sized to fit its container exactly.
        backgroundColor: "rgba(3, 5, 15, 0.97)",
        // Match the canvas background so there's no flash when the canvas resizes.
      }}
    >
      {/* ── ROCKET CANVAS ──────────────────────────────────────────────────── */}
      <canvas
        ref={canvasRef}
        width={canvasSize.w}
        height={canvasSize.h}
        // width/height ATTRIBUTES set the internal canvas resolution in pixels.
        // These must match the container size for 1:1 pixel mapping.
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          // CSS size fills the container; canvas attribute size = actual pixels.
          cursor: hoveredBbox ? "pointer" : "default",
          // Show pointer cursor when hovering over a part (indicates clickable).
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />

      {/* ── HOVER TOOLTIP ──────────────────────────────────────────────────── */}
      {tooltipBbox && hoveredKey && (
        <div
          style={{
            position: "absolute",
            left: Math.min(mousePos.x + 12, canvasSize.w - 330),
            // +12 px right of cursor; clamped to 330 px from right edge (tooltip max width).
            top: Math.max(4, Math.min(mousePos.y - 8, canvasSize.h - 160)),
            // -8 px above cursor; clamped within vertical canvas bounds.
            width: "300px",
            backgroundColor: "rgba(0, 0, 0, 0.88)",
            border: "1px solid #00FFFF",
            borderRadius: "6px",
            padding: "10px 12px",
            fontFamily: "monospace",
            fontSize: "11px",
            color: "#CCCCCC",
            pointerEvents: "none",
            // pointerEvents: none so the tooltip doesn't intercept mouse events
            // and accidentally block hover detection on the canvas below.
            zIndex: 10,
            boxShadow: "0 0 12px rgba(0,255,255,0.15)",
            // Faint cyan glow matching the hover border color.
            lineHeight: "1.5",
          }}
        >
          {/* Part name */}
          <div style={{ fontWeight: "bold", fontSize: "13px", color: "#FFFFFF", marginBottom: "4px" }}>
            {tooltipBbox.part.name}
          </div>
          {/* Manufacturer */}
          <div style={{ fontSize: "10px", color: "#8899bb", marginBottom: "5px" }}>
            {tooltipBbox.part.manufacturer}  ·  Stage {tooltipBbox.stageIndex + 1}
          </div>
          {/* Type-specific spec lines */}
          {buildSpecLines(tooltipBbox.part).map((line, i) => (
            <div key={i} style={{ fontSize: "10px", color: "#AABBCC", marginBottom: "2px" }}>
              {line}
            </div>
          ))}
          {/* Assembly status */}
          <div style={{ fontSize: "10px", color: "#44ee88", marginTop: "5px" }}>
            {assembly?.part.id === tooltipBbox.part.id && assembly?.stageIndex === tooltipBbox.stageIndex
              ? `⏳ Assembling... (${Math.ceil((1 - assemblyProgress) * assembly.part.assemblyTimeSeconds)}s remaining)`
              : "✓ Installed"
            }
          </div>
        </div>
      )}

      {/* ── SELECTION ACTION MENU ──────────────────────────────────────────── */}
      {selectedBbox && (
        <div
          style={{
            position: "absolute",
            left: Math.min(actionMenuX, canvasSize.w - 140),
            // Clamp left so the menu doesn't extend off the right edge of the canvas.
            top: Math.max(4, Math.min(actionMenuY, canvasSize.h - 100)),
            // Clamp top so the menu stays within the canvas vertically.
            backgroundColor: "rgba(18, 19, 23, 0.96)",
            border: "1px solid #00FFFF",
            borderRadius: "5px",
            padding: "6px",
            fontFamily: "monospace",
            fontSize: "11px",
            zIndex: 20,
            // zIndex: 20 > tooltip's 10 so the action menu is always on top.
            boxShadow: "0 0 10px rgba(0,255,255,0.2)",
            minWidth: "120px",
          }}
        >
          {/* Selected part name header */}
          <div style={{ color: "#00FFFF", fontWeight: "bold", fontSize: "10px", marginBottom: "6px", paddingBottom: "4px", borderBottom: "1px solid rgba(0,255,255,0.2)" }}>
            {selectedBbox.part.name}
          </div>

          {/* Remove button */}
          <button
            onClick={() => {
              onRemovePart(selectedBbox.part, selectedBbox.stageIndex);
              // Notify the parent to remove this part from the stage.
              setSelectedKey(null); // Deselect after removal
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "4px 8px",
              backgroundColor: "rgba(80,15,15,0.8)",
              color: "#ff8888",
              border: "1px solid rgba(180,50,50,0.5)",
              borderRadius: "3px",
              cursor: "pointer",
              fontSize: "11px",
              fontFamily: "monospace",
              marginBottom: "4px",
              textAlign: "left",
            }}
          >
            ✕ Remove
          </button>

          {/* Replace button (switches catalog to this part type) */}
          {onRequestCatalogTab && (
            <button
              onClick={() => {
                onRequestCatalogTab(selectedBbox.part.category);
                // Ask the parent to switch the catalog tab to this part category,
                // so the user can pick a replacement without manually navigating tabs.
                setSelectedKey(null); // Deselect (catalog becomes the focus)
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "4px 8px",
                backgroundColor: "rgba(15,30,70,0.8)",
                color: "#88aaff",
                border: "1px solid rgba(50,80,180,0.5)",
                borderRadius: "3px",
                cursor: "pointer",
                fontSize: "11px",
                fontFamily: "monospace",
                marginBottom: "4px",
                textAlign: "left",
              }}
            >
              ⇄ Replace
            </button>
          )}

          {/* Close/deselect button */}
          <button
            onClick={() => setSelectedKey(null)}
            style={{
              display: "block",
              width: "100%",
              padding: "4px 8px",
              backgroundColor: "rgba(15,20,40,0.8)",
              color: "#667799",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: "3px",
              cursor: "pointer",
              fontSize: "11px",
              fontFamily: "monospace",
              textAlign: "left",
            }}
          >
            ✕ Close
          </button>
        </div>
      )}
    </div>
  );
};
