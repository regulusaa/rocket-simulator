/**
 * PART SHAPE DEFINITIONS
 * ======================
 * 3D wireframe geometry for every rocket part in the catalog.
 * Each shape is a list of 3D vertices (x, y, z) and edges (pairs of vertex indices).
 * The coordinate system is: Y-up (positive Y = top of the part), X and Z are horizontal.
 * All shapes are normalized to fit inside a [-1, 1] cube so the renderer can scale them.
 *
 * HOW WIREFRAME RENDERING WORKS (brief, full math is in HologramViewer.tsx):
 *   1. Rotate each vertex using Y-axis and X-axis rotation matrices
 *   2. Project the rotated 3D point onto a 2D screen using perspective division
 *   3. Draw lines between projected vertex pairs (the edges array)
 *
 * WHY PURE GEOMETRY (no external 3D library):
 *   The hologram effect needs a dark-background glowing cyan wireframe — a look that's
 *   trivial with pure canvas line-drawing but awkward with WebGL or Three.js. The math
 *   is only ~20 lines, making a full 3D library unnecessary weight.
 */

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * A single 3D vertex in the part geometry.
 * x = right/left, y = up/down, z = toward camera / away from camera.
 */
export interface Vertex3D {
  x: number; // horizontal (right positive)
  y: number; // vertical (up positive)
  z: number; // depth (toward viewer is positive after rotation)
}

/**
 * Complete wireframe shape definition for one part.
 * vertices: all 3D points that make up the shape
 * edges: pairs of vertex indices; each pair draws one line segment
 * color: primary wireframe color for this part category
 * label: short text shown beneath the hologram in the viewer
 */
export interface Shape3D {
  vertices: Vertex3D[];          // 3D point cloud for this shape
  edges: Array<[number, number]>; // Line list: [from-index, to-index]
  color: string;                  // Primary wireframe glow color (CSS hex)
  label: string;                  // Text label rendered below the shape
}

// ─── GEOMETRY HELPERS ─────────────────────────────────────────────────────────

/**
 * Generate a horizontal circle of N vertices at a given Y height and radius.
 * Used to build cylinder tops/bottoms and cone rings.
 *
 * WHY: A circle in 3D (lying flat on the XZ plane at height y) has vertices:
 *   x = radius * cos(i * 2π/N)
 *   z = radius * sin(i * 2π/N)
 *   y = constant
 *
 * @param N       Number of vertices (segments) around the circle
 * @param radius  Radius of the circle in model units
 * @param y       Y (vertical) position of the circle
 * @param offset  Vertex index offset so edges can reference the right slice of the global vertex array
 * @returns       { verts: Vertex3D[], ring: number[] } — the vertices and their global indices
 */
function makeCircle(N: number, radius: number, y: number, offset: number): { verts: Vertex3D[]; ring: number[] } {
  const verts: Vertex3D[] = []; // Collect circle vertices
  const ring: number[] = [];    // Collect global vertex indices for edge generation

  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2; // Evenly distribute vertices around full circle (2π radians)
    verts.push({
      x: radius * Math.cos(angle), // X component of the circle point
      y,                            // Constant height for this ring
      z: radius * Math.sin(angle), // Z component of the circle point
    });
    ring.push(offset + i); // Record the global index of this vertex
  }

  return { verts, ring };
}

/**
 * Connect adjacent vertices in a ring with edges, closing the loop at the end.
 * e.g., ring [0,1,2,3] → edges [[0,1],[1,2],[2,3],[3,0]]
 *
 * @param ring  Array of vertex indices forming a closed loop
 * @returns     Array of edge pairs that draw the circle
 */
function ringEdges(ring: number[]): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < ring.length; i++) {
    edges.push([ring[i], ring[(i + 1) % ring.length]]); // % wraps the last vertex back to the first
  }
  return edges;
}

/**
 * Connect corresponding vertices of two rings with vertical lines.
 * Used to draw the side walls of cylinders and cones.
 * Both rings must have the same length (same number of vertices).
 *
 * @param topRing     Global indices of the top circle's vertices
 * @param bottomRing  Global indices of the bottom circle's vertices
 * @returns           Array of vertical edge pairs
 */
function verticalEdges(topRing: number[], bottomRing: number[]): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < topRing.length; i++) {
    edges.push([topRing[i], bottomRing[i]]); // Connect vertex i on the top ring to vertex i on the bottom ring
  }
  return edges;
}

// ─── ENGINE SHAPES ────────────────────────────────────────────────────────────

/**
 * Build an engine shape with customizable nozzle proportions.
 * The engine has three components:
 *   1. Combustion chamber (narrow cylinder at the top): represents the chamber where fuel burns
 *   2. Bell nozzle (truncated cone flaring outward): the iconic skirt shape that accelerates exhaust
 *   3. Turbopump housing (small box on the side): real engines have a pump visible on the outside
 *   4. Gimbal ring (thin circle around the chamber throat): represents the gimbal joint for TVC
 *
 * Real nozzle expansion ratio = (exit area) / (throat area) = (exitRadius/throatRadius)²
 * The RS-25 has a 77.5:1 expansion ratio; the Rutherford is ~10:1.
 * We exaggerate these slightly so the shapes look distinct at small canvas sizes.
 *
 * @param chamberRadius  Radius of the combustion chamber (top cylinder)
 * @param exitRadius     Radius of the nozzle exit (bottom of bell)
 * @param chamberHeight  Height of the cylindrical combustion chamber section
 * @param bellHeight     Height of the bell nozzle section
 * @param color          Primary wireframe color
 * @param label          Text label for the hologram viewer
 */
