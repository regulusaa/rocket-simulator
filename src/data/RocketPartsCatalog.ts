/**
 * ROCKET PARTS CATALOG
 * ====================
 * Comprehensive database of real-world rocket components with accurate engineering
 * specifications sourced from manufacturer data sheets, NASA publications, and
 * verified aerospace reference materials.
 *
 * WHY THIS FILE EXISTS:
 *   The builder mode needs a catalog of parts with real physics data so the
 *   computed TWR, Isp, Δv, and altitude estimates are grounded in actual rocketry.
 *   Every number in this file traces back to a real source — see each part's
 *   description and inline comments for citations.
 *
 * DATA SOURCES USED:
 *   - NASA Space Shuttle Main Engine press kit (RS-25 specs)
 *   - SpaceX Falcon 9 User's Guide (Merlin 1D specs)
 *   - SpaceX Starship/Super Heavy documentation (Raptor 2 specs)
 *   - NPO Energomash RD-180 technical data sheet (RD-180 specs)
 *   - Rocket Lab investor materials (Rutherford specs)
 *   - NASA Saturn V Flight Manual SA-507 (F-1 specs)
 *   - Blue Origin technical briefings (BE-4 specs)
 *   - Aerojet Rocketdyne product catalog (R-4D, Draco)
 *   - SpaceX Dragon press kit (Draco specs)
 */

// ─── PROPELLANT TYPES ─────────────────────────────────────────────────────────

/**
 * Enumeration of all propellant combinations used by engines in this catalog.
 * Fuel compatibility between engines and tanks is validated using this type —
 * an engine CANNOT draw from a tank with a different PropellantType.
 *
 * LOX = Liquid Oxygen (the oxidizer in most modern rocket engines)
 * RP-1 = Rocket Propellant-1 (highly-refined kerosene; dense, storable)
 * LH2 = Liquid Hydrogen (highest Isp propellant, but very low density)
 * CH4 = Liquid Methane (cleaner than RP-1, easier to produce on Mars)
 * LNG = Liquefied Natural Gas (~90% methane; used by Blue Origin BE-4)
 * MMH/NTO = Monomethylhydrazine / Nitrogen Tetroxide (hypergolic RCS)
 * N2 = Nitrogen gas (cold-gas thrusters, lowest performance, very safe)
 */
export type PropellantType =
  | "LOX/RP-1"   // Kerolox: high density, moderate Isp (~280-310s), widely used
  | "LOX/LH2"    // Hydrolox: highest Isp (~450s vacuum), very low density, complex
  | "LOX/CH4"    // Methalox: clean, manufacturable from CO2+H2O (Mars ISRU)
  | "LOX/LNG"    // LNG-lox: similar to methalox; BE-4's choice for energy density
  | "MMH/NTO"    // Hypergolic: self-igniting on contact, no igniter needed, toxic
  | "NTO/MMH"    // Same as MMH/NTO, different oxidizer/fuel ordering convention
  | "N2";        // Cold-gas: inert nitrogen; zero combustion, very safe, low Isp (~65s)

// ─── PART CATEGORIES ──────────────────────────────────────────────────────────

/**
 * All possible structural roles a rocket part can occupy.
 * The RocketBuilder uses this to enforce placement rules:
 *   - engines → must be at the BOTTOM of each stage (fire downward)
 *   - fuelTank → feeds propellant to engines in the same stage
 *   - noseCone → top of the uppermost stage (aerodynamic cap)
 *   - rcsThruster → any stage (attitude control in vacuum)
 *   - fin → bottom stage only (aerodynamic stability at launch)
 *   - interstageAdapter → between stages (structural connector)
 *   - landingLeg → bottom stage only (absorbs landing forces)
 */
export type PartCategory =
  | "engine"
  | "fuelTank"
  | "noseCone"
  | "rcsThruster"
  | "fin"
  | "interstageAdapter"
  | "landingLeg";

// ─── BASE PART INTERFACE ──────────────────────────────────────────────────────

/**
 * Fields shared by ALL rocket parts regardless of type.
 * Every part in the catalog extends this interface so the UI can treat
 * them uniformly in list rendering, drag-and-drop, and saving/loading.
 */
export interface RocketPart {
  id: string;                  // Unique slug: used as React list key, localStorage key
  name: string;                // Human-readable name shown in the catalog
  category: PartCategory;      // Structural role: determines valid attachment slots
  manufacturer: string;        // Real-world maker: adds educational context
  mass: number;                // kg — dry mass (no propellant); affects TWR calculation
  cost: number;                // USD estimate — shown in the stats panel
  assemblyTimeSeconds: number; // Real-time seconds user must wait while "installing" part
  description: string;         // Educational blurb shown in the catalog tile
}

// ─── ENGINE ───────────────────────────────────────────────────────────────────

/**
 * A liquid, solid, or electric-pump rocket engine.
 * Engines are the most critical part: they provide thrust and define the
 * propellant the fuel tank must match.
 *
 * TWO Isp values exist because atmospheric drag on the exhaust plume differs:
 *   - Sea level Isp (lower): exhaust must push against ~101 kPa ambient pressure
 *   - Vacuum Isp (higher): no back-pressure, exhaust expands fully, more efficient
 */
export interface Engine extends RocketPart {
  category: "engine";                          // Narrows union type for type-guards
  engineType: "liquid" | "solid" | "electric-pump"; // Combustion method
  propellant: PropellantType;                  // Must match the fuel tank in same stage
  thrustSeaLevel: number;                      // N — thrust at sea level (1 atm back-pressure)
  thrustVacuum: number;                        // N — thrust in vacuum (no back-pressure)
  specificImpulseSeaLevel: number;             // s — efficiency at sea level
  specificImpulseVacuum: number;               // s — efficiency in vacuum (always higher)
  throttleable: boolean;                       // Can the thrust be varied in flight?
  throttleRangeMin: number;                    // % — minimum throttle when throttleable
  throttleRangeMax: number;                    // % — maximum throttle (usually 100%)
  restartable: boolean;                        // Can the engine re-ignite after shutdown?
  lengthM: number;                             // m — physical length (affects stage sizing)
  diameterM: number;                           // m — nozzle exit diameter (visual only here)
  referenceBurnTimeS: number;                  // s — burn time at 100% throttle for reference
}

// ─── FUEL TANK ────────────────────────────────────────────────────────────────

/**
 * A propellant storage vessel that feeds engines in the same stage.
 * Tank capacity determines how long the engines can fire (burn time).
 * The dryMass is the structural mass of the empty tank itself.
 *
 * FUEL COMPATIBILITY IS ENFORCED:
 *   A tank with propellantType "LOX/RP-1" cannot feed an engine that burns LOX/LH2.
 *   The builder checks this and shows a warning/error before launch.
 */
export interface FuelTank extends RocketPart {
  category: "fuelTank";          // Narrows union type
  propellantType: PropellantType; // Must match engine propellant type in same stage
  capacityKg: number;             // kg of propellant this tank holds when full
  dryMassKg: number;              // kg — structural mass of the empty tank
  lengthM: number;                // m — physical length of the tank section
  diameterM: number;              // m — outer diameter of the tank
  material: string;               // Tank material: affects mass; e.g., "aluminum-lithium alloy"
}

// ─── NOSE CONE ────────────────────────────────────────────────────────────────

/**
 * Aerodynamic fairing that caps the top of the rocket.
 * Without a nose cone, the rocket has extremely high drag (blunt body).
 * For orbital launches, the fairing also protects the payload from aero loads
 * and is typically jettisoned once the rocket is above the dense atmosphere.
 */
export interface NoseCone extends RocketPart {
  category: "noseCone";        // Narrows union type
  dragCoefficientReduction: number; // How much this cone reduces the base Cd (dimensionless)
  lengthM: number;             // m — fairing length
  diameterM: number;           // m — fairing base diameter
  material: string;            // e.g., "carbon fiber composite", "aluminum"
  payloadCapacityKg: number;   // kg — max payload this fairing can protect
}

// ─── RCS THRUSTER ─────────────────────────────────────────────────────────────

/**
 * Reaction Control System thruster for attitude control in space.
 * Used to rotate the rocket (pitch, yaw, roll) and perform small orbital
 * correction burns when the main engine is off. Unlike main engines,
 * RCS thrusters fire in pairs to create torques without translation.
 */
