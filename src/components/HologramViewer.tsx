/**
 * HOLOGRAM VIEWER COMPONENT
 * =========================
 * Renders a 3D wireframe hologram of a rocket part on an HTML5 Canvas element.
 * Uses pure JavaScript 3D-to-2D perspective projection math — no external 3D libraries.
 *
 * COORDINATE SYSTEM:
 *   Y-up, right-handed: X = right, Y = up, Z = toward the viewer.
 *   The camera is placed along the positive Z axis, looking toward the origin.
 *
 * HOW 3D WIREFRAME RENDERING WORKS:
 *   Step 1 — ROTATION: Multiply each vertex (x,y,z) by rotation matrices to spin the shape.
 *     Y-axis rotation (yaw θ):
 *       x' =  x·cos(θ) + z·sin(θ)     ← x mixes with z
 *       y' =  y                          ← y unchanged
 *       z' = -x·sin(θ) + z·cos(θ)     ← z mixes with x
 *     X-axis rotation (pitch φ):
 *       x' =  x                          ← x unchanged
 *       y' =  y·cos(φ) - z·sin(φ)     ← y mixes with z
 *       z' =  y·sin(φ) + z·cos(φ)     ← z mixes with y
 *
 *   Step 2 — PERSPECTIVE PROJECTION: Divide by (z + focalLength) to create perspective depth.
 *     The formula simulates a pinhole camera:
 *       screenX = (x' · focalLength) / (z' + focalLength)
 *       screenY = (y' · focalLength) / (z' + focalLength)
 *     Vertices farther away (larger z' + focalLength denominator) appear smaller/closer to center.
 *     The focalLength controls the field of view — larger = narrower FOV (more telephoto).
 *
 *   Step 3 — DRAW: Map screen coordinates to canvas pixels, then draw lines between edge pairs.
 *
 * HOLOGRAM VISUAL EFFECTS:
 *   - GLOW: Each line drawn twice — 3px wide at 20% alpha (halo), then 1px at 80% alpha (core).
 *   - SCANLINES: Horizontal semi-transparent stripes scrolled downward every frame.
 *   - FLICKER: Once every ~90 frames, opacity drops to 60% for 2 frames (simulates interference).
 *   - GRID FLOOR: A 5×5 perspective grid beneath the part grounds it visually in 3D space.
 */

import React, {
  useRef,           // useRef: access the canvas DOM element and mutable frame counters
  useEffect,        // useEffect: start/stop animation loop when component mounts/unmounts
  useCallback,      // useCallback: memoize event handlers so they don't cause re-renders
  useState,         // useState: track hover/click/modal state
} from "react";

import { type Shape3D, PART_SHAPES } from "../data/PartShapeDefinitions";
// Shape3D: { vertices, edges, color, label }
// PART_SHAPES: map from part ID string → Shape3D geometry

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const THUMBNAIL_SIZE = 100; // px — side length of the small inline hologram canvas
const EXPANDED_SIZE  = 300; // px — side length of the larger modal hologram canvas

const FOCAL_LENGTH_THUMBNAIL = 3.5; // Perspective focal length for thumbnail view (units = model units)
// Higher focal length = narrower FOV, less perspective distortion; good for small canvas
const FOCAL_LENGTH_EXPANDED  = 4.0; // Slightly wider perspective for expanded view (more 3D depth feel)

const IDLE_ROT_SPEED    = 0.5;  // rad/s — Y-axis auto-rotation speed when not hovered
const HOVER_ROT_SPEED   = 1.5;  // rad/s — Y-axis auto-rotation speed when hovered
const THUMBNAIL_FPS     = 30;   // frames/second — cap for thumbnail renders (saves CPU)
const EXPANDED_FPS      = 60;   // frames/second — cap for expanded view (smooth interaction)

const SCANLINE_SPACING  = 10;   // px between horizontal scanlines
const SCANLINE_ALPHA    = 0.07; // Opacity of scanlines (subtle)
const SCANLINE_SPEED    = 0.5;  // px per frame the scanlines scroll downward

const GLOW_WIDTH        = 3;    // px — width of the outer glow pass
const GLOW_ALPHA        = 0.20; // Opacity of the glow pass
const LINE_WIDTH        = 1;    // px — width of the core line pass
const LINE_ALPHA        = 0.80; // Opacity of the core line pass

const VERTEX_RADIUS     = 1.5;  // px — radius of the vertex dot circles
const VERTEX_ALPHA      = 0.9;  // Opacity of vertex dots