function makeEngineShape(
  chamberRadius: number,
  exitRadius: number,
  chamberHeight: number,
  bellHeight: number,
  color: string,
  label: string
): Shape3D {
  const vertices: Vertex3D[] = []; // All vertices accumulated here
  const edges: Array<[number, number]> = []; // All edges accumulated here

  const N = 12; // 12-sided circles: enough for a smooth appearance at hologram scale

  // ── COMBUSTION CHAMBER ────────────────────────────────────────────────────
  // Top ring of the chamber (inlet): sits at y = chamberHeight/2
  const chamberTopY = chamberHeight / 2; // Y position of the top of the chamber
  const chamberBotY = -chamberHeight / 2 + bellHeight * 0.1; // Y position of the bottom of the chamber (slightly into the bell)

  const { verts: ctv, ring: chamberTopRing } = makeCircle(N, chamberRadius, chamberTopY, vertices.length);
  vertices.push(...ctv); // Add chamber top ring vertices to global list
  edges.push(...ringEdges(chamberTopRing)); // Draw top circle

  const { verts: cbv, ring: chamberBotRing } = makeCircle(N, chamberRadius, chamberBotY, vertices.length);
  vertices.push(...cbv); // Add chamber bottom ring vertices
  edges.push(...ringEdges(chamberBotRing)); // Draw bottom circle of chamber
  edges.push(...verticalEdges(chamberTopRing, chamberBotRing)); // Draw vertical walls of chamber

  // ── BELL NOZZLE ───────────────────────────────────────────────────────────
  // The nozzle is a truncated cone: narrow at the top (throat) and wide at the bottom (exit).
  // We approximate the curved bell profile with two rings and a straight line —
  // this reads clearly at hologram scale without needing a curved surface.
  const nozzleTopY = chamberBotY; // Nozzle top connects to the bottom of the chamber
  const nozzleTopRadius = chamberRadius * 0.7; // Throat is narrower than the chamber (nozzle effect)
  const nozzleMidY = nozzleTopY - bellHeight * 0.5; // Mid-ring at halfway down for bell curvature hint
  const nozzleMidRadius = (nozzleTopRadius + exitRadius) * 0.45; // Intermediate radius follows parabolic bell curve
  const nozzleBotY = nozzleTopY - bellHeight; // Bottom of the nozzle (exit plane)

  const { verts: ntv, ring: nozzleTopRing } = makeCircle(N, nozzleTopRadius, nozzleTopY, vertices.length);
  vertices.push(...ntv);
  edges.push(...ringEdges(nozzleTopRing));

  const { verts: nmv, ring: nozzleMidRing } = makeCircle(N, nozzleMidRadius, nozzleMidY, vertices.length);
  vertices.push(...nmv);
  edges.push(...ringEdges(nozzleMidRing)); // Mid-ring suggests the bell curve
  edges.push(...verticalEdges(nozzleTopRing, nozzleMidRing)); // Upper half of bell sides

  const { verts: nbv, ring: nozzleBotRing } = makeCircle(N, exitRadius, nozzleBotY, vertices.length);
  vertices.push(...nbv);
  edges.push(...ringEdges(nozzleBotRing)); // Draw nozzle exit circle
  edges.push(...verticalEdges(nozzleMidRing, nozzleBotRing)); // Lower half of bell sides

  // ── GIMBAL RING ───────────────────────────────────────────────────────────
  // The gimbal ring is a circle slightly larger than the chamber at the throat junction.
  // It represents the actuator ring that tilts the engine for thrust vector control (TVC).
  const gimbalY = chamberBotY + bellHeight * 0.05; // Just below the chamber/nozzle junction
  const gimbalRadius = chamberRadius * 1.2; // Slightly larger than chamber so it's visible
  const { verts: gv, ring: gimbalRing } = makeCircle(8, gimbalRadius, gimbalY, vertices.length); // 8 sides: simpler ring
  vertices.push(...gv);
  edges.push(...ringEdges(gimbalRing)); // Draw the gimbal ring as a standalone circle

  // ── TURBOPUMP HOUSING ─────────────────────────────────────────────────────
  // Real engines (Merlin, RS-25, Raptor) have a visible turbopump on the side.
  // We draw a small box at y ≈ 0.25 to represent this housing.
  // Box vertices: 4 vertices form a quadrilateral (we skip depth to keep it simple)
  const pumpBase = vertices.length; // Index of the first pump vertex
  const px = chamberRadius + 0.08; // X offset: place the pump box just outside the chamber wall
  const pw = 0.12;  // Half-width of the pump box in X
  const ph = 0.15;  // Half-height of the pump box in Y
  const pz = 0.08;  // Depth of the pump box in Z (flat box visible from the side)

  // Four corners of the front face of the pump box
  vertices.push({ x: px,      y: chamberHeight * 0.3 + ph, z:  pz }); // top-right-front  (+0)
  vertices.push({ x: px + pw, y: chamberHeight * 0.3 + ph, z:  pz }); // top-left-front   (+1)
  vertices.push({ x: px + pw, y: chamberHeight * 0.3 - ph, z:  pz }); // bot-left-front   (+2)
  vertices.push({ x: px,      y: chamberHeight * 0.3 - ph, z:  pz }); // bot-right-front  (+3)
  // Four corners of the back face of the pump box
  vertices.push({ x: px,      y: chamberHeight * 0.3 + ph, z: -pz }); // top-right-back   (+4)
  vertices.push({ x: px + pw, y: chamberHeight * 0.3 + ph, z: -pz }); // top-left-back    (+5)
  vertices.push({ x: px + pw, y: chamberHeight * 0.3 - ph, z: -pz }); // bot-left-back    (+6)
  vertices.push({ x: px,      y: chamberHeight * 0.3 - ph, z: -pz }); // bot-right-back   (+7)

  // Front face edges
  edges.push([pumpBase + 0, pumpBase + 1]); // top edge
  edges.push([pumpBase + 1, pumpBase + 2]); // right edge
  edges.push([pumpBase + 2, pumpBase + 3]); // bottom edge
  edges.push([pumpBase + 3, pumpBase + 0]); // left edge
  // Back face edges
  edges.push([pumpBase + 4, pumpBase + 5]);
  edges.push([pumpBase + 5, pumpBase + 6]);
  edges.push([pumpBase + 6, pumpBase + 7]);
  edges.push([pumpBase + 7, pumpBase + 4]);
  // Connecting edges between front and back faces
  edges.push([pumpBase + 0, pumpBase + 4]);
  edges.push([pumpBase + 1, pumpBase + 5]);
  edges.push([pumpBase + 2, pumpBase + 6]);
  edges.push([pumpBase + 3, pumpBase + 7]);

  return { vertices, edges, color, label };
}

// ─── FUEL TANK SHAPES ─────────────────────────────────────────────────────────