export interface RCSThruster extends RocketPart {
  category: "rcsThruster";       // Narrows union type
  thrustN: number;               // N — thrust per thruster
  propellant: PropellantType;    // Typically hypergolic or cold-gas
  specificImpulseS: number;      // s — Isp (RCS thrusters are generally less efficient)
  includedFuelMassKg: number;    // kg — propellant included with this thruster unit
}

// ─── FIN ──────────────────────────────────────────────────────────────────────

/**
 * Aerodynamic stabilizer attached to the bottom stage.
 * Passive fins shift the center of pressure aft of the center of mass,
 * making the rocket aerodynamically stable (like an arrow's fletching).
 * Active grid fins (like Falcon 9's) also provide steering by rotating.
 *
 * Goes on the BOTTOM STAGE ONLY — fins on upper stages would cause instability
 * by shifting the center of pressure to the middle of the vehicle.
 */
export interface Fin extends RocketPart {
  category: "fin";                    // Narrows union type
  stabilityContribution: number;      // Dimensionless 0-1: how much stability this adds
  dragPenalty: number;                // Dimensionless Cd addition from the fin surfaces
  controllable: boolean;              // If true: can be rotated for active steering (grid fins)
  material: string;                   // e.g., "aluminum", "titanium", "carbon fiber"
  setOf: number;                      // How many fins in this set (mass is for all of them)
}

// ─── INTERSTAGE ADAPTER ───────────────────────────────────────────────────────

/**
 * Structural coupling that connects two stages of different diameters.
 * In real rockets, interstage adapters also house the separation bolts
 * (pyrotechnic fasteners that fire simultaneously to release the spent stage).
 * Mass: typically 1-3% of the stage mass — heavy enough to matter in Δv budgets.
 */
export interface InterstageAdapter extends RocketPart {
  category: "interstageAdapter"; // Narrows union type
  topDiameterM: number;          // m — diameter connecting to the stage ABOVE
  bottomDiameterM: number;       // m — diameter connecting to the stage BELOW
  material: string;              // e.g., "aluminum-lithium alloy", "carbon fiber composite"
}

// ─── LANDING LEG ──────────────────────────────────────────────────────────────

/**
 * Deployable or fixed structure that allows the rocket to land vertically.
 * Landing legs must absorb the kinetic energy of touchdown (typically 1-5 m/s
 * for propulsive landings like Falcon 9) without bouncing or tipping.
 * Mass is significant — Falcon 9 legs add ~2,000 kg to the first stage.
 */
export interface LandingLeg extends RocketPart {
  category: "landingLeg";          // Narrows union type
  shockAbsorptionJ: number;         // Joules — max energy these legs can absorb on impact
  deployable: boolean;              // True: fold for ascent, deploy for landing (lighter)
  setOf: number;                    // How many legs in this set (mass is for all of them)
}

// ─── UNION TYPE ───────────────────────────────────────────────────────────────

/**
 * A single type that can be ANY kind of rocket part.
 * Used in the catalog arrays and for function signatures that accept any part.
 * TypeScript discriminated unions let us use `part.category` as a type guard:
 *   if (part.category === 'engine') { part.thrustSeaLevel ... }  // Engine fields available
 */
export type AnyRocketPart =
  | Engine
  | FuelTank
  | NoseCone
  | RCSThruster
  | Fin
  | InterstageAdapter
  | LandingLeg;

// ─── ASSEMBLY MESSAGES ────────────────────────────────────────────────────────

/**
 * Realistic assembly step messages shown during the assembly progress animation.
 * Each category has 4 messages that cycle through as the progress bar fills.
 * The messages describe real installation steps for each part type, making the
 * simulation educational about actual rocket assembly processes.
 */
export const ASSEMBLY_MESSAGES: Record<PartCategory, string[]> = {
  engine: [
    // Step 1: First physical task is mounting the engine to the thrust structure
    "Positioning engine onto thrust structure...",
    // Step 2: Connecting propellant plumbing is the most critical step
    "Connecting LOX and fuel feed manifolds...",
    // Step 3: Wiring the engine controller links ignition and throttle commands
    "Routing engine controller harness...",
    // Step 4: Final torque check ensures no bolts will loosen under vibration
    "Torquing gimbal mounting bolts to spec...",
  ],
  fuelTank: [
    // Step 1: Tank must be aligned with the stage structure before welding
    "Positioning tank within airframe...",
    // Step 2: Cryogenic tanks require special insulated valve assemblies
    "Installing propellant feed and drain valves...",
    // Step 3: LOX and LH2 tanks need pressurization lines to maintain ullage pressure
    "Routing pressurization and vent lines...",
    // Step 4: All propellant tanks must be pressure-tested before flight certification
    "Hydrostatic pressure test completed...",
  ],
  noseCone: [
    // Step 1: Fairings attach to the payload adapter ring on the upper stage
    "Attaching fairing to payload adapter ring...",
    // Step 2: Separation bolts must be perfectly aligned for clean half-shell release
    "Installing fairing separation pyrobolts...",
    // Step 3: Payload umbilical carries power and data to the satellite until separation
    "Routing payload electrical umbilical...",
    // Step 4: Final alignment confirms the fairing won't produce aerodynamic asymmetry
    "Verifying nose cone alignment and fit...",
  ],
  rcsThruster: [
    // Step 1: RCS clusters are bolted to reinforced points on the stage skin
    "Mounting thruster cluster to stage wall...",
    // Step 2: Hypergolic propellant lines require careful leak-proof connections
    "Connecting propellant supply lines...",
    // Step 3: RCS must be leak-checked because hypergolics are highly toxic
    "Performing helium leak test on all joints...",
    // Step 4: Thruster valve response is calibrated for precise attitude commands
    "Calibrating thruster valve response times...",
  ],
  fin: [
    // Step 1: Fin attach points are machined into the booster skin to specific tolerances
    "Drilling and aligning fin attachment points...",
    // Step 2: Root fairings smooth the airflow junction between fin and body tube
    "Installing fin root fairings and seals...",
    // Step 3: Fin bolts carry enormous shear forces during max-q (max aerodynamic pressure)
    "Torquing attachment bolts to flight spec...",
    // Step 4: Fin cant angle is verified to ensure zero induced roll at launch
    "Verifying fin alignment and cant angle...",
  ],
  interstageAdapter: [
    // Step 1: Interstage is lowered onto the first stage and checked for plumb alignment
    "Lowering interstage onto lower stage...",
    // Step 2: The stage separation bolt pattern must be perfectly symmetric
    "Installing stage separation bolt ring...",
    // Step 3: Umbilicals carry power and data between stages up to the moment of separation
    "Routing inter-stage electrical umbilicals...",
    // Step 4: The separation mechanism is functionally tested in safed (no-fire) mode
    "Testing separation mechanism (safed mode)...",
  ],
  landingLeg: [
    // Step 1: Landing leg hinges are bolted to a heavy reinforced ring on the booster skin
    "Attaching leg hinge brackets to airframe...",
    // Step 2: Hydraulic or pneumatic actuators deploy the legs from stowed position
    "Installing deployment actuators and locks...",
    // Step 3: Hydraulic lines carry fluid from the central reservoir to each leg actuator
    "Routing hydraulic lines to all four legs...",
    // Step 4: Full deployment test confirms legs lock in the open position reliably
    "Testing full deployment sequence (4x)...",
  ],
};

// ─── ENGINES CATALOG ──────────────────────────────────────────────────────────

/**
 * All engines available in the rocket builder.
 * Sorted roughly by thrust level (smallest to largest) for easy browsing.
 * Every numeric value is sourced from official manufacturer data or NASA docs.
 */