const FLICKER_INTERVAL  = 90;   // frames between flicker events (approx every 3s at 30fps)
const FLICKER_DURATION  = 2;    // frames the flicker lasts
const FLICKER_OPACITY   = 0.55; // Canvas-level opacity during a flicker frame

const GRID_LINES        = 5;    // Number of lines in each direction for the perspective grid
const GRID_ALPHA        = 0.12; // Opacity of the floor grid
const GRID_Y            = -1.2; // Y position of the grid floor in model space (below the part)
const GRID_EXTENT       = 1.5;  // Grid extends ±1.5 model units in X and Z

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * Props for the HologramViewer component.
 *
 * partId:        Part ID string (key into PART_SHAPES); determines which shape to render.
 * isAssembling:  When true, spin faster and glow brighter (assembly animation).
 * assemblyProgress: 0–1; used to scale the glow intensity during assembly.
 */
interface HologramViewerProps {
  partId: string;                   // Must exist in PART_SHAPES; unknown IDs render a placeholder
  isAssembling?: boolean;           // Optional: drive assembly glow animation
  assemblyProgress?: number;        // Optional: 0–1 assembly progress for glow scaling
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

/**
 * HologramViewer — self-contained 3D wireframe hologram renderer.
 * Renders a thumbnail canvas that auto-rotates; clicking opens a full modal.
 */
export const HologramViewer: React.FC<HologramViewerProps> = ({
  partId,
  isAssembling = false,
  assemblyProgress = 0,
}) => {
  // ── REFS ────────────────────────────────────────────────────────────────
  const thumbCanvasRef  = useRef<HTMLCanvasElement>(null); // The thumbnail canvas element
  const modalCanvasRef  = useRef<HTMLCanvasElement>(null); // The expanded modal canvas element
  const animFrameRef    = useRef<number>(0);               // requestAnimationFrame ID for the thumbnail loop
  const modalFrameRef   = useRef<number>(0);               // requestAnimationFrame ID for the modal loop

  const rotYRef         = useRef<number>(0);   // Current Y-axis rotation angle in radians
  const rotXRef         = useRef<number>(0.3); // Current X-axis rotation angle (slight tilt for better 3D view)
  const focalRef        = useRef<number>(FOCAL_LENGTH_THUMBNAIL); // Current focal length (can be zoomed)

  const frameCountRef   = useRef<number>(0);   // Frame counter: drives flickering and scanlines
  const lastTimeRef     = useRef<number>(0);   // Timestamp of last frame: computes delta time
  const scanOffsetRef   = useRef<number>(0);   // Vertical scroll offset for scanlines (pixels)

  // Drag state refs (not state to avoid React re-render overhead during drag)
  const isDraggingRef   = useRef<boolean>(false); // Is the user currently dragging?
  const dragStartRef    = useRef<{ x: number; y: number } | null>(null); // Mouse position at drag start
  const rotYAtDragStart = useRef<number>(0); // rotY when drag started (so drag is relative)
  const rotXAtDragStart = useRef<number>(0); // rotX when drag started

  // IntersectionObserver: used to pause animation when thumbnail is not visible
  const observerRef     = useRef<IntersectionObserver | null>(null);
  const isVisibleRef    = useRef<boolean>(true); // Whether the thumbnail is in the viewport

  // ── STATE ───────────────────────────────────────────────────────────────
  const [isHovered,  setIsHovered]  = useState<boolean>(false); // Triggers faster rotation speed
  const [isExpanded, setIsExpanded] = useState<boolean>(false); // Triggers modal open

  // ── SHAPE LOOKUP ────────────────────────────────────────────────────────
  // Look up the geometry for this part; fall back to a simple placeholder cube if unknown.
  const shape: Shape3D = PART_SHAPES[partId] ?? makePlaceholderShape();

  // ─── CORE 3D MATH ─────────────────────────────────────────────────────────

  /**
   * Rotate and project a 3D vertex to a 2D canvas coordinate.
   *
   * STEP 1 — Y-AXIS ROTATION MATRIX (θ = rotY):
   *   [ cos θ   0   sin θ ] [ x ]   [ x·cosθ + z·sinθ ]
   *   [   0     1     0   ] [ y ] = [ y               ]
   *   [-sin θ   0   cos θ ] [ z ]   [-x·sinθ + z·cosθ ]
   *
   * STEP 2 — X-AXIS ROTATION MATRIX (φ = rotX):
   *   [ 1     0       0  ] [ x ]   [ x                  ]
   *   [ 0   cos φ  -sin φ] [ y ] = [ y·cosφ - z'·sinφ  ]
   *   [ 0   sin φ   cos φ] [ z ]   [ y·sinφ + z'·cosφ  ]
   *   where z' is z after Y-rotation.
   *
   * STEP 3 — PERSPECTIVE PROJECTION:
   *   The perspective transform maps 3D to 2D by scaling with 1/(z+f).
   *   This simulates how a real lens focuses: farther objects appear smaller.
   *   screenX = x'' · f / (z'' + f)
   *   screenY = y'' · f / (z'' + f)
   *   Then we add the canvas center offset (cx, cy) and a scale multiplier.
   *
   * @param vx       3D vertex X coordinate (model space)
   * @param vy       3D vertex Y coordinate (model space)
   * @param vz       3D vertex Z coordinate (model space)
   * @param rotY     Y-axis rotation angle in radians
   * @param rotX     X-axis rotation angle in radians
   * @param focal    Focal length for perspective (larger = less distortion)
   * @param scale    Pixels-per-model-unit scale (how big the shape appears on canvas)
   * @param cx       Canvas center X (pixel offset for origin)
   * @param cy       Canvas center Y (pixel offset for origin)
   * @returns        { sx: number, sy: number } projected screen coordinates
   */
  const project = (
    vx: number, vy: number, vz: number,
    rotY: number, rotX: number,
    focal: number, scale: number,
    cx: number, cy: number
  ): { sx: number; sy: number } => {
    // ── Y-AXIS ROTATION ──
    const cosY = Math.cos(rotY); // cos(θ): precompute to avoid redundant calls
    const sinY = Math.sin(rotY); // sin(θ)
    const rx1 =  vx * cosY + vz * sinY; // x after Y-rotation
    const ry1 =  vy;                      // y unchanged by Y-rotation
    const rz1 = -vx * sinY + vz * cosY; // z after Y-rotation

    // ── X-AXIS ROTATION ──
    const cosX = Math.cos(rotX); // cos(φ)
    const sinX = Math.sin(rotX); // sin(φ)
    const rx2 =  rx1;                      // x unchanged by X-rotation
    const ry2 =  ry1 * cosX - rz1 * sinX; // y after X-rotation
    const rz2 =  ry1 * sinX + rz1 * cosX; // z after X-rotation

    // ── PERSPECTIVE PROJECTION ──
    const denom = rz2 + focal; // Denominator: z + focalLength; must be > 0 (behind camera = skip)
    if (denom <= 0.01) return { sx: cx, sy: cy }; // Vertex behind camera: project to center (degenerate)

    const sx = cx + (rx2 * focal / denom) * scale; // Screen X: project + offset to canvas center
    const sy = cy - (ry2 * focal / denom) * scale; // Screen Y: negate Y because canvas Y-axis points DOWN

    return { sx, sy };
  };

  // ─── RENDER FUNCTION ──────────────────────────────────────────────────────

  /**
   * Draw one frame of the hologram onto a given canvas context.
   * Called every animation frame for both thumbnail and expanded views.
   *
   * @param ctx      Canvas 2D rendering context
   * @param size     Canvas width/height in pixels (always square)
   * @param rotY     Current Y-rotation angle in radians
   * @param rotX     Current X-rotation angle in radians
   * @param focal    Current focal length
   * @param frame    Current frame count (for scanlines and flicker)
   * @param scanOff  Current scanline scroll offset in pixels
   * @param assembleGlow  Extra glow multiplier during assembly (0–1)
   */
  const renderFrame = useCallback((
    ctx: CanvasRenderingContext2D,
    size: number,
    rotY: number,
    rotX: number,
    focal: number,
    frame: number,
    scanOff: number,
    assembleGlow: number
  ) => {
    const cx = size / 2; // Canvas center X (pixel)
    const cy = size / 2; // Canvas center Y (pixel)
    const scale = size * 0.32; // 32% of canvas size per model unit; keeps shape well-framed

    // ── CLEAR CANVAS ────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, size, size); // Clear to transparent so catalog background shows through

    // ── FLICKER ─────────────────────────────────────────────────────────────
    // Every FLICKER_INTERVAL frames, drop opacity for FLICKER_DURATION frames.
    // This simulates holographic interference — a classic sci-fi hologram effect.
    const isFlickering = (frame % FLICKER_INTERVAL) < FLICKER_DURATION;
    ctx.globalAlpha = isFlickering ? FLICKER_OPACITY : 1.0; // Apply hologram flicker

    // ── ASSEMBLY GLOW BOOST ──────────────────────────────────────────────────
    // When assembling, the hologram glows brighter to show it's "being installed".
    // We achieve this by adding a cyan radial gradient fill behind the wireframe.
    if (assembleGlow > 0.01) {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.5);
      // Center is bright cyan at 30% base alpha × assembleGlow; edge fades to transparent
      grad.addColorStop(0,   `rgba(0,255,200,${0.30 * assembleGlow})`);
      grad.addColorStop(0.5, `rgba(0,200,255,${0.15 * assembleGlow})`);
      grad.addColorStop(1,   `rgba(0,0,0,0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size); // Fill the radial gradient behind everything
    }

    // ── PERSPECTIVE GRID FLOOR ───────────────────────────────────────────────
    // Draw a 5×5 grid of lines on the Y = GRID_Y plane in model space.
    // The grid helps the viewer understand the 3D orientation by grounding the part.
    ctx.strokeStyle = `rgba(0,200,255,${GRID_ALPHA})`; // Faint cyan grid
    ctx.lineWidth = 0.5; // Very thin lines for the grid
    ctx.globalAlpha = isFlickering ? FLICKER_OPACITY : 1.0;

    for (let i = 0; i <= GRID_LINES; i++) {
      // Grid lines parallel to Z axis (running front-to-back)
      const xGrid = -GRID_EXTENT + (i / GRID_LINES) * GRID_EXTENT * 2; // X positions from -GRID_EXTENT to +GRID_EXTENT
      const frontZ =  GRID_EXTENT; // Near edge of the grid
      const backZ  = -GRID_EXTENT; // Far edge of the grid

      // Project the two endpoints of this Z-aligned grid line
      const pF = project(xGrid, GRID_Y, frontZ, rotY, rotX, focal, scale, cx, cy);
      const pB = project(xGrid, GRID_Y, backZ,  rotY, rotX, focal, scale, cx, cy);
      ctx.beginPath();
      ctx.moveTo(pF.sx, pF.sy);
      ctx.lineTo(pB.sx, pB.sy);
      ctx.stroke();

      // Grid lines parallel to X axis (running side-to-side)
      const zGrid = -GRID_EXTENT + (i / GRID_LINES) * GRID_EXTENT * 2;
      const leftX  = -GRID_EXTENT;
      const rightX =  GRID_EXTENT;

      const pL = project(leftX,  GRID_Y, zGrid, rotY, rotX, focal, scale, cx, cy);
      const pR = project(rightX, GRID_Y, zGrid, rotY, rotX, focal, scale, cx, cy);
      ctx.beginPath();
      ctx.moveTo(pL.sx, pL.sy);
      ctx.lineTo(pR.sx, pR.sy);
      ctx.stroke();
    }

    // ── PROJECT ALL VERTICES ─────────────────────────────────────────────────
    // Project every vertex once and cache the screen coordinates.
    // This avoids re-projecting the same vertex for every edge that uses it.
    const projected: Array<{ sx: number; sy: number }> = shape.vertices.map((v) =>
      project(v.x, v.y, v.z, rotY, rotX, focal, scale, cx, cy)
    );

    // Determine the primary color of the wireframe from the shape definition
    const baseColor = shape.color; // e.g., "#00ffff" for most parts

    // ── GLOW PASS (wide, dim line) ───────────────────────────────────────────
    // Draw every edge at 3px width with low alpha. The blurring of adjacent pixels
    // creates a "glow halo" effect without needing CSS blur (which is slow on canvas).
    ctx.lineWidth = GLOW_WIDTH + (assembleGlow * 2); // Glow gets thicker during assembly
    ctx.strokeStyle = hexToRgba(baseColor, GLOW_ALPHA + assembleGlow * 0.2); // More opaque during assembly

    for (const [i, j] of shape.edges) {
      const pa = projected[i]; // Start point
      const pb = projected[j]; // End point
      ctx.beginPath();
      ctx.moveTo(pa.sx, pa.sy);
      ctx.lineTo(pb.sx, pb.sy);
      ctx.stroke(); // Glow pass draws every edge first with the wide dim line
    }

    // ── CORE LINE PASS (thin, bright line) ────────────────────────────────────
    // Draw every edge again at 1px width with high alpha.
    // The combination of the glow pass + this bright core creates the holographic look:
    // a bright line surrounded by a soft cyan halo.
    ctx.lineWidth = LINE_WIDTH;
    ctx.strokeStyle = hexToRgba(baseColor, LINE_ALPHA);

    for (const [i, j] of shape.edges) {
      const pa = projected[i];
      const pb = projected[j];
      ctx.beginPath();
      ctx.moveTo(pa.sx, pa.sy);
      ctx.lineTo(pb.sx, pb.sy);
      ctx.stroke();
    }

    // ── VERTEX DOTS ─────────────────────────────────────────────────────────
    // Small bright circles at each vertex. In real holographic displays (and sci-fi films),
    // vertices often have a bright "node" — emphasizes the digital wireframe aesthetic.
    ctx.fillStyle = `rgba(255,255,255,${VERTEX_ALPHA})`; // White vertex dots (bright against cyan lines)

    for (const { sx, sy } of projected) {
      ctx.beginPath();
      ctx.arc(sx, sy, VERTEX_RADIUS, 0, Math.PI * 2); // Small circle at each vertex position
      ctx.fill();
    }

    // ── SCANLINE OVERLAY ─────────────────────────────────────────────────────
    // Horizontal semi-transparent lines scrolling downward simulate a CRT or holographic
    // projector scanline raster. The offset is updated each frame to create motion.
    ctx.strokeStyle = `rgba(0,0,0,${SCANLINE_ALPHA})`; // Dark scanlines (slightly darken what's behind)
    ctx.lineWidth = 1;

    // Start offset keeps scanlines cycling continuously
    const startY = scanOff % SCANLINE_SPACING; // Start from the current scroll offset modulo spacing
    for (let y = startY; y < size; y += SCANLINE_SPACING) {
      ctx.beginPath();
      ctx.moveTo(0, y);      // Full-width horizontal scanline
      ctx.lineTo(size, y);
      ctx.stroke();
    }

    // Reset global alpha to 1 after we're done (don't leak flicker state to other elements)
    ctx.globalAlpha = 1.0;

  }, [shape]); // Re-creates only when shape changes (part changes)

  // ─── ANIMATION LOOP ───────────────────────────────────────────────────────

  /**
   * Start the thumbnail animation loop.
   * Uses requestAnimationFrame for smooth rendering; capped at THUMBNAIL_FPS.
   * Pauses automatically when the thumbnail is out of the viewport (IntersectionObserver).
   */
  const startThumbnailLoop = useCallback(() => {
    const canvas = thumbCanvasRef.current;
    if (!canvas) return; // Canvas not mounted: skip

    const ctx = canvas.getContext("2d");
    if (!ctx) return; // Canvas 2D context not available

    const frameDuration = 1000 / THUMBNAIL_FPS; // ms per frame at target FPS

    const loop = (timestamp: number) => {
      animFrameRef.current = requestAnimationFrame(loop); // Schedule next frame first (before heavy work)

      // ── FPS CAP ────────────────────────────────────────────────────────
      const delta = timestamp - lastTimeRef.current; // ms since last frame
      if (delta < frameDuration) return; // Too soon: skip this frame to maintain 30 FPS cap
      lastTimeRef.current = timestamp - (delta % frameDuration); // Carry over excess time to stay accurate

      // ── PAUSE WHEN OFF-SCREEN ────────────────────────────────────────────
      if (!isVisibleRef.current) return; // Off-screen: skip render to save CPU

      // ── UPDATE ROTATION ─────────────────────────────────────────────────
      const dt = Math.min(delta, 100) / 1000; // dt in seconds; clamp to prevent huge jumps after tab switch
      const speed = isHovered
        ? HOVER_ROT_SPEED + (isAssembling ? 1.5 : 0) // Assembly: even faster spin
        : IDLE_ROT_SPEED  + (isAssembling ? 0.8 : 0); // Assembly: idle is also faster

      rotYRef.current += speed * dt; // Advance Y rotation by speed × delta-time (physics-correct)

      // ── ADVANCE SCANLINES ───────────────────────────────────────────────
      scanOffsetRef.current = (scanOffsetRef.current + SCANLINE_SPEED) % SCANLINE_SPACING;

      // ── RENDER ──────────────────────────────────────────────────────────
      frameCountRef.current++;
      renderFrame(
        ctx,
        THUMBNAIL_SIZE,
        rotYRef.current,
        rotXRef.current,
        FOCAL_LENGTH_THUMBNAIL,
        frameCountRef.current,
        scanOffsetRef.current,
        isAssembling ? assemblyProgress : 0 // Pass assembly progress for glow
      );
    };

    animFrameRef.current = requestAnimationFrame(loop); // Kick off the animation loop
  }, [isHovered, isAssembling, assemblyProgress, renderFrame]);

  /**
   * Start the expanded modal animation loop.
   * Runs at EXPANDED_FPS (60 fps) for smooth drag interaction.
   */
  const startModalLoop = useCallback(() => {
    const canvas = modalCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const frameDuration = 1000 / EXPANDED_FPS; // ms per frame at 60 FPS

    const loop = (timestamp: number) => {
      modalFrameRef.current = requestAnimationFrame(loop); // Schedule next

      const delta = timestamp - lastTimeRef.current;
      if (delta < frameDuration) return; // Cap at 60 FPS
      lastTimeRef.current = timestamp - (delta % frameDuration);

      // Only auto-rotate if not being dragged (drag controls rotation directly)
      if (!isDraggingRef.current) {
        const dt = Math.min(delta, 100) / 1000;
        rotYRef.current += IDLE_ROT_SPEED * dt; // Slow auto-rotation while not dragging
      }

      scanOffsetRef.current = (scanOffsetRef.current + SCANLINE_SPEED) % SCANLINE_SPACING;
      frameCountRef.current++;

      renderFrame(
        ctx,
        EXPANDED_SIZE,
        rotYRef.current,
        rotXRef.current,
        focalRef.current, // Use the zoomable focal length in expanded view
        frameCountRef.current,
        scanOffsetRef.current,
        0 // No assembly glow in the expanded modal view
      );
    };

    lastTimeRef.current = performance.now(); // Reset timer so delta starts fresh
    modalFrameRef.current = requestAnimationFrame(loop);
  }, [renderFrame]);

  // ─── LIFECYCLE EFFECTS ────────────────────────────────────────────────────

  /**
   * Mount effect: set up IntersectionObserver to pause animation when off-screen.
   * The IntersectionObserver fires when the canvas enters/exits the viewport.
   * Without this, every hologram in the catalog would run continuously — wasting CPU.
   */
  useEffect(() => {
    const canvas = thumbCanvasRef.current;
    if (!canvas) return;

    // IntersectionObserver: threshold=0 means any pixel visibility counts
    observerRef.current = new IntersectionObserver(
      (entries) => {
        // entries[0].isIntersecting: true when any part of the canvas is in the viewport
        isVisibleRef.current = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0 } // Fire as soon as even 1px is visible or leaves view
    );

    observerRef.current.observe(canvas); // Start watching this canvas element

    return () => {
      observerRef.current?.disconnect(); // Clean up observer when component unmounts
    };
  }, []); // Only run on mount (canvas ref doesn't change)

  /**
   * Start/restart the thumbnail animation loop whenever hover or assembly state changes.
   * We cancel the previous loop before starting a new one to avoid double-running.
   */
  useEffect(() => {
    cancelAnimationFrame(animFrameRef.current); // Stop any existing thumbnail loop
    startThumbnailLoop();                        // Start fresh with new speed settings

    return () => {
      cancelAnimationFrame(animFrameRef.current); // Stop on cleanup / re-run
    };
  }, [startThumbnailLoop]); // startThumbnailLoop is memoized on isHovered/isAssembling

  /**
   * Start/stop the modal animation loop when the expanded view opens/closes.
   * We reset the focal length to default when the modal opens.
   */
  useEffect(() => {
    if (isExpanded) {
      focalRef.current = FOCAL_LENGTH_EXPANDED; // Reset zoom when modal opens
      lastTimeRef.current = 0; // Reset frame timer
      // Give the modal canvas one microtask to mount before starting the loop
      const handle = requestAnimationFrame(() => startModalLoop());
      return () => {
        cancelAnimationFrame(handle);
        cancelAnimationFrame(modalFrameRef.current); // Stop modal loop when closed
      };
    } else {
      cancelAnimationFrame(modalFrameRef.current); // Stop modal loop when modal closes
    }
  }, [isExpanded, startModalLoop]);

  // ─── DRAG HANDLERS (EXPANDED VIEW) ────────────────────────────────────────

  /**
   * Start a drag: record starting mouse position and current rotation angles.
   * Dragging will rotate the model around the Y and X axes.
   */
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingRef.current = true; // Mark as dragging
    dragStartRef.current = { x: e.clientX, y: e.clientY }; // Record start position
    rotYAtDragStart.current = rotYRef.current; // Snapshot current rotation
    rotXAtDragStart.current = rotXRef.current;
    e.preventDefault(); // Prevent text selection during drag
  }, []);

  /**
   * Update rotation based on mouse movement during drag.
   * dx (horizontal movement) rotates around Y axis (yaw).
   * dy (vertical movement) rotates around X axis (pitch).
   * The sensitivity factor converts pixels to radians — 200px = ~1 radian.
   */
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current || !dragStartRef.current) return; // Not dragging: ignore

    const dx = e.clientX - dragStartRef.current.x; // Horizontal drag distance in pixels
    const dy = e.clientY - dragStartRef.current.y; // Vertical drag distance in pixels

    const sensitivity = 0.005; // radians per pixel; 200px drag = 1 radian ≈ 57° rotation
    rotYRef.current = rotYAtDragStart.current + dx * sensitivity; // Y-axis = horizontal drag
    rotXRef.current = rotXAtDragStart.current + dy * sensitivity; // X-axis = vertical drag

    // Clamp X rotation to ±80° so the model doesn't flip upside down
    rotXRef.current = Math.max(-1.4, Math.min(1.4, rotXRef.current)); // ±80° = ±1.4 radians
  }, []);

  /**
   * End drag: release the dragging state.
   */
  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false; // No longer dragging; auto-rotation resumes
    dragStartRef.current = null;
  }, []);

  /**
   * Mouse wheel: zoom in/out by adjusting the focal length.
   * Larger focal length = narrower FOV (objects appear larger, less depth distortion).
   * Smaller focal length = wider FOV (fisheye effect; shows more depth perspective).
   *
   * Real camera analogy: scroll-up = zoom in (telephoto), scroll-down = zoom out (wide-angle).
   */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault(); // Prevent page scroll while zooming the hologram
    const zoomDelta = e.deltaY * 0.005; // Convert scroll wheel delta to focal length change
    focalRef.current = Math.max(1.5, Math.min(10, focalRef.current - zoomDelta));
    // Clamp: 1.5 = extreme wide angle (almost fisheye), 10 = very telephoto (flat, no depth)
  }, []);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── THUMBNAIL CANVAS ──────────────────────────────────────────────── */}
      <div
        style={{
          position: "relative",          // Needed for any absolute-positioned children
          display: "inline-block",        // Size wraps the canvas exactly
          cursor: "pointer",              // Pointer indicates it's clickable
          flexShrink: 0,                  // Don't shrink when catalog list is narrow
        }}
        onMouseEnter={() => setIsHovered(true)}  // Trigger faster rotation on hover
        onMouseLeave={() => setIsHovered(false)} // Revert to idle rotation
        onClick={() => setIsExpanded(true)}      // Click to open expanded modal view
        title="Click to inspect part in 3D"      // Tooltip on hover
      >
        <canvas
          ref={thumbCanvasRef}
          width={THUMBNAIL_SIZE}
          height={THUMBNAIL_SIZE}
          style={{
            display: "block",                     // Remove inline-block gap
            borderRadius: "4px",                  // Rounded corners match catalog tile style
            border: isHovered
              ? "1px solid rgba(0,255,255,0.7)"   // Bright cyan border when hovered
              : "1px solid rgba(0,200,255,0.25)", // Faint border when idle
            backgroundColor: "rgba(0,5,15,0.85)", // Very dark bg — makes cyan glow pop
            transition: "border-color 0.2s",       // Smooth border color transition on hover
            boxShadow: isHovered
              ? "0 0 8px rgba(0,255,255,0.4)"     // Glow shadow on hover
              : "none",
          }}
        />
        {/* Hover hint label: "3D" badge in bottom-right corner */}
        {isHovered && (
          <div style={{
            position: "absolute",
            bottom: 3,
            right: 4,
            fontSize: "8px",
            color: "rgba(0,255,255,0.8)",
            pointerEvents: "none", // This label should not capture mouse events
            fontFamily: "monospace",
            letterSpacing: "1px",
          }}>
            3D
          </div>
        )}
      </div>

      {/* ── EXPANDED MODAL ────────────────────────────────────────────────── */}
      {isExpanded && (
        <div
          style={{
            position: "fixed",           // Fixed: overlays entire viewport regardless of scroll
            inset: 0,                    // Covers the entire screen
            backgroundColor: "rgba(0,0,0,0.75)", // Semi-transparent dark backdrop
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,                // Above everything else in the UI
          }}
          onClick={() => setIsExpanded(false)} // Click backdrop to close modal
        >
          {/* Modal content: stop propagation so clicking the hologram doesn't close the modal */}
          <div
            style={{
              position: "relative",
              backgroundColor: "rgba(3,8,20,0.97)", // Very dark background for modal
              border: "1px solid rgba(0,255,255,0.5)",
              borderRadius: "8px",
              padding: "16px",
              display: "flex",
              gap: "20px",
              alignItems: "flex-start",
              boxShadow: "0 0 40px rgba(0,200,255,0.25)", // Outer glow on modal border
            }}
            onClick={(e) => e.stopPropagation()} // Prevent backdrop click from firing
          >
            {/* Close button: top-right corner of the modal */}
            <button
              onClick={() => setIsExpanded(false)}
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                background: "none",
                border: "1px solid rgba(0,255,255,0.4)",
                color: "rgba(0,255,255,0.8)",
                cursor: "pointer",
                fontSize: "14px",
                width: 24,
                height: 24,
                borderRadius: "4px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "monospace",
              }}
            >
              ×
            </button>

            {/* Expanded canvas: drag to rotate, scroll to zoom */}
            <div>
              <canvas
                ref={modalCanvasRef}
                width={EXPANDED_SIZE}
                height={EXPANDED_SIZE}
                style={{
                  display: "block",
                  borderRadius: "4px",
                  border: "1px solid rgba(0,255,255,0.5)",
                  backgroundColor: "rgba(0,5,15,0.95)",
                  cursor: isDraggingRef.current ? "grabbing" : "grab", // Cursor feedback
                  userSelect: "none", // Prevent text selection during drag
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp} // Release drag if cursor leaves canvas
                onWheel={handleWheel}
              />
              {/* Instructions below the canvas */}
              <div style={{
                marginTop: 6,
                fontSize: "10px",
                color: "rgba(0,200,255,0.5)",
                textAlign: "center",
                fontFamily: "monospace",
              }}>
                drag to rotate · scroll to zoom
              </div>
            </div>

            {/* Part info panel: part label + instructions */}
            <div style={{ maxWidth: 160, paddingTop: 4 }}>
              <div style={{
                fontSize: "14px",
                fontWeight: "bold",
                color: "rgba(0,255,255,0.9)",
                marginBottom: 8,
                fontFamily: "monospace",
                letterSpacing: "1px",
              }}>
                {shape.label} {/* Part name from the shape definition */}
              </div>
              <div style={{ fontSize: "10px", color: "rgba(0,200,200,0.5)", fontFamily: "monospace", lineHeight: 1.5 }}>
                HOLOGRAPHIC PREVIEW<br/>
                <span style={{ color: "rgba(0,150,150,0.5)" }}>
                  Wireframe model<br/>
                  rendering in 3D
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Convert a CSS hex color string like "#00ffcc" to an rgba() string with given alpha.
 * Used to set strokeStyle with custom opacity without using ctx.globalAlpha
 * (which would affect everything drawn after it).
 *
 * PARSING: Split the 6-hex-digit string into R, G, B pairs and parse each as base-16.
 * e.g., "#00ffcc" → r=0, g=255, b=204 → "rgba(0,255,204,0.8)"
 *
 * @param hex    CSS hex color string (must be 7 chars: "#rrggbb")
 * @param alpha  Opacity value 0.0–1.0
 * @returns      CSS rgba() string
 */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16); // Extract red channel: chars 1-2, base 16
  const g = parseInt(hex.slice(3, 5), 16); // Extract green channel: chars 3-4
  const b = parseInt(hex.slice(5, 7), 16); // Extract blue channel: chars 5-6
  return `rgba(${r},${g},${b},${alpha})`; // Compose rgba string
}

/**
 * Create a minimal placeholder wireframe cube for parts with no shape defined.
 * This prevents a blank canvas if a part ID doesn't exist in PART_SHAPES.
 * The cube has 8 vertices and 12 edges (all 6 faces × 2 diagonals avoided for clarity).
 */
function makePlaceholderShape(): Shape3D {
  // A unit cube: 8 corners at ±0.5 in each axis
  const h = 0.5; // Half-size
  return {
    vertices: [
      { x: -h, y:  h, z: -h }, { x:  h, y:  h, z: -h }, // 0,1 top-back
      { x:  h, y:  h, z:  h }, { x: -h, y:  h, z:  h }, // 2,3 top-front
      { x: -h, y: -h, z: -h }, { x:  h, y: -h, z: -h }, // 4,5 bot-back
      { x:  h, y: -h, z:  h }, { x: -h, y: -h, z:  h }, // 6,7 bot-front
    ],
    edges: [
      [0,1],[1,2],[2,3],[3,0], // Top face
      [4,5],[5,6],[6,7],[7,4], // Bottom face
      [0,4],[1,5],[2,6],[3,7], // Vertical edges
    ],
    color: "#00ffff", // Default cyan placeholder color
    label: "Unknown",
  };
}

export default HologramViewer;