/**
 * Build a fuel tank shape with domed ends and internal baffles.
 * A real propellant tank is a cylinder capped with ellipsoidal domes.
 * The domes prevent propellant from sloshing — the hemispherical shape distributes
 * pressure evenly (a sphere is the optimal pressure vessel geometry).
 * We approximate the domes with 8-vertex arcs on the XY plane at 4 rotations.
 *
 * @param radius       Outer radius of the cylindrical tank body
 * @param bodyHeight   Height of the straight cylindrical section (not including domes)
 * @param domeHeight   Height of the top and bottom dome sections
 * @param color        Primary wireframe color
 * @param label        Text label
 */
function makeTankShape(
  radius: number,
  bodyHeight: number,
  domeHeight: number,
  color: string,
  label: string
): Shape3D {
  const vertices: Vertex3D[] = [];
  const edges: Array<[number, number]> = [];

  const N = 12; // 12-sided circles for the cylinder body

  // ── CYLINDER BODY ─────────────────────────────────────────────────────────
  const bodyTopY = bodyHeight / 2;  // Top edge of the straight cylinder
  const bodyBotY = -bodyHeight / 2; // Bottom edge of the straight cylinder

  const { verts: tv, ring: topRing } = makeCircle(N, radius, bodyTopY, vertices.length);
  vertices.push(...tv);
  edges.push(...ringEdges(topRing));

  const { verts: bv, ring: botRing } = makeCircle(N, radius, bodyBotY, vertices.length);
  vertices.push(...bv);
  edges.push(...ringEdges(botRing));
  edges.push(...verticalEdges(topRing, botRing)); // Cylinder walls

  // ── INTERNAL BAFFLES ──────────────────────────────────────────────────────
  // Propellant slosh baffles are horizontal rings inside the tank that break up
  // standing waves in the liquid propellant (especially dangerous during oscillations).
  // We draw two internal rings at 1/3 and 2/3 height to represent these baffles.
  const baffle1Y = bodyBotY + bodyHeight * 0.33; // Lower baffle at 33% height
  const baffle2Y = bodyBotY + bodyHeight * 0.67; // Upper baffle at 67% height
  const baffleRadius = radius * 0.85; // Slightly smaller than the tank: real baffles have a gap at the wall

  const { verts: b1v, ring: baffle1Ring } = makeCircle(8, baffleRadius, baffle1Y, vertices.length); // 8-sided baffle is simpler
  vertices.push(...b1v);
  edges.push(...ringEdges(baffle1Ring));

  const { verts: b2v, ring: baffle2Ring } = makeCircle(8, baffleRadius, baffle2Y, vertices.length);
  vertices.push(...b2v);
  edges.push(...ringEdges(baffle2Ring));

  // ── TOP DOME ──────────────────────────────────────────────────────────────
  // The top dome is a hemisphere approximated with 4 meridian arcs (8 points each).
  // Each meridian goes from the cylinder rim at bodyTopY up to the dome apex.
  // We generate 4 arcs at 0°, 45°, 90°, 135° around the tank to give 3D shape.
  const domeApexTopY = bodyTopY + domeHeight; // Y position of the dome tip
  for (let meridian = 0; meridian < 4; meridian++) {
    // Each meridian arc sits on a vertical plane rotated by (meridian * 45°) around Y axis
    const meridianAngle = (meridian / 4) * Math.PI; // 0°, 45°, 90°, 135° (only half-turn: each arc covers both sides)
    const arcBase = vertices.length; // First vertex of this arc
    const arcPoints = 6; // 6 points per meridian arc: enough to show curvature

    for (let j = 0; j <= arcPoints; j++) {
      // Arc from the cylinder rim (angle=0) to the apex (angle=π/2) — a quarter-circle arc
      const t = (j / arcPoints) * (Math.PI / 2); // Angle along the arc from 0 to π/2
      const r = radius * Math.cos(t); // Radius shrinks from full radius to 0 as we go to the apex
      const h = domeHeight * Math.sin(t); // Height above the cylinder rim grows to domeHeight at apex

      vertices.push({
        x: r * Math.cos(meridianAngle), // X component: radius projected onto this meridian plane
        y: bodyTopY + h,                 // Y: cylinder top + arc height
        z: r * Math.sin(meridianAngle), // Z component
      });

      // Also add the mirror vertex on the opposite side of the meridian
      if (j > 0 && j < arcPoints) { // Skip first and last: they coincide with rim and apex
        vertices.push({
          x: r * Math.cos(meridianAngle + Math.PI), // Opposite side: rotate meridian by 180°
          y: bodyTopY + h,
          z: r * Math.sin(meridianAngle + Math.PI),
        });
      }
    }

    // Connect the arc vertices with edges
    // Arc structure: vertex 0 = rim point, then alternating left/right, then apex
    // We connect each consecutive pair to draw the meridian line
    const arcLen = arcPoints + 1 + (arcPoints - 1); // Total vertices in this arc group
    for (let j = 0; j < arcLen - 1; j++) {
      edges.push([arcBase + j, arcBase + j + 1]); // Connect consecutive arc points
    }
  }

  // ── BOTTOM DOME (mirrored) ────────────────────────────────────────────────
  const domeApexBotY = bodyBotY - domeHeight; // Y position of the bottom dome tip
  void domeApexBotY; // Referenced in concept; bottom dome is symmetric to top
  for (let meridian = 0; meridian < 4; meridian++) {
    const meridianAngle = (meridian / 4) * Math.PI;
    const arcBase = vertices.length;
    const arcPoints = 6;

    for (let j = 0; j <= arcPoints; j++) {
      const t = (j / arcPoints) * (Math.PI / 2);
      const r = radius * Math.cos(t);
      const h = domeHeight * Math.sin(t);

      vertices.push({
        x: r * Math.cos(meridianAngle),
        y: bodyBotY - h, // Negative: dome extends downward
        z: r * Math.sin(meridianAngle),
      });

      if (j > 0 && j < arcPoints) {
        vertices.push({
          x: r * Math.cos(meridianAngle + Math.PI),
          y: bodyBotY - h,
          z: r * Math.sin(meridianAngle + Math.PI),
        });
      }
    }

    const arcLen = arcPoints + 1 + (arcPoints - 1);
    for (let j = 0; j < arcLen - 1; j++) {
      edges.push([arcBase + j, arcBase + j + 1]);
    }
  }

  // ── PIPE CONNECTIONS ──────────────────────────────────────────────────────
  // Short cylinders at the top and bottom represent the propellant feed lines.
  // Real tanks have inlet/outlet pipes for filling and for feeding the engines.
  const pipeBase = vertices.length;
  const pipeRadius = 0.08; // Small pipe: much narrower than the tank
  const pipeLen = 0.15;    // Short stub extending from the dome

  // Top pipe: 4 vertices forming a small square (simplified pipe cross-section)
  vertices.push({ x:  pipeRadius, y: domeApexTopY,           z:  pipeRadius });
  vertices.push({ x: -pipeRadius, y: domeApexTopY,           z:  pipeRadius });
  vertices.push({ x: -pipeRadius, y: domeApexTopY,           z: -pipeRadius });
  vertices.push({ x:  pipeRadius, y: domeApexTopY,           z: -pipeRadius });
  vertices.push({ x:  pipeRadius, y: domeApexTopY + pipeLen, z:  pipeRadius }); // +4
  vertices.push({ x: -pipeRadius, y: domeApexTopY + pipeLen, z:  pipeRadius }); // +5
  vertices.push({ x: -pipeRadius, y: domeApexTopY + pipeLen, z: -pipeRadius }); // +6
  vertices.push({ x:  pipeRadius, y: domeApexTopY + pipeLen, z: -pipeRadius }); // +7

  // Top pipe edges (square tube)
  edges.push([pipeBase + 0, pipeBase + 1], [pipeBase + 1, pipeBase + 2], [pipeBase + 2, pipeBase + 3], [pipeBase + 3, pipeBase + 0]); // bottom face
  edges.push([pipeBase + 4, pipeBase + 5], [pipeBase + 5, pipeBase + 6], [pipeBase + 6, pipeBase + 7], [pipeBase + 7, pipeBase + 4]); // top face
  edges.push([pipeBase + 0, pipeBase + 4], [pipeBase + 1, pipeBase + 5], [pipeBase + 2, pipeBase + 6], [pipeBase + 3, pipeBase + 7]); // side edges

  return { vertices, edges, color, label };
}