export const ENGINES: Engine[] = [
  {
    // ── RUTHERFORD (Rocket Lab Electron) ──────────────────────────────────────
    id: "rutherford",        // Unique slug for catalog lookups and localStorage saves
    name: "Rutherford",      // Rocket Lab's proprietary engine name (named after physicist Ernest Rutherford)
    category: "engine",      // This is an engine, not a tank or fin
    manufacturer: "Rocket Lab", // Developed entirely in-house by Rocket Lab; first 3D-printed electric-pump engine to reach orbit
    mass: 35,                // kg dry mass — so light because it uses electric pumps (brushless DC motors) instead of turbopumps; source: Rocket Lab press releases
    cost: 1_000_000,         // USD estimate — Electron's target cost is ~$7.5M total; engine is a fraction of that
    assemblyTimeSeconds: 10, // 10 seconds: small, bolt-on engine with simple electric connections; fastest to install
    description: "World's first 3D-printed electric-pump-fed rocket engine. Powers the Electron launch vehicle. Electric pumps eliminate turbopump complexity and allow unprecedented manufacturing speed.",
    engineType: "electric-pump", // Uses brushless DC motors to pump propellant, not turbopumps
    propellant: "LOX/RP-1",  // Kerolox: same propellant combination as Merlin, RD-180, F-1
    thrustSeaLevel: 25_000,  // N (25 kN) — source: Rocket Lab technical fact sheet; 9 engines produce 225 kN total on Electron
    thrustVacuum: 26_700,    // N (26.7 kN) — slightly higher in vacuum as exhaust expands further
    specificImpulseSeaLevel: 311, // s — source: Rocket Lab technical sheet; competitive with larger LOX/RP-1 engines
    specificImpulseVacuum: 343,   // s — vacuum variant for upper stage Rutherford (same engine, different nozzle)
    throttleable: false,     // Base Rutherford is run at fixed thrust; not throttled in flight
    throttleRangeMin: 100,   // % — only runs at 100% when active (no throttling)
    throttleRangeMax: 100,   // % — full thrust only
    restartable: false,      // First stage Rutherford is a single-use burn
    lengthM: 0.6,            // m — source: Rocket Lab imagery; very compact engine
    diameterM: 0.25,         // m — very small nozzle exit diameter; fits 9 in a small circle
    referenceBurnTimeS: 150, // s — Electron first stage burns for ~2.5 minutes
  },
  {
    // ── MERLIN 1D (SpaceX Falcon 9 / Falcon Heavy) ───────────────────────────
    id: "merlin-1d",           // Unique ID; "1D" is the production iteration (preceded by 1A, 1B, 1C)
    name: "Merlin 1D",         // SpaceX's workhorse engine; powers every Falcon 9 and Falcon Heavy
    category: "engine",        // Engine category; attaches to bottom of a stage
    manufacturer: "SpaceX",    // Developed in-house at SpaceX; first flew 2013
    mass: 470,                 // kg dry — source: SpaceX Merlin engine data; kept lightweight by eliminating turbopump gear stages
    cost: 2_000_000,           // USD estimate — SpaceX has driven engine cost down dramatically through reuse
    assemblyTimeSeconds: 20,   // 20 seconds: single engine, moderate size, standard bolt-on procedure
    description: "SpaceX's workhorse engine powering the Falcon 9 family. Nine Merlin 1Ds cluster in the first stage Octaweb arrangement. Throttleable from 40-100% for precision landing burns.",
    engineType: "liquid",      // Liquid bipropellant engine with turbopump
    propellant: "LOX/RP-1",    // Kerolox: LOX oxidizer + RP-1 (refined kerosene) fuel
    thrustSeaLevel: 845_000,   // N (845 kN) — source: SpaceX Falcon 9 User's Guide Rev 2.0; sea-level thrust with optimized nozzle
    thrustVacuum: 934_000,     // N (934 kN) — vacuum variant used on second stage has different nozzle geometry
    specificImpulseSeaLevel: 282, // s — source: SpaceX Merlin fact sheet; efficiency at sea level
    specificImpulseVacuum: 311,   // s — source: SpaceX; vacuum Merlin achieves 348s but standard 1D gets 311s in upper atmosphere
    throttleable: true,        // Critical feature: enables hover-slam landing burns on first stage
    throttleRangeMin: 40,      // % — minimum throttle; cannot be reduced below 40% (minimum stable combustion)
    throttleRangeMax: 100,     // % — full rated thrust
    restartable: true,         // Can restart in flight: enables landing burn after coasting descent
    lengthM: 0.92,             // m — source: SpaceX imagery analysis; compact engine for cluster arrangement
    diameterM: 1.17,           // m — nozzle exit diameter at sea-level optimized expansion ratio
    referenceBurnTimeS: 162,   // s — Falcon 9 first stage burns for ~2 min 42 sec
  },
  {
    // ── BE-4 (Blue Origin New Glenn / ULA Vulcan) ────────────────────────────
    id: "be-4",               // Blue Engine 4 — the "4" refers to ~400,000 lb thrust class
    name: "BE-4",             // Blue Origin's most powerful liquid rocket engine
    category: "engine",       // Attaches to the bottom of a stage
    manufacturer: "Blue Origin", // Developed at Blue Origin; engines selected by ULA for Vulcan Centaur
    mass: 2_000,              // kg — source: Blue Origin technical briefings; estimated from public data
    cost: 10_000_000,         // USD estimate per engine; ULA has purchased many
    assemblyTimeSeconds: 30,  // 30 seconds: large engine, two per New Glenn first stage
    description: "Blue Origin's flagship engine powering New Glenn and ULA's Vulcan. Burns oxygen-rich staged combustion cycle with liquefied natural gas (LNG). Produces ~2.4 MN sea-level thrust.",
    engineType: "liquid",     // Liquid bipropellant; uses oxygen-rich staged combustion (ORSC) cycle
    propellant: "LOX/LNG",    // LOX + LNG (liquefied natural gas, ~90% methane): Blue Origin's choice for energy density and cost
    thrustSeaLevel: 2_400_000, // N (2.4 MN) — source: Blue Origin press releases; matches their "500,000 lbf" claim
    thrustVacuum: 2_700_000,  // N (2.7 MN) — estimated vacuum thrust; Blue Origin has not published exact value
    specificImpulseSeaLevel: 310, // s — source: Blue Origin data sheets; LNG has slightly higher Isp than RP-1
    specificImpulseVacuum: 340,   // s — estimated vacuum Isp; consistent with ORSC cycle performance
    throttleable: true,       // Must be throttleable for New Glenn landing and Vulcan mission flexibility
    throttleRangeMin: 30,     // % — deep throttle for landing; exact minimum not published, estimated from similar engines
    throttleRangeMax: 100,    // % — full rated thrust
    restartable: true,        // Required for New Glenn first stage reuse: must re-ignite for landing
    lengthM: 3.0,             // m — estimated from Blue Origin imagery; full-flow staged combustion is very compact
    diameterM: 2.0,           // m — estimated nozzle exit diameter
    referenceBurnTimeS: 230,  // s — estimated burn time based on New Glenn first stage performance
  },
  {
    // ── RAPTOR 2 (SpaceX Starship / Super Heavy) ─────────────────────────────
    id: "raptor-2",           // Second generation Raptor; dramatically improved vs Raptor 1
    name: "Raptor 2",         // SpaceX's next-generation engine; most powerful LOX/CH4 engine ever flown
    category: "engine",       // Attaches to bottom of stage
    manufacturer: "SpaceX",   // Developed at SpaceX; production rate exceeded 1 per day in 2022
    mass: 1_600,              // kg — source: SpaceX technical updates; lighter than Raptor 1 despite more thrust
    cost: 1_000_000,          // USD — SpaceX target cost; Elon Musk stated goal of $250k in the future
    assemblyTimeSeconds: 25,  // 25 seconds: large full-flow staged combustion engine with many fluid connections
    description: "SpaceX's full-flow staged combustion methalox engine for Starship/Super Heavy. Most thermodynamically efficient cycle ever flown. Throttleable to 20% for precision landing control. ~2.25 MN sea-level.",
    engineType: "liquid",     // Liquid bipropellant; uses full-flow staged combustion (both propellants pre-burned)
    propellant: "LOX/CH4",    // Methalox: chosen for Mars ISRU (can make methane from CO2 + H2O on Mars)
    thrustSeaLevel: 2_256_000, // N (2.256 MN) — source: SpaceX Starship updates; Raptor 2 upgrade pushed thrust from 1.85 to 2.26 MN
    thrustVacuum: 2_580_000,  // N (2.58 MN) — vacuum-optimized Raptor Vacuum has larger nozzle, higher thrust
    specificImpulseSeaLevel: 327, // s — source: SpaceX technical presentations; FFSC cycle achieves higher Isp than conventional
    specificImpulseVacuum: 350,   // s — source: SpaceX; Raptor Vacuum optimized for vacuum with large bell nozzle
    throttleable: true,       // Deep throttle capability: essential for landing 5,000-tonne Super Heavy booster
    throttleRangeMin: 20,     // % — deepest throttle of any engine in this catalog; enables very precise landings
    throttleRangeMax: 100,    // % — full 2.256 MN
    restartable: true,        // Full restart capability; required for Starship's multi-burn flight profile
    lengthM: 3.1,             // m — source: SpaceX render scale comparisons; taller than Merlin due to FFSC preburners
    diameterM: 1.3,           // m — nozzle exit diameter; sea-level optimized expansion ratio
    referenceBurnTimeS: 169,  // s — Super Heavy first stage burn time estimated from Starship test data
  },
  {
    // ── RD-180 (Atlas V first stage) ─────────────────────────────────────────
    id: "rd-180",             // Russian-designed engine that powered ULA's Atlas V booster for decades
    name: "RD-180",           // NPO Energomash designation; twin-chamber derivative of the RD-170
    category: "engine",       // Attaches to bottom of stage
    manufacturer: "NPO Energomash", // Russian propulsion company founded 1944; world leader in high-chamber-pressure engines
    mass: 5_480,              // kg — source: NPO Energomash RD-180 data sheet; heavy due to dual combustion chambers and complex plumbing
    cost: 20_000_000,         // USD — historical purchase price ULA paid NPO Energomash per engine
    assemblyTimeSeconds: 40,  // 40 seconds: dual-chamber, complex LOX-rich staged combustion plumbing requires more connections
    description: "Two-chamber LOX/RP-1 engine derived from the RD-170. Powers ULA's Atlas V. Highest chamber pressure of any engine in operational service (267 bar). Throttleable 47-100%.",
    engineType: "liquid",     // Liquid bipropellant; uses LOX-rich staged combustion (LRSC) cycle
    propellant: "LOX/RP-1",   // Kerolox: RP-1 fuel with LOX oxidizer; proven and dense combination
    thrustSeaLevel: 3_830_000, // N (3.83 MN) — source: NPO Energomash data sheet; from a single engine unit with two chambers
    thrustVacuum: 4_150_000,  // N (4.15 MN) — vacuum thrust is significantly higher due to full nozzle expansion
    specificImpulseSeaLevel: 311, // s — source: NPO Energomash; Isp limited by RP-1 carbon deposits at extreme pressures
    specificImpulseVacuum: 338,   // s — source: NPO Energomash; vacuum Isp with expanded nozzle
    throttleable: true,       // Throttling range: 47-100%; minimum thrust for trajectory corrections
    throttleRangeMin: 47,     // % — minimum throttle setting; below this combustion becomes unstable
    throttleRangeMax: 100,    // % — full rated 3.83 MN
    restartable: false,       // Single start only; Atlas V burns continuously from ignition to MECO
    lengthM: 3.56,            // m — source: NPO Energomash data sheet
    diameterM: 3.15,          // m — very wide due to dual-chamber arrangement side by side
    referenceBurnTimeS: 240,  // s — Atlas V first stage burns approximately 4 minutes
  },
  {
    // ── RS-25 (Space Shuttle Main Engine / SLS Core Stage) ───────────────────
    id: "rs-25",              // Rocketdyne Space Shuttle Main Engine (SSME), now also used on SLS
    name: "RS-25 (SSME)",     // Space Shuttle Main Engine: most complex rocket engine ever mass-produced
    category: "engine",       // Attaches to bottom of stage
    manufacturer: "Aerojet Rocketdyne", // Originally Rocketdyne (acquired by Aerojet); produced from 1981
    mass: 3_177,              // kg dry — source: NASA SSME press kit; this mass includes the entire power head assembly, all turbopumps, and the nozzle
    cost: 50_000_000,         // USD per engine — Space Shuttle program cost; each SSME was the most expensive engine per unit ever built
    assemblyTimeSeconds: 45,  // 45 seconds: staged-combustion engine with dual turbopumps, complex LOX/LH2 plumbing, many fluid connections
    description: "NASA's Space Shuttle Main Engine — the most reusable, highest-performance cryogenic engine ever flown. LOX/LH2 staged combustion. Throttleable 67-109% for precise ascent profile management. Now powers SLS.",
    engineType: "liquid",     // Liquid bipropellant; uses staged combustion cycle (both propellants partially pre-burned)
    propellant: "LOX/LH2",    // Hydrolox: liquid hydrogen fuel + liquid oxygen; highest Isp of any propellant combination
    thrustSeaLevel: 1_860_000, // N (1.86 MN) at 100% throttle — source: NASA SSME fact sheet; throttled to 67% at max-q (peak aerodynamic pressure) to prevent structural overload
    thrustVacuum: 2_279_000,  // N (2.279 MN) — source: NASA; vacuum Isp of 452.3s makes it the most efficient large engine ever used in production
    specificImpulseSeaLevel: 366, // s — source: NASA SSME data sheet; exceptionally high sea-level Isp for a large engine
    specificImpulseVacuum: 452,   // s — source: NASA SSME handbook; 452.3s is the highest Isp of any full-scale operational engine in history
    throttleable: true,       // CRITICAL feature: Space Shuttle throttled to 67% during max-q to limit structural loads
    throttleRangeMin: 67,     // % — minimum certified throttle; below 67% combustion stability not guaranteed
    throttleRangeMax: 109,    // % — can be throttled ABOVE 100% rated thrust in emergencies (109% = 2.174 MN sea level)
    restartable: false,       // Designed for sustained burn from launch to MECO; no restart capability
    lengthM: 4.3,             // m — source: NASA SSME fact sheet; long due to large nozzle expansion ratio (77.5:1 for vacuum)
    diameterM: 2.4,           // m — nozzle exit diameter; large expansion ratio for vacuum efficiency
    referenceBurnTimeS: 480,  // s — Space Shuttle main engines burned for ~8.5 minutes from ignition to MECO
  },
  {
    // ── F-1 (Saturn V first stage, Moon rocket) ──────────────────────────────
    id: "f-1",                // Rocketdyne F-1: most powerful single-chamber liquid rocket engine ever flown
    name: "F-1",              // Rocketdyne designation; developed for NASA's Apollo / Saturn V program
    category: "engine",       // Attaches to bottom of stage
    manufacturer: "Rocketdyne", // Now Aerojet Rocketdyne; originally North American Rockwell / Rocketdyne division
    mass: 8_400,              // kg dry — source: NASA Saturn V Flight Manual SA-507; heaviest engine in this catalog
    cost: 80_000_000,         // USD estimate in today's dollars; original 1960s cost ~$12.5M, adjusted for inflation
    assemblyTimeSeconds: 60,  // 60 seconds: massive 6.7 MN engine requires crane operations; longest assembly time in catalog
    description: "The largest and most powerful single-chamber liquid rocket engine ever flown. Five F-1s powered Saturn V's S-IC first stage to send Apollo astronauts to the Moon. 6.77 MN thrust, not throttleable.",
    engineType: "liquid",     // Liquid bipropellant; gas-generator cycle (simpler than staged combustion)
    propellant: "LOX/RP-1",   // Kerolox: RP-1 and LOX; the dense combination was essential for the S-IC stage's mass fraction
    thrustSeaLevel: 6_770_000, // N (6.77 MN) — source: NASA Saturn V Flight Manual; this is the thrust of a SINGLE F-1 engine; 5 together = 33.85 MN
    thrustVacuum: 7_770_000,  // N (7.77 MN) — vacuum thrust; the S-IC burns mostly in the lower atmosphere so sea-level thrust dominated
    specificImpulseSeaLevel: 263, // s — source: NASA Saturn V data; lower Isp than modern engines but compensated by massive propellant mass
    specificImpulseVacuum: 304,   // s — vacuum Isp; gas-generator cycle wastes some propellant driving turbines (turbine exhaust dumped overboard)
    throttleable: false,      // NOT throttleable — fixed thrust from ignition to stage separation; no precision control needed for Saturn V ascent
    throttleRangeMin: 100,    // % — only runs at full thrust
    throttleRangeMax: 100,    // % — no throttle range
    restartable: false,       // Single-start, single-burn design; no restart capability
    lengthM: 5.79,            // m — source: NASA Saturn V Flight Manual; taller than a school bus
    diameterM: 3.76,          // m — nozzle exit diameter: 3.76 m diameter nozzle; fits inside the 10 m S-IC stage
    referenceBurnTimeS: 150,  // s — S-IC first stage burned for approximately 2.5 minutes
  },
];