// ─── NOSE CONE SHAPES ─────────────────────────────────────────────────────────

/**
 * Build an ogive nose cone shape.
 * An ogive is a curved nose profile widely used in rocketry — it has lower wave
 * drag than a cone and lower base drag than a hemisphere.
 * The ogive curve is approximated with N points along the profile, then revolved
 * around the Y axis to create 8 longitudinal lines + 4 horizontal rings.
 *
 * OGIVE PROFILE MATH:
 *   The tangent ogive radius at station y (0=tip, 1=base) is:
 *   r(y) = R × sqrt(1 - (1 - y)²)  [for y normalized 0→1]
 *   This is a quarter-circle arc centered offset from the axis.
 *
 * @param baseRadius    Radius at the bottom (attaches to the rocket body)
 * @param totalHeight   Height from tip (y=top) to base (y=bottom)
 * @param sharpness     0.5=round, 1.0=sharp ogive; controls how quickly radius grows
 * @param color         Primary wireframe color
 * @param label         Text label
 */
function makeNoseConeShape(
  baseRadius: number,
  totalHeight: number,
  sharpness: number,
  color: string,
  label: string
): Shape3D {
  const vertices: Vertex3D[] = [];
  const edges: Array<[number, number]> = [];

  const profilePoints = 16; // 16 points along the profile gives smooth ogive curve
  const meridians = 8;      // 8 longitudinal lines: every 45° around the circumference

  // ── PROFILE CURVE ────────────────────────────────────────────────────────
  // Generate profile points: array of {radius, y} pairs from tip (top) to base (bottom).
  // The ogive curve: r = baseRadius * pow(t, 1/sharpness) where t goes 0→1 from tip to base.
  // sharpness=1: linear cone; sharpness=2: true ogive (parabolic-ish)
  const profile: Array<{ r: number; y: number }> = [];
  for (let i = 0; i <= profilePoints; i++) {
    const t = i / profilePoints; // 0 = tip, 1 = base
    const r = baseRadius * Math.pow(t, 1 / sharpness); // Ogive radius formula; higher sharpness = sharper tip
    const y = totalHeight / 2 - t * totalHeight; // Y from +totalHeight/2 (tip) to -totalHeight/2 (base)
    profile.push({ r, y });
  }

  // ── MERIDIAN LINES ────────────────────────────────────────────────────────
  // For each meridian angle, revolve the profile to create a longitudinal line.
  const meridianRingIndices: number[][] = []; // meridianRingIndices[profileIndex] = [v0, v1, ..., v7]

  for (let pi = 0; pi <= profilePoints; pi++) {
    const row: number[] = []; // Global vertex indices for this profile station
    for (let m = 0; m < meridians; m++) {
      const angle = (m / meridians) * Math.PI * 2; // 0, 45°, 90°, ... 315°
      const { r, y } = profile[pi];
      vertices.push({
        x: r * Math.cos(angle), // Revolve profile point around Y axis
        y,
        z: r * Math.sin(angle),
      });
      row.push(vertices.length - 1); // Record this vertex's global index
    }
    meridianRingIndices.push(row);
  }

  // Draw meridian lines: connect consecutive profile stations on each meridian
  for (let m = 0; m < meridians; m++) {
    for (let pi = 0; pi < profilePoints; pi++) {
      edges.push([meridianRingIndices[pi][m], meridianRingIndices[pi + 1][m]]); // Line along the meridian
    }
  }

  // ── HORIZONTAL RINGS ─────────────────────────────────────────────────────
  // Draw 4 horizontal rings at 25%, 50%, 75%, 100% of the profile length.
  // These rings help the viewer understand the 3D shape from different angles.
  const ringStations = [
    Math.floor(profilePoints * 0.25), // 1/4 of the way down
    Math.floor(profilePoints * 0.50), // Halfway
    Math.floor(profilePoints * 0.75), // 3/4 of the way down
    profilePoints,                     // Base ring
  ];

  for (const pi of ringStations) {
    const row = meridianRingIndices[pi]; // Vertex indices for this ring
    edges.push(...ringEdges(row));       // Connect all vertices in the ring
  }

  // ── PAYLOAD VOLUME INDICATOR ──────────────────────────────────────────────
  // Dashed lines (approximated with short segments) inside the nose cone showing
  // the internal payload volume. We draw a small cylinder inside the bottom half.
  const payloadBase = vertices.length;
  const payloadRadius = baseRadius * 0.6; // Payload area is smaller than full fairing diameter
  const payloadBotY = -totalHeight * 0.5; // Bottom = base of the fairing
  const payloadTopY = -totalHeight * 0.1; // Top = about 40% up from the base

  const { verts: ptv, ring: payloadTopRing } = makeCircle(8, payloadRadius, payloadTopY, payloadBase);
  vertices.push(...ptv);
  void payloadTopRing; // ring used conceptually

  const { verts: pbv } = makeCircle(8, payloadRadius, payloadBotY, vertices.length - ptv.length);
  // Recalculate ring indices since we've already pushed ptv
  const ptRing = Array.from({ length: 8 }, (_, i) => payloadBase + i);
  const pbRing = Array.from({ length: 8 }, (_, i) => payloadBase + 8 + i);
  vertices.push(...pbv);

  edges.push(...ringEdges(ptRing));  // Top ring of payload volume
  edges.push(...ringEdges(pbRing)); // Bottom ring of payload volume
  edges.push(...verticalEdges(ptRing, pbRing)); // Vertical walls

  return { vertices, edges, color, label };
}

// ─── RCS THRUSTER SHAPE ───────────────────────────────────────────────────────

/**
 * Build an RCS thruster cluster shape.
 * The RCS unit is a cube body with 4 miniature nozzles pointing outward in the
 * ±X and ±Z directions. Real RCS clusters (like on Dragon or Apollo) have
 * multiple nozzles oriented in different axes for 6-DOF attitude control.
 *
 * @param color  Primary wireframe color
 * @param label  Text label
 */
function makeRCSShape(color: string, label: string): Shape3D {
  const vertices: Vertex3D[] = [];
  const edges: Array<[number, number]> = [];

  // ── CUBE BODY ─────────────────────────────────────────────────────────────
  // The main housing is a cube of side length 0.4 centered at the origin.
  const h = 0.4; // Half-side of the cube
  const cubeBase = vertices.length;

  // 8 corners of the cube: all combinations of ±h in X, Y, Z
  vertices.push({ x: -h, y:  h, z: -h }); // 0: top-left-back
  vertices.push({ x:  h, y:  h, z: -h }); // 1: top-right-back
  vertices.push({ x:  h, y:  h, z:  h }); // 2: top-right-front
  vertices.push({ x: -h, y:  h, z:  h }); // 3: top-left-front
  vertices.push({ x: -h, y: -h, z: -h }); // 4: bot-left-back
  vertices.push({ x:  h, y: -h, z: -h }); // 5: bot-right-back
  vertices.push({ x:  h, y: -h, z:  h }); // 6: bot-right-front
  vertices.push({ x: -h, y: -h, z:  h }); // 7: bot-left-front

  // 12 edges of the cube: 4 top, 4 bottom, 4 vertical
  edges.push([cubeBase+0, cubeBase+1], [cubeBase+1, cubeBase+2], [cubeBase+2, cubeBase+3], [cubeBase+3, cubeBase+0]); // top face
  edges.push([cubeBase+4, cubeBase+5], [cubeBase+5, cubeBase+6], [cubeBase+6, cubeBase+7], [cubeBase+7, cubeBase+4]); // bot face
  edges.push([cubeBase+0, cubeBase+4], [cubeBase+1, cubeBase+5], [cubeBase+2, cubeBase+6], [cubeBase+3, cubeBase+7]); // verticals

  // ── 4 MINI NOZZLES ────────────────────────────────────────────────────────
  // Each nozzle is a small cone (3 vertices: base center + 2 rim points) pointing outward.
  // The 4 nozzles point in +X, -X, +Z, -Z to provide attitude control in those axes.
  const nozzleDirections: Array<{ dx: number; dz: number }> = [
    { dx:  1, dz:  0 }, // +X direction
    { dx: -1, dz:  0 }, // -X direction
    { dx:  0, dz:  1 }, // +Z direction
    { dx:  0, dz: -1 }, // -Z direction
  ];

  const nozzleLen = 0.25;  // Nozzle protrudes 0.25 units from the cube face
  const nozzleExitR = 0.12; // Exit radius of the mini nozzle bell

  for (const { dx, dz } of nozzleDirections) {
    const baseX = dx * h; // Nozzle base is on the cube face: ±h in the nozzle direction
    const baseZ = dz * h;
    const tipX = dx * (h + nozzleLen); // Nozzle tip extends further out
    const tipZ = dz * (h + nozzleLen);

    const nozzleBase = vertices.length;

    // Base circle of nozzle (where it attaches to the cube face) — 4 vertices for a square base
    // The "up" direction for the base circle is Y; the "right" direction is perpendicular to the nozzle axis
    const rx = dz; // Right vector: perpendicular to (dx,dz) in the XZ plane
    const rz = -dx; // This rotates 90° in XZ plane

    vertices.push({ x: baseX + rx * nozzleExitR * 0.5, y:  nozzleExitR * 0.5, z: baseZ + rz * nozzleExitR * 0.5 }); // rim +Y+R
    vertices.push({ x: baseX + rx * nozzleExitR * 0.5, y: -nozzleExitR * 0.5, z: baseZ + rz * nozzleExitR * 0.5 }); // rim -Y+R
    vertices.push({ x: baseX - rx * nozzleExitR * 0.5, y: -nozzleExitR * 0.5, z: baseZ - rz * nozzleExitR * 0.5 }); // rim -Y-R
    vertices.push({ x: baseX - rx * nozzleExitR * 0.5, y:  nozzleExitR * 0.5, z: baseZ - rz * nozzleExitR * 0.5 }); // rim +Y-R
    vertices.push({ x: tipX, y: 0, z: tipZ }); // +4: nozzle tip (apex of the cone)

    // Base square of nozzle (4 edges)
    edges.push([nozzleBase+0, nozzleBase+1], [nozzleBase+1, nozzleBase+2], [nozzleBase+2, nozzleBase+3], [nozzleBase+3, nozzleBase+0]);
    // 4 lines from base corners to tip (cone sides)
    edges.push([nozzleBase+0, nozzleBase+4], [nozzleBase+1, nozzleBase+4], [nozzleBase+2, nozzleBase+4], [nozzleBase+3, nozzleBase+4]);
  }

  // ── FUEL LINE CONNECTION ──────────────────────────────────────────────────
  // Small cylinder on top represents the propellant feed line from the main tank.
  const fuelBase = vertices.length;
  const fr = 0.06; // Fuel line radius
  const fh1 = h;         // Starts at the top of the cube
  const fh2 = h + 0.25;  // Extends upward 0.25 units

  // Square tube (4 vertices per ring × 2 rings)
  vertices.push({ x:  fr, y: fh1, z:  fr });
  vertices.push({ x: -fr, y: fh1, z:  fr });
  vertices.push({ x: -fr, y: fh1, z: -fr });
  vertices.push({ x:  fr, y: fh1, z: -fr });
  vertices.push({ x:  fr, y: fh2, z:  fr });
  vertices.push({ x: -fr, y: fh2, z:  fr });
  vertices.push({ x: -fr, y: fh2, z: -fr });
  vertices.push({ x:  fr, y: fh2, z: -fr });

  edges.push([fuelBase+0, fuelBase+1], [fuelBase+1, fuelBase+2], [fuelBase+2, fuelBase+3], [fuelBase+3, fuelBase+0]);
  edges.push([fuelBase+4, fuelBase+5], [fuelBase+5, fuelBase+6], [fuelBase+6, fuelBase+7], [fuelBase+7, fuelBase+4]);
  edges.push([fuelBase+0, fuelBase+4], [fuelBase+1, fuelBase+5], [fuelBase+2, fuelBase+6], [fuelBase+3, fuelBase+7]);

  return { vertices, edges, color, label };
}