// ─── FUEL TANKS CATALOG ───────────────────────────────────────────────────────

/**
 * Propellant storage tanks covering the three main propellant families.
 * Mass ratio (propellant mass / total stage mass) is the most critical
 * factor in the Tsiolkovsky rocket equation — higher is always better.
 * Modern tanks achieve mass ratios of 10:1 to 30:1 (structure:propellant).
 */
export const FUEL_TANKS: FuelTank[] = [
  {
    // ── SMALL LOX/RP-1 TANK ───────────────────────────────────────────────────
    id: "small-lox-rp1-tank",      // Unique ID used in save/load and React keys
    name: "Small LOX/RP-1 Tank",   // Descriptive name; size and propellant type clearly stated
    category: "fuelTank",          // Tank category: feeds propellant to engines in same stage
    manufacturer: "Generic",       // No specific manufacturer; represents small commercial tank
    mass: 500,                     // kg dry mass — the empty tank structure; ~5% of propellant mass (good ratio)
    cost: 500_000,                 // USD — small tank, low cost; scale-appropriate
    assemblyTimeSeconds: 15,       // 15 seconds: moderate size, requires welding to airframe
    description: "Small kerolox tank for sounding rockets and small orbital boosters. Aluminum-lithium construction minimizes dry mass. Compatible with Rutherford, Merlin, RD-180, and F-1 engines.",
    propellantType: "LOX/RP-1",    // Kerolox: compatible ONLY with engines that burn LOX/RP-1
    capacityKg: 10_000,            // kg of propellant this tank holds when full; enough for ~3.5s of Merlin 1D burn
    dryMassKg: 500,                // kg — same as mass field; the structural tank mass
    lengthM: 3.0,                  // m — height of the cylindrical tank section
    diameterM: 2.0,                // m — outer diameter; must be compatible with interstage adapters
    material: "Aluminum-lithium alloy", // Al-Li alloy: 8% lighter than conventional 2219 aluminum, used in Falcon 9 tanks
  },
  {
    // ── MEDIUM LOX/RP-1 TANK ─────────────────────────────────────────────────
    id: "medium-lox-rp1-tank",     // Unique ID
    name: "Medium LOX/RP-1 Tank",  // Mid-size kerolox tank; Falcon 9 first stage equivalent
    category: "fuelTank",          // Propellant storage
    manufacturer: "Generic",       // Represents typical medium launch vehicle tank
    mass: 2_000,                   // kg dry — 4% of propellant mass; realistic for welded aluminum alloy
    cost: 2_000_000,               // USD — scales with size and fabrication complexity
    assemblyTimeSeconds: 25,       // 25 seconds: large, requires complex welding and pressure testing
    description: "Medium-scale kerolox propellant tank for orbital-class first stages. Based on Falcon 9 first stage tank geometry. Aluminum-lithium alloy with internal propellant management baffles.",
    propellantType: "LOX/RP-1",    // Only compatible with LOX/RP-1 engines (Merlin, RD-180, F-1, Rutherford)
    capacityKg: 50_000,            // kg — enough for ~18s of 9 Merlin engines or ~13s of RD-180; drives mission capability
    dryMassKg: 2_000,              // kg — empty tank mass; 4% mass fraction is typical for welded propellant tanks
    lengthM: 8.0,                  // m — tall tank section; Falcon 9 first stage tanks are ~35m total including structure
    diameterM: 3.7,                // m — matches Falcon 9's 3.7m diameter; standard medium launch vehicle form factor
    material: "Aluminum-lithium alloy", // Same material as Falcon 9; better specific strength than 2219 aluminum
  },
  {
    // ── LARGE LOX/LH2 TANK (SLS Core Stage) ─────────────────────────────────
    id: "large-lox-lh2-tank",      // Unique ID
    name: "Large LOX/LH2 Tank",    // SLS Core Stage equivalent; the largest tank in this catalog
    category: "fuelTank",          // Propellant storage
    manufacturer: "Boeing",        // Boeing builds the SLS Core Stage at the Michoud Assembly Facility
    mass: 85_270,                  // kg dry — source: NASA SLS Core Stage data; heavy because LH2 requires very large tank volume (LH2 is 7× less dense than RP-1)
    cost: 500_000_000,             // USD — SLS Core Stage is notoriously expensive; each one costs ~$500M
    assemblyTimeSeconds: 60,       // 60 seconds: enormous tank, complex cryogenic insulation, lengthy certification
    description: "SLS Core Stage equivalent cryogenic tank system. Carries liquid hydrogen (LH2) and liquid oxygen (LOX) for RS-25 engines. LH2's low density requires a massive tank — 40m tall.",
    propellantType: "LOX/LH2",     // ONLY compatible with LOX/LH2 engines (RS-25)
    capacityKg: 987_000,           // kg — source: NASA SLS Core Stage; combined LOX+LH2 propellant load (730,000 kg LOX + 256,000 kg LH2 approx)
    dryMassKg: 85_270,             // kg — source: NASA; heavy due to insulation, large structure, and complex plumbing for cryogenic propellants
    lengthM: 40.0,                 // m — source: NASA SLS imagery; LH2's low density (71 kg/m³) requires an enormous tank
    diameterM: 8.4,                // m — source: NASA SLS Core Stage; matches Space Shuttle External Tank diameter
    material: "Aluminum 2219",     // Al-2219: same alloy used on Space Shuttle External Tank; excellent cryogenic performance
  },
  {
    // ── SMALL LOX/CH4 TANK ───────────────────────────────────────────────────
    id: "small-lox-ch4-tank",      // Unique ID
    name: "Small LOX/CH4 Tank",    // Small methalox tank for Raptor-engine configurations
    category: "fuelTank",          // Propellant storage
    manufacturer: "Generic",       // Represents generic small methalox tank
    mass: 1_200,                   // kg dry — slightly heavier than RP-1 equivalent due to higher tank pressure requirements for CH4
    cost: 800_000,                 // USD estimate
    assemblyTimeSeconds: 20,       // 20 seconds: similar to LOX/RP-1 but requires methane-specific seals
    description: "Small methane-oxygen propellant tank for Raptor-engined vehicles. Liquid methane requires moderately cryogenic storage (-161°C). Compatible with Raptor 2 and BE-4 engines.",
    propellantType: "LOX/CH4",     // Methalox: compatible with Raptor 2; BE-4 uses LOX/LNG (similar but requires LOX/LNG tank)
    capacityKg: 30_000,            // kg — methane is less dense than RP-1 but more dense than LH2; good compromise
    dryMassKg: 1_200,              // kg — empty tank structural mass; 4% of propellant mass
    lengthM: 5.0,                  // m — taller than RP-1 tank of same capacity due to lower CH4 density
    diameterM: 3.7,                // m — same diameter as Falcon 9 for compatibility with interstage adapters
    material: "Stainless steel 301", // SpaceX uses stainless for Starship tanks; cost-effective and strong at cryogenic temps
  },
  {
    // ── MEDIUM LOX/CH4 TANK ──────────────────────────────────────────────────
    id: "medium-lox-ch4-tank",     // Unique ID
    name: "Medium LOX/CH4 Tank",   // Starship / Super Heavy scale methalox tank
    category: "fuelTank",          // Propellant storage
    manufacturer: "SpaceX",        // SpaceX builds Starship's stainless steel propellant tanks at Boca Chica
    mass: 4_000,                   // kg dry — 4% of propellant load; stainless steel is heavier but cost-effective
    cost: 5_000_000,               // USD estimate for a large stainless steel cryogenic vessel
    assemblyTimeSeconds: 35,       // 35 seconds: large tank, complex methane-compatible insulation and valves
    description: "Super Heavy/Starship scale methane-oxygen propellant tank. Stainless steel construction. At full capacity holds enough propellant for several Raptor 2 engines to fire for minutes.",
    propellantType: "LOX/CH4",     // Methalox: must be matched with Raptor 2 engine
    capacityKg: 100_000,           // kg — large tank; at Raptor's burn rate (650 kg/s), this lasts ~154 seconds
    dryMassKg: 4_000,              // kg — 4% dry mass fraction for stainless steel construction
    lengthM: 15.0,                 // m — very tall to accommodate methane's medium density
    diameterM: 5.0,                // m — wider than Falcon 9 to reduce height and improve aerodynamics
    material: "Stainless steel 301", // SpaceX uses 304L/301 stainless for Starship; unexpectedly optimal at cryogenic temperatures
  },
  {
    // ── SMALL LOX/LNG TANK ───────────────────────────────────────────────────
    id: "small-lox-lng-tank",      // Unique ID for BE-4 compatibility
    name: "Small LOX/LNG Tank",    // LNG tank: compatible with BE-4 engine
    category: "fuelTank",          // Propellant storage
    manufacturer: "Blue Origin",   // Blue Origin builds New Glenn's propellant tanks
    mass: 1_500,                   // kg dry — slightly heavier than CH4 tank due to LNG's higher density requiring thicker walls at pressure
    cost: 1_000_000,               // USD estimate
    assemblyTimeSeconds: 22,       // 22 seconds: similar to CH4 tank but LNG-specific fittings
    description: "Liquefied natural gas (LNG) + LOX propellant tank. LNG is ~90% methane with heavier hydrocarbons. Compatible with Blue Origin BE-4 engine. LNG is cheaper than refined methane and has higher energy density.",
    propellantType: "LOX/LNG",     // LOX/LNG: matches BE-4 propellant type specifically
    capacityKg: 40_000,            // kg — LNG is denser than pure methane, so same volume = more propellant mass
    dryMassKg: 1_500,              // kg — empty tank structural mass
    lengthM: 6.0,                  // m — moderate tank height
    diameterM: 3.7,                // m — standard diameter for compatibility
    material: "Aluminum-lithium alloy", // Al-Li alloy: lighter than stainless, good cryogenic performance
  },
];