// ─── FIN SHAPE ────────────────────────────────────────────────────────────────

/**
 * Build a fin set shape: 4 triangular fins around a central mounting cylinder.
 * Each fin is a triangle: root edge at the cylinder wall, tip pointing outward and backward.
 * In real rockets (Falcon 9 first stage, Atlas V), fins attach to reinforced rings
 * welded onto the booster skin, and their root chords are sealed with root fairings.
 *
 * @param color  Primary wireframe color
 * @param label  Text label
 */
function makeFinShape(color: string, label: string): Shape3D {
  const vertices: Vertex3D[] = [];
  const edges: Array<[number, number]> = [];

  // ── CENTRAL BODY TUBE ─────────────────────────────────────────────────────
  // A small cylinder represents the section of booster the fins attach to.
  const N = 8; // 8-sided body tube: simplified but readable
  const bodyR = 0.25; // Radius of the body tube
  const bodyTopY = 0.5;  // Top of the fin mounting section
  const bodyBotY = -0.5; // Bottom of the fin mounting section

  const { verts: btv, ring: bodyTopRing } = makeCircle(N, bodyR, bodyTopY, vertices.length);
  vertices.push(...btv);
  edges.push(...ringEdges(bodyTopRing));

  const { verts: bbv, ring: bodyBotRing } = makeCircle(N, bodyR, bodyBotY, vertices.length);
  vertices.push(...bbv);
  edges.push(...ringEdges(bodyBotRing));
  edges.push(...verticalEdges(bodyTopRing, bodyBotRing));

  // ── 4 FINS ────────────────────────────────────────────────────────────────
  // 4 fins positioned 90° apart around the body tube (at 0°, 90°, 180°, 270°).
  // Each fin is a swept triangle:
  //   - Root front: at the body surface, upper position (y = +0.4)
  //   - Root back: at the body surface, lower position (y = -0.5)
  //   - Tip: outward and slightly backward (y ≈ -0.3) for aerodynamic sweep
  const finAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]; // 0°, 90°, 180°, 270°
  const tipSpan = 0.75; // How far the fin extends outward from the body surface

  for (const angle of finAngles) {
    const finBase = vertices.length;
    const cx = Math.cos(angle); // X component of the outward direction for this fin
    const cz = Math.sin(angle); // Z component of the outward direction for this fin

    // Root front (upper attachment): on the body surface, near the top of the fin mounting section
    vertices.push({ x: bodyR * cx, y:  0.4, z: bodyR * cz });    // +0
    // Root back (lower attachment): on the body surface, at the bottom of the fin
    vertices.push({ x: bodyR * cx, y: -0.5, z: bodyR * cz });    // +1
    // Tip (outermost point): swept back slightly for aerodynamic efficiency
    vertices.push({
      x: (bodyR + tipSpan) * cx, // Outward by tipSpan
      y: -0.3,                    // Slightly above the root back: swept-back planform
      z: (bodyR + tipSpan) * cz,
    }); // +2

    // 3 edges of the triangular fin: leading edge, trailing edge, tip chord
    edges.push([finBase + 0, finBase + 1]); // Root (vertical attachment edge)
    edges.push([finBase + 1, finBase + 2]); // Trailing edge (from lower root to tip)
    edges.push([finBase + 2, finBase + 0]); // Leading edge (from tip to upper root)
  }

  return { vertices, edges, color, label };
}

// ─── INTERSTAGE SHAPE ─────────────────────────────────────────────────────────

/**
 * Build an interstage adapter shape: a frustum (truncated cone) with cross-bracing.
 * The frustum tapers from a wider bottom diameter (connecting to the lower stage)
 * to a narrower top diameter (connecting to the upper stage).
 * Internal cross-bracing carries shear loads during the staging event.
 * Bolt rings at the top and bottom represent the pyrotechnic separation joints.
 *
 * @param topRadius     Radius at the top (upper stage attachment)
 * @param bottomRadius  Radius at the bottom (lower stage attachment)
 * @param height        Height of the interstage section
 * @param color         Primary wireframe color
 * @param label         Text label
 */
function makeInterstageShape(
  topRadius: number,
  bottomRadius: number,
  height: number,
  color: string,
  label: string
): Shape3D {
  const vertices: Vertex3D[] = [];
  const edges: Array<[number, number]> = [];

  const N = 12; // 12-sided rings for the frustum

  // ── FRUSTUM BODY ──────────────────────────────────────────────────────────
  const topY = height / 2;    // Top of the interstage
  const botY = -height / 2;   // Bottom of the interstage

  const { verts: tv, ring: topRing } = makeCircle(N, topRadius, topY, vertices.length);
  vertices.push(...tv);
  edges.push(...ringEdges(topRing)); // Top circle (bolt ring detail)

  const { verts: bv, ring: botRing } = makeCircle(N, bottomRadius, botY, vertices.length);
  vertices.push(...bv);
  edges.push(...ringEdges(botRing)); // Bottom circle
  edges.push(...verticalEdges(topRing, botRing)); // Frustum sides

  // ── INTERNAL CROSS-BRACING ────────────────────────────────────────────────
  // An X-pattern of diagonal struts inside the frustum carries bending and shear loads.
  // In real interstages (Falcon 9), the cross-bracing also houses wiring conduits.
  // We add 4 diagonal lines connecting alternate vertices of top and bottom rings.
  for (let i = 0; i < 4; i++) {
    const topIdx = topRing[i * 3];          // Every 3rd vertex on top ring
    const botIdx = botRing[(i * 3 + 6) % N]; // Offset bottom vertex creates the X pattern
    edges.push([topIdx, botIdx]); // Diagonal cross-brace
  }

  // ── BOLT RING DETAIL ─────────────────────────────────────────────────────
  // A second ring slightly offset from the top and bottom edges represents
  // the pyrotechnic separation bolt rings. These fire simultaneously at staging.
  const boltOffsetTop = 0.04; // 0.04 units below the top edge
  const boltOffsetBot = 0.04; // 0.04 units above the bottom edge

  const { verts: btv2, ring: boltTopRing } = makeCircle(N, topRadius * 1.02, topY - boltOffsetTop, vertices.length);
  vertices.push(...btv2);
  edges.push(...ringEdges(boltTopRing)); // Slightly larger ring just below the top edge

  const { verts: bbv2, ring: boltBotRing } = makeCircle(N, bottomRadius * 1.02, botY + boltOffsetBot, vertices.length);
  vertices.push(...bbv2);
  edges.push(...ringEdges(boltBotRing)); // Slightly larger ring just above the bottom edge

  return { vertices, edges, color, label };
}

// ─── LANDING LEG SHAPE ────────────────────────────────────────────────────────

/**
 * Build a landing leg set shape: a central cylinder with 4 V-strut legs.
 * Each leg has an upper strut (from body to knee) and a lower strut (from knee to foot).
 * The V-shape absorbs landing forces through both compression and tension.
 * The foot pads are horizontal lines at the bottom of each lower strut.
 *
 * Falcon 9's legs are 10m long when deployed, with carbon fiber main struts
 * and aluminum honeycomb crush cores that absorb landing energy.
 *
 * @param color  Primary wireframe color
 * @param label  Text label
 */
function makeLandingLegShape(color: string, label: string): Shape3D {
  const vertices: Vertex3D[] = [];
  const edges: Array<[number, number]> = [];

  // ── CENTRAL MOUNTING CYLINDER ─────────────────────────────────────────────
  const N = 8; // 8-sided cylinder for the mounting point
  const mountR = 0.15;  // Radius of the mounting cylinder
  const mountTop = 0.2; // Top of the mounting section
  const mountBot = -0.2; // Bottom of the mounting section

  const { verts: mtv, ring: mountTopRing } = makeCircle(N, mountR, mountTop, vertices.length);
  vertices.push(...mtv);
  edges.push(...ringEdges(mountTopRing));

  const { verts: mbv, ring: mountBotRing } = makeCircle(N, mountR, mountBot, vertices.length);
  vertices.push(...mbv);
  edges.push(...ringEdges(mountBotRing));
  edges.push(...verticalEdges(mountTopRing, mountBotRing));

  // ── 4 V-STRUT LEGS ────────────────────────────────────────────────────────
  // 4 legs at 90° intervals. Each leg has:
  //   - Hinge point: on the body, at y = 0 (halfway up)
  //   - Knee: the midpoint of the strut, where upper and lower parts meet
  //   - Foot: on the ground (y = -1.0)
  const legAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]; // 90° apart
  const legReach = 0.8; // How far the leg extends outward from the body

  for (const angle of legAngles) {
    const legBase = vertices.length;
    const cx = Math.cos(angle); // Outward direction X
    const cz = Math.sin(angle); // Outward direction Z

    // Hinge: on the body surface
    const hingeX = mountR * cx;
    const hingeZ = mountR * cz;
    const hingeY = 0; // Midpoint of the body

    // Knee: 45° angle, extended outward and downward
    const kneeX = (mountR + legReach * 0.5) * cx; // Halfway out
    const kneeZ = (mountR + legReach * 0.5) * cz;
    const kneeY = -0.5; // Halfway down

    // Foot: maximum outward reach, on the ground
    const footX = (mountR + legReach) * cx;
    const footZ = (mountR + legReach) * cz;
    const footY = -1.0; // Ground level

    vertices.push({ x: hingeX, y: hingeY, z: hingeZ }); // +0: hinge
    vertices.push({ x: kneeX,  y: kneeY,  z: kneeZ  }); // +1: knee
    vertices.push({ x: footX,  y: footY,  z: footZ  }); // +2: foot center

    // ── FOOT PAD ────────────────────────────────────────────────────────────
    // Small horizontal T-shape at the bottom of each leg: represents the crush pad.
    const padHalf = 0.12; // Half-width of the foot pad
    const padPerp = { x: cz * padHalf, z: -cx * padHalf }; // Perpendicular to outward direction in XZ plane
    vertices.push({ x: footX + padPerp.x, y: footY, z: footZ + padPerp.z }); // +3: pad left
    vertices.push({ x: footX - padPerp.x, y: footY, z: footZ - padPerp.z }); // +4: pad right

    // Upper strut: hinge to knee
    edges.push([legBase + 0, legBase + 1]);
    // Lower strut: knee to foot
    edges.push([legBase + 1, legBase + 2]);
    // Foot pad: left to right
    edges.push([legBase + 3, legBase + 4]);
    // Foot pad center mark: foot center to pad ends
    edges.push([legBase + 2, legBase + 3]);
    edges.push([legBase + 2, legBase + 4]);
  }

  return { vertices, edges, color, label };
}

// ─── SHAPE CATALOG ────────────────────────────────────────────────────────────

/**
 * Master map from part ID → Shape3D.
 * The HologramViewer looks up the part's ID here to get its geometry.
 * Every part in RocketPartsCatalog.ts has an entry here.
 */