// ─── NOSE CONES CATALOG ───────────────────────────────────────────────────────

/**
 * Aerodynamic nose cones and payload fairings.
 * The nose cone is the only part that goes on TOP of the entire rocket stack.
 * Without a nose cone, the drag coefficient is approximately doubled,
 * drastically reducing maximum altitude for any given Δv.
 */
export const NOSE_CONES: NoseCone[] = [
  {
    // ── SMALL OGIVE NOSE CONE ────────────────────────────────────────────────
    id: "small-ogive-nose",        // Unique ID
    name: "Small Ogive Nose Cone", // Ogive = curved profile that minimizes wave drag
    category: "noseCone",          // Must be placed at the top of the rocket stack
    manufacturer: "Generic",       // Standard small vehicle nose cone
    mass: 50,                      // kg — very light; carbon fiber is one of the lightest structural materials
    cost: 50_000,                  // USD — small composite structure
    assemblyTimeSeconds: 8,        // 8 seconds: lightest, smallest part to install — just 4 attachment bolts
    description: "Lightweight ogive nose cone for small sounding rockets and suborbital vehicles. Carbon fiber construction. Covers payloads up to 500 kg. Does not separate — payload must be mounted at base.",
    dragCoefficientReduction: 0.15, // Reduces base Cd by 0.15 — significant improvement over a blunt top
    lengthM: 1.5,                  // m — 1.5m nose cone for a small vehicle; aerodynamically adequate
    diameterM: 1.3,                // m — base diameter; must match the top stage diameter
    material: "Carbon fiber composite", // CFRP: highest specific stiffness material for aerospace structures
    payloadCapacityKg: 500,        // kg — max payload this nose cone section can protect
  },
  {
    // ── MEDIUM PAYLOAD FAIRING (Falcon 9 size) ────────────────────────────────
    id: "medium-fairing",          // Unique ID; "fairing" is the industry term for payload-enclosing nose cones
    name: "Medium Payload Fairing", // Falcon 9 fairing equivalent
    category: "noseCone",          // Placed at top of rocket stack
    manufacturer: "Ruag Space",    // Real fairing manufacturer; Ruag builds Falcon 9's fairings in Switzerland
    mass: 1_900,                   // kg — source: SpaceX Falcon 9 User's Guide; fairing halves weigh ~950 kg each; SpaceX recovers and reuses them
    cost: 6_000_000,               // USD — SpaceX fairing cost; one reason SpaceX developed fairing catcher ships
    assemblyTimeSeconds: 30,       // 30 seconds: large, must enclose payload, complex separation bolts
    description: "Medium payload fairing similar to Falcon 9's 5.2m fairing. Two-shell composite construction. Jettisons at ~110km altitude once aerodynamic pressure drops below 0.1 kPa. Protects up to 5,000 kg payloads.",
    dragCoefficientReduction: 0.20, // Reduces Cd by 0.20; larger fairing provides better aerodynamic shaping
    lengthM: 13.2,                 // m — source: SpaceX Falcon 9 User's Guide; 13.2m total fairing height
    diameterM: 5.2,                // m — source: SpaceX; Falcon 9's large fairing option (standard is 5.2m diameter)
    material: "Carbon fiber composite", // CFRP: standard material for payload fairings; stiff, light, smooth surface
    payloadCapacityKg: 5_000,      // kg — can protect payloads up to 5,000 kg; typical GTO satellite range
  },
  {
    // ── LARGE PAYLOAD FAIRING (SLS size) ─────────────────────────────────────
    id: "large-fairing",           // Unique ID
    name: "Large Payload Fairing", // SLS-scale fairing for heavy-lift payloads
    category: "noseCone",          // Placed at top of rocket stack
    manufacturer: "United Launch Alliance", // ULA builds large fairings for heavy-lift vehicles
    mass: 4_000,                   // kg — source: SLS documentation; large aluminum fairing is heavier than CFRP
    cost: 30_000_000,              // USD — large fairing cost is significant; part of why SLS is expensive
    assemblyTimeSeconds: 45,       // 45 seconds: enormous structure requiring crane operations and precise alignment
    description: "SLS-scale payload fairing for heavy-lift missions. Aluminum construction. Encloses large payloads for lunar and deep-space missions. 8.4m diameter accommodates space station modules and large telescopes.",
    dragCoefficientReduction: 0.25, // Reduces Cd by 0.25; large blunt-nosed fairing still adds some base drag
    lengthM: 19.0,                 // m — source: NASA SLS documentation; taller than a 5-story building
    diameterM: 8.4,                // m — source: NASA; matches SLS Core Stage diameter; world's widest production fairing
    material: "Aluminum alloy",    // Aluminum: heavier than CFRP but simpler to manufacture for single-use applications
    payloadCapacityKg: 20_000,     // kg — can protect large space station modules, deep-space probes, lunar landers
  },
];

// ─── RCS THRUSTERS CATALOG ────────────────────────────────────────────────────

/**
 * Reaction Control System thrusters for attitude control in vacuum.
 * RCS thrusters fire in pairs (one on each side) to rotate the rocket
 * without changing its translational trajectory.
 * These are always hypergolic (self-igniting) or cold-gas for reliability.
 */
export const RCS_THRUSTERS: RCSThruster[] = [
  {
    // ── COLD GAS THRUSTER (N2) ────────────────────────────────────────────────
    id: "cold-gas-n2",             // Unique ID
    name: "Cold Gas Thruster (N2)", // Simplest possible thruster: pressurized nitrogen gas
    category: "rcsThruster",       // RCS: can go on any stage
    manufacturer: "Moog",          // Moog is the leading RCS thruster manufacturer
    mass: 1,                       // kg — extremely lightweight; just a solenoid valve and nozzle
    cost: 10_000,                  // USD — very cheap; used on small satellites and early spacecraft
    assemblyTimeSeconds: 3,        // 3 seconds: lightest, simplest part in the entire catalog
    description: "Cold gas nitrogen thruster — the simplest possible RCS. Pressurized N2 expelled through a nozzle. Very safe (inert gas), but extremely low Isp (65s). Used on small spacecraft and early Apollo hardware.",
    thrustN: 10,                   // N — 10 N is enough for small attitude corrections; tiny but adequate
    propellant: "N2",              // Cold nitrogen gas: stored as compressed gas, not cryogenic liquid
    specificImpulseS: 65,          // s — very low Isp because no combustion occurs; purely expansion of compressed gas
    includedFuelMassKg: 0.5,       // kg — small nitrogen tank included; limits total impulse available
  },
  {
    // ── DRACO (SpaceX Dragon) ────────────────────────────────────────────────
    id: "draco",                   // Unique ID; Draco = SpaceX's name for Dragon's RCS thrusters
    name: "Draco",                 // SpaceX Dragon's reaction control thruster
    category: "rcsThruster",       // RCS: attitude control, orbital maneuvering
    manufacturer: "SpaceX",        // Developed in-house by SpaceX for Dragon
    mass: 4.5,                     // kg per thruster — source: SpaceX Dragon press kit; lightweight for 400N thrust
    cost: 100_000,                 // USD estimate — SpaceX doesn't publish individual Draco costs
    assemblyTimeSeconds: 5,        // 5 seconds: small hypergolic thruster, straightforward installation
    description: "SpaceX Dragon's hypergolic RCS thruster. Burns MMH/NTO — propellants that ignite on contact without an igniter. 18 Draco thrusters on Dragon provide 6-DOF attitude control and deorbit capability.",
    thrustN: 400,                  // N (400 N) — source: SpaceX Dragon press kit; each thruster produces 400N; significant RCS capability
    propellant: "MMH/NTO",         // Monomethylhydrazine + nitrogen tetroxide: hypergolic, no ignition system needed
    specificImpulseS: 300,         // s — source: SpaceX; reasonable Isp for hypergolic propellant combination
    includedFuelMassKg: 10,        // kg — Dragon carries ~1,290 kg total for all 18 Dracos; per unit ~10 kg
  },
  {
    // ── R-4D (Apollo heritage thruster) ──────────────────────────────────────
    id: "r-4d",                    // Unique ID; R-4D = Rocket-4D (Marquardt designation)
    name: "R-4D",                  // Aerojet Rocketdyne's legendary hypergolic thruster; heritage from Apollo
    category: "rcsThruster",       // RCS attitude control thruster
    manufacturer: "Aerojet Rocketdyne", // Original manufacturer: Marquardt Corp, now Aerojet Rocketdyne
    mass: 3.6,                     // kg — source: Aerojet Rocketdyne R-4D data sheet; extremely lightweight
    cost: 150_000,                 // USD — flight-proven, reliable thruster commands premium pricing
    assemblyTimeSeconds: 5,        // 5 seconds: small, proven design with standard fittings
    description: "Apollo-heritage hypergolic thruster still in production. Powers attitude control on commercial satellites, Boeing CST-100 Starliner, and scientific spacecraft worldwide. Extremely reliable — zero flight failures in 50+ years.",
    thrustN: 490,                  // N (490 N) — source: Aerojet Rocketdyne R-4D product sheet; slightly more than Draco
    propellant: "NTO/MMH",         // NTO/MMH: same propellants as Draco (NTO = oxidizer, MMH = fuel), different ordering convention
    specificImpulseS: 312,         // s — source: Aerojet data sheet; slightly higher Isp than Draco due to refined design
    includedFuelMassKg: 10,        // kg — propellant tank included with each thruster unit
  },
];