export const PART_SHAPES: Record<string, Shape3D> = {

  // ─── ENGINES ──────────────────────────────────────────────────────────────

  // Rutherford: electric-pump engine, small nozzle (10:1 expansion ratio).
  // Exit radius 0.3 vs throat 0.3 → mild flare; the engine is very compact.
  "rutherford": makeEngineShape(0.3, 0.35, 0.5, 0.4, "#00ffcc", "Rutherford"),

  // Merlin 1D: gas-generator kerolox engine, moderate nozzle.
  // 16:1 expansion ratio; distinctly more bell than Rutherford.
  "merlin-1d": makeEngineShape(0.3, 0.55, 0.55, 0.55, "#00ffcc", "Merlin 1D"),

  // BE-4: large ORSC LNG engine; wide bell nozzle.
  // ~30:1 expansion ratio; exit diameter noticeably wider.
  "be-4": makeEngineShape(0.32, 0.7, 0.6, 0.65, "#00ddff", "BE-4"),

  // Raptor 2: full-flow staged combustion methalox engine.
  // Moderately high expansion ratio (~40:1), compact preburner housing.
  "raptor-2": makeEngineShape(0.35, 0.65, 0.65, 0.6, "#00ffcc", "Raptor 2"),

  // RD-180: dual-chamber LOX-rich staged combustion, very high chamber pressure.
  // Two combustion chambers → wider overall shape; 36:1 expansion ratio.
  "rd-180": makeEngineShape(0.38, 0.72, 0.7, 0.65, "#ffaa00", "RD-180"),

  // RS-25: staged combustion hydrolox engine; highest Isp of any production engine.
  // 77.5:1 expansion ratio → very wide bell nozzle; exit radius large relative to chamber.
  "rs-25": makeEngineShape(0.3, 0.85, 0.7, 0.75, "#00ccff", "RS-25"),

  // F-1: gas-generator kerolox; largest single-chamber engine ever flown.
  // ~16:1 expansion ratio but the sheer scale makes the bell massive.
  // We give it a wide chamber to reflect the dual-inlet gas generator design.
  "f-1": makeEngineShape(0.45, 0.9, 0.8, 0.8, "#ff8800", "F-1"),

  // ─── FUEL TANKS ───────────────────────────────────────────────────────────

  // Small kerolox tank: slim, short cylinder. Represents a sounding-rocket scale tank.
  "small-lox-rp1-tank": makeTankShape(0.4, 0.7, 0.2, "#00aaff", "Small LOX/RP-1"),

  // Medium kerolox tank: taller cylinder, Falcon 9 first stage proportions.
  "medium-lox-rp1-tank": makeTankShape(0.5, 1.0, 0.25, "#00aaff", "Medium LOX/RP-1"),

  // Large LOX/LH2 tank: very tall (LH2 is 7× less dense than RP-1, needs more volume).
  // The SLS core stage tank is 40m tall; we reflect that with a tall proportional shape.
  "large-lox-lh2-tank": makeTankShape(0.55, 1.3, 0.3, "#66ddff", "Large LOX/LH2"),

  // Small methalox tank: slightly wider than RP-1 equivalent (CH4 less dense than RP-1).
  "small-lox-ch4-tank": makeTankShape(0.42, 0.75, 0.22, "#00ffcc", "Small LOX/CH4"),

  // Medium methalox tank: Starship/Super Heavy scale.
  "medium-lox-ch4-tank": makeTankShape(0.52, 1.1, 0.28, "#00ffcc", "Medium LOX/CH4"),

  // Small LNG tank: similar to CH4 but slightly wider walls (LNG higher density).
  "small-lox-lng-tank": makeTankShape(0.44, 0.8, 0.22, "#88ddff", "Small LOX/LNG"),

  // ─── NOSE CONES ───────────────────────────────────────────────────────────

  // Small ogive: sharp, short cone for sounding rockets. sharpness=1.8 = moderately pointed.
  "small-ogive-nose": makeNoseConeShape(0.45, 1.2, 1.8, "#ddaa00", "Small Ogive"),

  // Medium payload fairing: longer, rounder nose for Falcon 9 scale. sharpness=1.5 = rounded tip.
  "medium-fairing": makeNoseConeShape(0.55, 1.5, 1.5, "#ddaa00", "Medium Fairing"),

  // Large SLS fairing: very wide, blunter tip. sharpness=1.3 = blunt hemispherical-ish.
  "large-fairing": makeNoseConeShape(0.65, 1.6, 1.3, "#ddaa00", "Large Fairing"),

  // ─── RCS THRUSTERS ────────────────────────────────────────────────────────

  // Cold gas thruster: same cube body, just slightly smaller (lower thrust, simpler system).
  "cold-gas-n2": makeRCSShape("#88ccff", "Cold Gas N2"),

  // Draco: hypergolic thruster, standard RCS shape.
  "draco": makeRCSShape("#ff8844", "Draco"),

  // R-4D: Apollo-heritage thruster, similar shape to Draco.
  "r-4d": makeRCSShape("#ffaa44", "R-4D"),

  // ─── FINS ─────────────────────────────────────────────────────────────────

  // Carbon fiber fins: standard triangular fin set.
  "cf-fins": makeFinShape("#88ff88", "CF Fins"),

  // Fixed aluminum fins: same geometry, different color (warmer, aluminum look).
  "aluminum-fins": makeFinShape("#aaaaff", "Alum Fins"),

  // Titanium grid fins: same mounting geometry but grid fins have slightly different proportions.
  "ti-grid-fins": makeFinShape("#ffcc44", "Grid Fins"),

  // ─── INTERSTAGE ADAPTERS ──────────────────────────────────────────────────

  // Small interstage: same-diameter cylinder (2m top and bottom), short.
  "small-interstage": makeInterstageShape(0.3, 0.3, 0.7, "#aa99cc", "Small IS"),

  // Medium interstage: same diameter top and bottom (Falcon 9 is constant-diameter).
  "medium-interstage": makeInterstageShape(0.4, 0.4, 0.75, "#aa99cc", "Medium IS"),

  // Large interstage: frustum — wide at bottom (8.4m SLS) narrows to 5.2m at top.
  // We reflect the taper: bottomRadius > topRadius.
  "large-interstage": makeInterstageShape(0.38, 0.55, 0.8, "#aa99cc", "Large IS"),

  // ─── LANDING LEGS ─────────────────────────────────────────────────────────

  // Fixed struts: same geometry as deployable legs but conceptually simpler.
  "fixed-struts": makeLandingLegShape("#aabb99", "Fixed Struts"),

  // Falcon 9 style deployable legs: same shape.
  "falcon9-legs": makeLandingLegShape("#88cc88", "Falcon 9 Legs"),

  // Heavy deployable legs: same shape, longer reach implied.
  "heavy-legs": makeLandingLegShape("#99ddaa", "Heavy Legs"),
};