// ─── FINS CATALOG ─────────────────────────────────────────────────────────────

/**
 * Aerodynamic fins for passive and active stability.
 * All fin sets must be attached to the BOTTOM STAGE ONLY.
 * Stability is achieved when the center of pressure (CP) is BELOW
 * the center of mass (CM) — fins push CP down toward the tail.
 * Each "part" represents a complete set of 4 fins ready to install.
 */
export const FINS: Fin[] = [
  {
    // ── CARBON FIBER FINS (lightweight option) ────────────────────────────────
    id: "cf-fins",                 // Unique ID
    name: "Carbon Fiber Fins (set of 4)", // Set of 4; lightest fin option
    category: "fin",               // Bottom stage only
    manufacturer: "Generic",       // Represents lightweight composite fin sets
    mass: 40,                      // kg for all 4 fins — CFRP is the lightest structural material
    cost: 80_000,                  // USD — CFRP is expensive to manufacture but lightweight
    assemblyTimeSeconds: 15,       // 15 seconds: lightweight but require careful alignment to prevent roll
    description: "Lightweight carbon fiber fin set for small to medium vehicles. Passive stability only — cannot steer. Best mass-to-stability ratio. Used on high-performance sounding rockets and small orbital launchers.",
    stabilityContribution: 0.7,   // 0-1 scale; 0.7 = significant stability contribution; lighter than titanium grid fins
    dragPenalty: 0.03,             // Adds 0.03 to the overall Cd; small flat fins are aerodynamically efficient
    controllable: false,           // Fixed fins: cannot rotate to steer; passive stability only
    material: "Carbon fiber composite", // CFRP: ideal for high-speed flight where minimal mass is critical
    setOf: 4,                      // 4 fins in this set; the mass field covers all 4
  },
  {
    // ── FIXED ALUMINUM FINS ───────────────────────────────────────────────────
    id: "aluminum-fins",           // Unique ID
    name: "Fixed Aluminum Fins (set of 4)", // Standard aluminum fin set; heavier but cheaper
    category: "fin",               // Bottom stage only
    manufacturer: "Generic",       // Represents standard aluminum fin sets
    mass: 80,                      // kg for all 4 — aluminum is twice as heavy as CFRP but 10× cheaper to make
    cost: 20_000,                  // USD — machined aluminum fins are inexpensive to produce
    assemblyTimeSeconds: 12,       // 12 seconds: simple, rigid fins are quicker to bolt on than deployable/active systems
    description: "Standard aluminum fixed fin set. Reliable passive stability for subsonic and low-supersonic flight. Cost-effective choice for expendable vehicles. High stability contribution due to large fin area.",
    stabilityContribution: 0.85,  // Higher contribution than CF fins due to larger fin area for same cost
    dragPenalty: 0.05,             // Slightly more drag than CF fins due to larger plan area and less optimized profile
    controllable: false,           // Fixed: passive stability only, no active steering
    material: "Aluminum 6061-T6",  // 6061-T6: standard aerospace aluminum alloy; excellent machinability and strength
    setOf: 4,                      // 4 fins per set
  },
  {
    // ── TITANIUM GRID FINS (Falcon 9 style) ───────────────────────────────────
    id: "ti-grid-fins",            // Unique ID; grid fins are a specific aerodynamic surface type
    name: "Titanium Grid Fins (set of 4)", // Falcon 9's iconic deployable grid fins for precision landing
    category: "fin",               // Bottom stage only (they're reentry/landing steering devices)
    manufacturer: "SpaceX",        // SpaceX developed titanium grid fins for Falcon 9 reuse program
    mass: 200,                     // kg for all 4 — source: SpaceX; titanium + actuator system is heavy
    cost: 1_000_000,               // USD — titanium machining and actuator system is expensive
    assemblyTimeSeconds: 20,       // 20 seconds: actuators, hydraulic lines, and control system wiring needed
    description: "SpaceX Falcon 9 style titanium grid fins. Deployable for ascent, deployed during reentry for precise landing zone steering. Each fin has a grid lattice structure — maximizes force while minimizing mass. Survives 1300°C reentry.",
    stabilityContribution: 0.6,   // Lower passive stability than flat fins, but can actively steer
    dragPenalty: 0.08,             // Grid fin open structure creates more drag than solid fins (acceptable at subsonic speeds)
    controllable: true,            // KEY: actively controlled for steering during descent and landing approach
    material: "Titanium",          // Titanium: survives 1300°C reentry heating; stainless steel grid fins used on Starship
    setOf: 4,                      // 4 grid fins on Falcon 9; positioned 90° apart around the booster circumference
  },
];

// ─── INTERSTAGE ADAPTERS CATALOG ──────────────────────────────────────────────

/**
 * Structural couplings between rocket stages.
 * Required between every pair of stages (1→2, 2→3).
 * The adapter must handle enormous compressive loads during ascent
 * (~10g deceleration during separation) and tensile loads during ascent.
 */
export const INTERSTAGE_ADAPTERS: InterstageAdapter[] = [
  {
    // ── SMALL INTERSTAGE ADAPTER ──────────────────────────────────────────────
    id: "small-interstage",        // Unique ID
    name: "Small Interstage (2m)", // 2 meter diameter coupling
    category: "interstageAdapter", // Between-stage structural component
    manufacturer: "Generic",       // Generic representation
    mass: 100,                     // kg — small adapter; mostly thin-wall aluminum cylinder with bolt flanges
    cost: 100_000,                 // USD — relatively simple machined structure
    assemblyTimeSeconds: 10,       // 10 seconds: bolt-on flanged connection
    description: "Small interstage adapter for 2m diameter vehicles. Aluminum monocoque cylinder with integrated separation bolts. Mass: 100 kg. Handles axial loads up to 500 kN.",
    topDiameterM: 2.0,             // m — diameter at the top (connects to upper stage)
    bottomDiameterM: 2.0,          // m — diameter at the bottom (connects to lower stage); same diameter = straight cylinder
    material: "Aluminum 2219",     // Standard aerospace aluminum for structural cylinders
  },
  {
    // ── MEDIUM INTERSTAGE ADAPTER ─────────────────────────────────────────────
    id: "medium-interstage",       // Unique ID
    name: "Medium Interstage (3.7m)", // Falcon 9 diameter
    category: "interstageAdapter", // Between-stage component
    manufacturer: "Generic",       // Represents Falcon 9 scale interstage
    mass: 400,                     // kg — source: derived from Falcon 9 interstage mass estimates; carbon fiber composite is lighter than aluminum
    cost: 500_000,                 // USD — larger, more complex structure
    assemblyTimeSeconds: 15,       // 15 seconds: requires alignment of fuel/power umbilicals in addition to bolts
    description: "Falcon 9 scale interstage adapter. Carbon fiber composite cylinder housing stage separation pyrotechnics, inter-stage electrical umbilicals, and pneumatic lines.",
    topDiameterM: 3.7,             // m — matches Falcon 9 upper stage and second stage diameter
    bottomDiameterM: 3.7,          // m — matches Falcon 9 first stage diameter; constant diameter throughout
    material: "Carbon fiber composite", // CFRP: used on Falcon 9 interstage for mass savings
  },
  {
    // ── LARGE INTERSTAGE ADAPTER ──────────────────────────────────────────────
    id: "large-interstage",        // Unique ID
    name: "Large Interstage (5.2m)", // SLS / Delta IV Heavy scale
    category: "interstageAdapter", // Between-stage component
    manufacturer: "Boeing",        // Boeing builds SLS structural components
    mass: 800,                     // kg — heavy structural adapter for large vehicle
    cost: 5_000_000,               // USD — large aerospace structures are expensive to fabricate
    assemblyTimeSeconds: 20,       // 20 seconds: crane required for large interstage installation
    description: "Heavy-lift interstage adapter for SLS/Delta IV scale vehicles. Aluminum-lithium alloy frustum (tapered cylinder) to transition between different diameter stages. Handles up to 50 MN axial load.",
    topDiameterM: 5.2,             // m — connects to upper stage fairing interface ring
    bottomDiameterM: 8.4,          // m — connects to wide SLS Core Stage; frustum shape transitions diameter
    material: "Aluminum-lithium alloy", // Al-Li: standard for large structural components where mass is critical
  },
];

// ─── LANDING LEGS CATALOG ─────────────────────────────────────────────────────

/**
 * Landing leg sets for propulsive vertical landings.
 * Goes on the BOTTOM STAGE ONLY.
 * These must absorb the kinetic energy of touchdown to prevent bounce/tip-over.
 * Falcon 9 lands at ~2 m/s with ~550,000 kg first stage = ~1.1 MJ kinetic energy.
 */
export const LANDING_LEGS: LandingLeg[] = [
  {
    // ── FIXED LANDING STRUTS ──────────────────────────────────────────────────
    id: "fixed-struts",            // Unique ID
    name: "Fixed Landing Struts (set of 4)", // Non-deployable, simple legs
    category: "landingLeg",        // Bottom stage only
    manufacturer: "Generic",       // Generic fixed landing strut design
    mass: 500,                     // kg for all 4 — lighter than deployable legs because no deployment mechanism
    cost: 200_000,                 // USD — simple fixed structure is inexpensive
    assemblyTimeSeconds: 12,       // 12 seconds: simple bolt-on struts with no moving parts
    description: "Simple fixed landing struts for light vehicles. Non-deployable — always in landing position, adding drag during ascent. Limited shock absorption. Best for small vehicles with gentle touchdown velocities.",
    shockAbsorptionJ: 200_000,     // J (200 kJ) — absorbs up to 200,000 J; adequate for small rockets landing at ~1-2 m/s
    deployable: false,             // Fixed: cannot fold for ascent; creates aerodynamic drag throughout flight
    setOf: 4,                      // 4 struts per set; typically mounted 90° apart
  },
  {
    // ── FALCON 9 STYLE DEPLOYABLE LEGS ────────────────────────────────────────
    id: "falcon9-legs",            // Unique ID
    name: "Falcon 9 Style Legs (set of 4)", // Carbon fiber honeycomb deployable legs
    category: "landingLeg",        // Bottom stage only
    manufacturer: "SpaceX",        // SpaceX designed and manufactures Falcon 9 landing legs
    mass: 2_000,                   // kg for all 4 — source: SpaceX; 500 kg per leg including aluminum honeycomb crush core
    cost: 3_000_000,               // USD — complex deployable mechanism with carbon fiber structure
    assemblyTimeSeconds: 20,       // 20 seconds: complex deployment mechanism with actuator connections
    description: "SpaceX Falcon 9 style carbon fiber honeycomb deployable landing legs. Deploy at ~7km altitude via pneumatic actuators. Aluminum crush core absorbs landing energy. Each leg is 10m long when deployed.",
    shockAbsorptionJ: 500_000,     // J (500 kJ) — source: SpaceX; enough for Falcon 9's 550,000 kg first stage at ~1.3 m/s
    deployable: true,              // Fold flat against the booster for ascent; deploy just before landing
    setOf: 4,                      // 4 legs; Falcon 9 uses exactly 4 legs in an X-pattern for landing stability
  },
  {
    // ── HEAVY DEPLOYABLE LEGS (New Shepard / New Glenn style) ─────────────────
    id: "heavy-legs",              // Unique ID
    name: "Heavy Landing Legs (set of 4)", // For heavy boosters landing with significant kinetic energy
    category: "landingLeg",        // Bottom stage only
    manufacturer: "Blue Origin",   // Blue Origin uses heavy legs on New Shepard and New Glenn boosters
    mass: 3_000,                   // kg for all 4 — heavier because designed for larger/heavier vehicles
    cost: 8_000_000,               // USD — heavy-duty deployable structure with significant engineering
    assemblyTimeSeconds: 25,       // 25 seconds: heaviest landing leg set; requires crane and detailed actuator setup
    description: "Heavy-duty deployable landing legs for large first stage boosters. Stronger actuators and larger crush cores than Falcon 9 legs. Designed for New Glenn class 3,000+ tonne first stages. 800 kJ absorption capacity.",
    shockAbsorptionJ: 800_000,     // J (800 kJ) — significantly more energy absorption for massive boosters
    deployable: true,              // Folds for ascent; deploys for landing via nitrogen gas actuators
    setOf: 4,                      // 4 legs per set
  },
];

// ─── COMBINED CATALOG ─────────────────────────────────────────────────────────

/**
 * Master list of ALL parts: used by the catalog UI to render every available part
 * and by save/load functions to look up parts by ID.
 * Organized by category for easy filtering.
 */
export const ALL_PARTS: AnyRocketPart[] = [
  ...ENGINES,              // 7 engines
  ...FUEL_TANKS,           // 6 tanks
  ...NOSE_CONES,           // 3 nose cones
  ...RCS_THRUSTERS,        // 3 RCS thrusters
  ...FINS,                 // 3 fin sets
  ...INTERSTAGE_ADAPTERS,  // 3 interstage adapters
  ...LANDING_LEGS,         // 3 landing leg sets
];

/**
 * Look up any part by its unique ID string.
 * Used when loading saved rocket builds from localStorage:
 * the save format stores part IDs, and we need the full part data.
 *
 * @param id  The unique part ID (e.g., "merlin-1d", "rs-25")
 * @returns   The full AnyRocketPart object, or undefined if not found
 */
export function findPartById(id: string): AnyRocketPart | undefined {
  // Linear scan of all parts; catalog is small enough that O(n) is fine
  return ALL_PARTS.find((p) => p.id === id); // Match on the unique string ID field
}
