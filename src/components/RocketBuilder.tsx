/**
 * ROCKET BUILDER COMPONENT
 * ========================
 * A three-panel UI that lets the user assemble a custom rocket from real-world parts.
 *
 * LAYOUT (left → center → right):
 *   40% | Parts Catalog  — browse and click parts to start assembly
 *   30% | Rocket Visual  — vertical stack diagram updated in real time
 *   30% | Stats Panel    — live TWR, Δv, altitude estimate, warnings, launch button
 *
 * ASSEMBLY SIMULATION:
 *   When a part is clicked, a real-time countdown starts (3–60 seconds depending
 *   on the part's assemblyTimeSeconds). The user CANNOT add another part while
 *   one is assembling. Rotating status messages simulate real installation steps.
 *   When the timer completes, a rising tone plays and the part appears on the rocket.
 *
 * PHYSICS CALCULATIONS:
 *   - TWR = totalThrust / (totalMass × 9.81)          [must be > 1.0 to lift off]
 *   - burnRate = engineThrust / (Isp × 9.81)           [kg/s at full throttle]
 *   - Δv = Isp × 9.81 × ln(m_initial / m_final)       [Tsiolkovsky rocket equation]
 *   - altitude ≈ Δv² / (2 × 9.81)                     [rough suborbital estimate]
 *
 * COMPATIBILITY RULES:
 *   - Engine propellant must match fuel tank propellant type (exact string match)
 *   - Each stage needs at least 1 engine AND 1 fuel tank
 *   - Nose cone: top of uppermost stage only
 *   - Fins/legs: bottom stage only (stageIndex === 0)
 *   - Interstage: between consecutive stages
 *   - Max 3 stages, max 9 engines per stage
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
// React is needed for JSX and hooks — the entire component tree is React functional components

import {
  type AnyRocketPart,
  type Engine,
  type FuelTank,
  type NoseCone,
  type RCSThruster,
  type Fin,
  type InterstageAdapter,
  type LandingLeg,
  ENGINES,
  FUEL_TANKS,
  NOSE_CONES,
  RCS_THRUSTERS,
  FINS,
  INTERSTAGE_ADAPTERS,
  LANDING_LEGS,
  ASSEMBLY_MESSAGES,
  findPartById,
} from "../data/RocketPartsCatalog";
// Import the entire catalog of parts and their type definitions

import {
  createRocketStage,
  type MultiStageRocketConfig,
} from "../physics/MultiStageSystem";
// createRocketStage: factory that auto-calculates burn rate from thrust and Isp
// MultiStageRocketConfig: the format the physics engine accepts for simulation

import { AudioManager } from "../utils/AudioSystem";
// AudioManager: Web Audio API wrapper; plays the assembly-complete rising tone

import { COLORS } from "../utils/constants";
// COLORS: shared color constants matching the rest of the simulator UI theme

import { HologramViewer } from "./HologramViewer";
// HologramViewer: renders a rotating 3D wireframe hologram of a rocket part on a canvas.
// Used in the catalog tiles (thumbnail, auto-rotating) and in the assembly stack (static icon).

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const GRAVITY_MS2 = 9.81;
// Standard gravity in m/s²: used in Tsiolkovsky equation (Δv = Isp × g₀ × ln(m₀/mf))
// and TWR calculation (TWR = Thrust / (Mass × 9.81))

const MAX_STAGES = 3;
// Maximum number of rocket stages the builder allows; more would be unrealistic to
// simulate cleanly and is unnecessary for educational purposes

const MAX_ENGINES_PER_STAGE = 9;
// Real-world limit: SpaceX uses 9 engines (Octaweb + center) on Falcon 9 first stage;
// more than 9 creates complex plumbing and structural challenges

const PAYLOAD_MASS_KG = 500;
// kg — fixed payload mass representing a generic small satellite at the top of the rocket;
// included in the Δv calculation as non-propellant mass in the uppermost stage

const ASSEMBLY_UPDATE_INTERVAL_MS = 50;
// ms — how often the assembly progress bar updates; 50ms = 20 fps for the progress bar,
// smooth enough visually without taxing the browser with too many setInterval callbacks

const LOCALSTORAGE_KEY = "rocketBuilder_saves";
// localStorage key under which saved rocket builds are stored as a JSON array;
// must be unique to avoid collision with other app data

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * Represents a single stage in the user's current build.
 * Stages are indexed 0 = bottom (fires first), increasing upward.
 * The physics engine will simulate them from stageIndex 0 upward.
 */
interface BuildStage {
  stageIndex: number;                    // 0 = first to fire (bottom), 1 = second, 2 = third
  engines: Engine[];                     // All engines attached to this stage (1–9)
  fuelTanks: FuelTank[];                 // All fuel tanks feeding engines in this stage
  rcsThrusters: RCSThruster[];           // RCS attitude control thrusters on this stage
  fins: Fin | null;                      // Aerodynamic fin set; only allowed on stageIndex 0
  landingLegs: LandingLeg | null;        // Landing leg set; only allowed on stageIndex 0
  interstageAdapter: InterstageAdapter | null; // Connects THIS stage to the one ABOVE it
  noseCone: NoseCone | null;             // Aerodynamic nose cap; only on the topmost stage
}

/**
 * Tracks the state of an in-progress part installation.
 * Assembly is a real-time countdown: the user must wait while the part
 * is "installed", simulating actual rocket assembly processes.
 */
interface AssemblyInProgress {
  part: AnyRocketPart;       // The part being assembled
  stageIndex: number;        // Which stage the part is being added to
  startTimeMs: number;       // Date.now() when assembly started; used to compute elapsed time
  totalTimeMs: number;       // assemblyTimeSeconds × 1000; total time needed to complete
  messageIndex: number;      // 0–3: which assembly step message to show (cycles every 25%)
}

/**
 * A single validation warning or success message shown in the stats panel.
 * The builder accumulates these from getWarnings() and renders them as a list.
 */
interface BuildWarning {
  severity: "error" | "warning" | "success"; // Error = cannot launch; warning = launch OK but suboptimal; success = all good
  message: string;                           // Human-readable explanation of the issue or achievement
}

/**
 * Persisted build data stored in localStorage.
 * Only IDs are saved (not full part objects) to keep the save small and
 * to allow part specs to be updated without invalidating saves.
 */
interface SavedBuild {
  name: string;                    // User-given name for this rocket
  savedAt: string;                 // ISO timestamp when saved (for display)
  stageCount: number;              // How many stages (used in the load list)
  stages: Array<{
    engineIds: string[];           // Part IDs of all engines on this stage
    tankIds: string[];             // Part IDs of all fuel tanks on this stage
    rcsThrusterIds: string[];      // Part IDs of all RCS thrusters on this stage
    finId: string | null;          // Part ID of the fin set, or null
    landingLegId: string | null;   // Part ID of the landing leg set, or null
    interstageAdapterId: string | null; // Part ID of the interstage adapter, or null
    noseConeId: string | null;     // Part ID of the nose cone, or null
  }>;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Create a fresh empty BuildStage for a given stage index.
 * Used when adding a new stage to the rocket and when initializing the first stage.
 *
 * @param stageIndex  0 = bottom stage, 1 = second, 2 = third
 * @returns           An empty BuildStage with no parts
 */
function createEmptyStage(stageIndex: number): BuildStage {
  return {
    stageIndex,            // Store the index so parts can check stageIndex === 0 for fin/leg eligibility
    engines: [],           // No engines yet; user must add at least one before launch
    fuelTanks: [],         // No tanks yet; user must add one before launch
    rcsThrusters: [],      // RCS is optional; start empty
    fins: null,            // No fins yet; only attachable on stageIndex 0
    landingLegs: null,     // No legs yet; only attachable on stageIndex 0
    interstageAdapter: null, // No adapter yet; required if there's a stage above this one
    noseCone: null,        // No nose cone yet; only attachable on the topmost stage
  };
}

/**
 * Compute the thrust-weighted average specific impulse for a set of engines.
 * When multiple engines with different Isp values fire together, the effective
 * combined Isp is NOT a simple arithmetic average — it weights by thrust because
 * a higher-thrust engine contributes more to the combined exhaust momentum.
 *
 * FORMULA (thrust-weighted harmonic mean):
 *   Isp_eff = Σ(F_i) / Σ(F_i / Isp_i)
 *   This is the correct formula from rocket propulsion thermodynamics.
 *   Source: Sutton "Rocket Propulsion Elements" Chapter 2.
 *
 * @param engines  Array of engines to combine
 * @returns        Effective combined Isp in seconds; returns 0 if no engines
 */
function computeEffectiveIsp(engines: Engine[]): number {
  if (engines.length === 0) return 0; // No engines: no Isp; avoid division by zero
  const totalThrust = engines.reduce((sum, e) => sum + e.thrustSeaLevel, 0); // Σ(F_i): sum all engine sea-level thrusts
  if (totalThrust === 0) return 0; // Zero thrust engines: return 0 to avoid division by zero
  const thrustOverIsp = engines.reduce((sum, e) => sum + e.thrustSeaLevel / e.specificImpulseSeaLevel, 0); // Σ(F_i/Isp_i): denominator term
  return totalThrust / thrustOverIsp; // Isp_eff = Σ(F_i) / Σ(F_i/Isp_i)
}

/**
 * Compute the combined sea-level thrust for an array of engines.
 * In multi-engine clusters (like Falcon 9's Octaweb), all engines fire simultaneously,
 * so their thrusts add directly.
 *
 * @param engines  Array of engines
 * @returns        Total sea-level thrust in Newtons
 */
function computeTotalEngineThrust(engines: Engine[]): number {
  return engines.reduce((sum, e) => sum + e.thrustSeaLevel, 0); // Simple addition: N1 + N2 + ... Nn
}

/**
 * Format a number with thousand-separators for readable display.
 * e.g., 845000 → "845,000"
 *
 * @param n  Number to format
 * @returns  Formatted string with comma separators
 */
function fmtNum(n: number): string {
  return Math.round(n).toLocaleString(); // toLocaleString adds locale-appropriate thousand separators
}

/**
 * Format a number in kg, auto-scaling to tonnes if ≥ 1000 kg.
 * e.g., 450 → "450 kg", 5480 → "5.5 t"
 *
 * @param kg  Mass in kilograms
 * @returns   Formatted string with appropriate unit
 */
function fmtMass(kg: number): string {
  if (kg >= 1000) return (kg / 1000).toFixed(1) + " t"; // Convert to tonnes (1 tonne = 1000 kg) for readability
  return Math.round(kg) + " kg"; // Under 1 tonne: show in kg for precision
}

/**
 * Format a Newton value, auto-scaling to kN or MN.
 * e.g., 845000 → "845 kN", 6770000 → "6.77 MN"
 *
 * @param n  Force in Newtons
 * @returns  Formatted string with appropriate unit
 */
function fmtThrust(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + " MN"; // Mega-Newtons for large engines
  if (n >= 1000) return (n / 1000).toFixed(0) + " kN";            // kilo-Newtons for medium engines
  return Math.round(n) + " N";                                      // Newtons for small RCS thrusters
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

/**
 * Props for the RocketBuilder component.
 * Passed from App.tsx when mode === 'BUILD'.
 */
interface RocketBuilderProps {
  onLaunch: (config: MultiStageRocketConfig) => void; // Called when user clicks LAUNCH with a valid rocket
  onSwitchToFlyMode: () => void;                       // Called when user wants to go back to the FLY view
}

/**
 * RocketBuilder — the main assembly UI.
 * Three-column layout: catalog | rocket visual | stats.
 */
export const RocketBuilder: React.FC<RocketBuilderProps> = ({ onLaunch, onSwitchToFlyMode }) => {

  // ── STAGES STATE ──────────────────────────────────────────────────────────
  // The user's current rocket build: an array of stages from bottom (index 0) to top.
  // Starts with a single empty first stage; user can add up to MAX_STAGES stages.
  const [stages, setStages] = useState<BuildStage[]>([createEmptyStage(0)]);

  // ── ASSEMBLY STATE ────────────────────────────────────────────────────────
  // When assembly is in progress, this holds the part being installed.
  // null means no assembly is happening (catalog is active and clickable).
  const [assembly, setAssembly] = useState<AssemblyInProgress | null>(null);

  // Progress 0.0–1.0: drives the width of the progress bar fill.
  // Updated every ASSEMBLY_UPDATE_INTERVAL_MS by the timer effect.
  const [assemblyProgress, setAssemblyProgress] = useState<number>(0);

  // ── CATALOG UI STATE ──────────────────────────────────────────────────────
  // Which category tab is currently open in the left catalog panel.
  type CatalogTab = "engine" | "fuelTank" | "noseCone" | "rcsThruster" | "fin" | "interstageAdapter" | "landingLeg";
  const [activeTab, setActiveTab] = useState<CatalogTab>("engine");

  // Which stage index the catalog is targeting (user chooses where to add parts).
  // Defaults to stage 0 (bottom); user can click on a stage in the center visual to change.
  const [targetStageIndex, setTargetStageIndex] = useState<number>(0);

  // ── SAVE/LOAD STATE ───────────────────────────────────────────────────────
  // Name to use when saving the current build; entered by user in the save field.
  const [saveNameInput, setSaveNameInput] = useState<string>("");

  // List of saved build names loaded from localStorage; refreshed on save/load actions.
  const [savedBuilds, setSavedBuilds] = useState<string[]>([]);

  // Whether the save/load panel is expanded (toggleable by button).
  const [showSavePanel, setShowSavePanel] = useState<boolean>(false);

  // ── AUDIO ─────────────────────────────────────────────────────────────────
  // AudioManager: uses Web Audio API to play sound effects.
  // Created once and stored in a ref so the game loop can always access it.
  const audioRef = useRef<AudioManager>(new AudioManager());

  // ── ASSEMBLY TIMER REF ────────────────────────────────────────────────────
  // Holds the setInterval ID so we can clear it when assembly is cancelled or completed.
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Mirror of the assembly state in a ref so the interval callback doesn't
  // close over a stale assembly value (React state updates are async).
  const assemblyRef = useRef<AssemblyInProgress | null>(null);

  // ── LOAD SAVED BUILDS ON MOUNT ────────────────────────────────────────────
  // When the component mounts, read the list of saved build names from localStorage
  // so the load panel can show them immediately.
  useEffect(() => {
    const names = getSavedBuildNames(); // Read names from localStorage
    setSavedBuilds(names);             // Populate the saved builds list in state
  }, []); // Empty deps: run once on mount

  // ── ASSEMBLY TIMER EFFECT ─────────────────────────────────────────────────
  // When an assembly starts (assembly state transitions from null → AssemblyInProgress),
  // this effect starts an interval that updates the progress bar at 20 fps.
  // When assembly completes or is cancelled, the interval is cleared.
  useEffect(() => {
    if (!assembly) {
      // No assembly in progress: ensure the timer is stopped and progress is reset
      if (timerRef.current !== null) {
        clearInterval(timerRef.current); // Stop any running timer from a previous assembly
        timerRef.current = null;          // Clear the handle so we don't double-clear later
      }
      setAssemblyProgress(0); // Reset the progress bar to empty
      return;                  // Nothing else to do when there's no assembly
    }

    // Assembly is now in progress: sync to the ref so the interval callback reads fresh data
    assemblyRef.current = assembly; // Keep ref in sync with state for the interval closure

    // Start the interval that updates the progress bar
    timerRef.current = setInterval(() => {
      const currentAssembly = assemblyRef.current; // Read from ref (always current)
      if (!currentAssembly) return;                 // Shouldn't happen, but guard against it

      const elapsed = Date.now() - currentAssembly.startTimeMs; // ms since assembly started
      const progress = Math.min(elapsed / currentAssembly.totalTimeMs, 1); // 0.0 → 1.0 clamped

      // Update which assembly step message to show based on progress quartile:
      // 0-25%: message 0, 25-50%: message 1, 50-75%: message 2, 75-100%: message 3
      const newMessageIndex = Math.min(3, Math.floor(progress * 4));
      if (newMessageIndex !== currentAssembly.messageIndex) {
        // The message has changed: update both the ref and the state
        const updated = { ...currentAssembly, messageIndex: newMessageIndex };
        assemblyRef.current = updated; // Update ref immediately (sync)
        setAssembly(updated);          // Trigger React re-render for the new message
      }

      setAssemblyProgress(progress); // Update the progress bar width

      if (progress >= 1) {
        // Assembly complete! Stop the timer and finalize the installation.
        clearInterval(timerRef.current!); // Stop the interval — we're done
        timerRef.current = null;           // Clear the handle

        // Call the completion handler to add the part to the stage.
        // Guard against null: the ref should always be set here, but TypeScript
        // requires the check because the ref type is AssemblyInProgress | null.
        if (assemblyRef.current) handleAssemblyComplete(assemblyRef.current);
      }
    }, ASSEMBLY_UPDATE_INTERVAL_MS); // Fires every 50ms for smooth 20fps progress

    // Cleanup: when this effect re-runs or the component unmounts, stop the timer
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current); // Prevent timer from firing after unmount
        timerRef.current = null;
      }
    };
  }, [assembly?.part.id, assembly?.stageIndex, assembly?.startTimeMs]);
  // Deps: only re-run when a NEW assembly starts (part.id, stageIndex, or startTime changes)

  // ─── ASSEMBLY LOGIC ──────────────────────────────────────────────────────

  /**
   * Begin assembling a part onto a specific stage.
   * Creates the AssemblyInProgress state which triggers the timer effect above.
   *
   * @param part        The part to install
   * @param stageIndex  Which stage index (0 = bottom) to attach this part to
   */
  const startAssembly = useCallback((part: AnyRocketPart, stageIndex: number) => {
    if (assembly !== null) return; // Already assembling: ignore new click (catalog is greyed out, so shouldn't happen)

    const newAssembly: AssemblyInProgress = {
      part,                              // The part being installed
      stageIndex,                        // Which stage it goes on
      startTimeMs: Date.now(),           // Record start time for elapsed calculation
      totalTimeMs: part.assemblyTimeSeconds * 1000, // Convert seconds to milliseconds
      messageIndex: 0,                   // Start with the first assembly step message
    };

    assemblyRef.current = newAssembly;   // Sync to ref immediately (before React state update)
    setAssembly(newAssembly);            // Trigger timer effect via React state
    setAssemblyProgress(0);             // Start progress bar at 0%
    audioRef.current.playSound("ui-click"); // Auditory feedback: confirm the assembly has started
  }, [assembly]); // Depends on assembly so we can check if one is already running

  /**
   * Cancel an in-progress assembly.
   * Removes the AssemblyInProgress state, which triggers the timer effect to clean up.
   * The part is NOT added to the stage.
   */
  const cancelAssembly = useCallback(() => {
    assemblyRef.current = null;  // Clear ref immediately
    setAssembly(null);           // This triggers the timer effect cleanup (clears interval)
    setAssemblyProgress(0);      // Reset progress bar to empty
    audioRef.current.playSound("ui-click"); // Click sound confirms the cancellation
  }, []);

  /**
   * Called when the assembly timer reaches 100%.
   * Adds the completed part to the target stage and plays a success sound.
   *
   * @param completed  The assembly that just finished
   */
  const handleAssemblyComplete = useCallback((completed: AssemblyInProgress) => {
    const { part, stageIndex } = completed; // Destructure: what part, which stage

    // Immutably update the stages array by spreading the target stage
    setStages((prevStages) => {
      const newStages = prevStages.map((stage) => {
        if (stage.stageIndex !== stageIndex) return stage; // Other stages: unchanged

        // This is the target stage — add the part to the appropriate slot
        const updatedStage = { ...stage }; // Shallow copy so we don't mutate the previous state

        // Route the part to the correct slot based on its category discriminant
        if (part.category === "engine") {
          // Engine: add to the engines array (there can be 1–9 engines per stage)
          updatedStage.engines = [...stage.engines, part as Engine];
        } else if (part.category === "fuelTank") {
          // Fuel tank: add to the fuelTanks array
          updatedStage.fuelTanks = [...stage.fuelTanks, part as FuelTank];
        } else if (part.category === "rcsThruster") {
          // RCS thruster: add to the rcsThrusters array
          updatedStage.rcsThrusters = [...stage.rcsThrusters, part as RCSThruster];
        } else if (part.category === "fin") {
          // Fins: replaces any existing fin set (only one set allowed per stage)
          updatedStage.fins = part as Fin;
        } else if (part.category === "landingLeg") {
          // Landing legs: replaces any existing leg set (one set per stage)
          updatedStage.landingLegs = part as LandingLeg;
        } else if (part.category === "interstageAdapter") {
          // Interstage: replaces any existing adapter above this stage
          updatedStage.interstageAdapter = part as InterstageAdapter;
        } else if (part.category === "noseCone") {
          // Nose cone: replaces any existing nose cone on this stage
          updatedStage.noseCone = part as NoseCone;
        }

        return updatedStage; // Return the modified copy of this stage
      });

      return newStages; // Return the new stages array
    });

    // Clear the assembly state (timer effect will clean up the interval)
    assemblyRef.current = null; // Clear ref immediately
    setAssembly(null);          // This also resets the progress bar via the timer effect

    // Play a rising tone to celebrate successful assembly
    // "engine-ignition" is a rising, exciting tone that fits the assembly completion moment
    audioRef.current.playSound("engine-ignition");
  }, []); // No deps: uses only setStages (stable) and refs

  // ─── STAGE MANAGEMENT ────────────────────────────────────────────────────

  /**
   * Add a new empty stage above the current topmost stage.
   * Maximum MAX_STAGES stages allowed.
   */
  const addStage = useCallback(() => {
    setStages((prev) => {
      if (prev.length >= MAX_STAGES) return prev; // Already at maximum: ignore
      const newIndex = prev.length;               // New stage is at the top (highest index)
      return [...prev, createEmptyStage(newIndex)]; // Append a new empty stage
    });
    audioRef.current.playSound("ui-select"); // Sound feedback for adding a stage
  }, []);

  /**
   * Remove the topmost stage (highest stageIndex).
   * Cannot remove the last remaining stage.
   */
  const removeTopStage = useCallback(() => {
    setStages((prev) => {
      if (prev.length <= 1) return prev; // Cannot have zero stages
      return prev.slice(0, -1);          // Remove the last element (topmost stage)
    });
    audioRef.current.playSound("ui-click"); // Click sound for stage removal
  }, []);

  /**
   * Remove a specific part from a stage.
   * Used when the user clicks the "×" button on an already-installed part.
   *
   * @param part        The part to remove
   * @param stageIndex  Which stage the part is on
   */
  const removePart = useCallback((part: AnyRocketPart, stageIndex: number) => {
    setStages((prevStages) =>
      prevStages.map((stage) => {
        if (stage.stageIndex !== stageIndex) return stage; // Wrong stage: unchanged

        const updated = { ...stage }; // Shallow copy of the target stage

        // Remove from the correct slot based on category
        if (part.category === "engine") {
          // Filter out THIS specific engine by its id; keep all others
          // findIndex then splice to remove only one instance (in case of duplicate engine type)
          const idx = updated.engines.findIndex((e) => e.id === part.id);
          if (idx !== -1) {
            updated.engines = [...updated.engines]; // Copy array before mutating
            updated.engines.splice(idx, 1);         // Remove one element at idx
          }
        } else if (part.category === "fuelTank") {
          // Remove one tank instance by id
          const idx = updated.fuelTanks.findIndex((t) => t.id === part.id);
          if (idx !== -1) {
            updated.fuelTanks = [...updated.fuelTanks];
            updated.fuelTanks.splice(idx, 1);
          }
        } else if (part.category === "rcsThruster") {
          // Remove one RCS thruster instance by id
          const idx = updated.rcsThrusters.findIndex((r) => r.id === part.id);
          if (idx !== -1) {
            updated.rcsThrusters = [...updated.rcsThrusters];
            updated.rcsThrusters.splice(idx, 1);
          }
        } else if (part.category === "fin") {
          updated.fins = null; // Null out the single fin slot
        } else if (part.category === "landingLeg") {
          updated.landingLegs = null; // Null out the single leg slot
        } else if (part.category === "interstageAdapter") {
          updated.interstageAdapter = null; // Null out the single adapter slot
        } else if (part.category === "noseCone") {
          updated.noseCone = null; // Null out the nose cone slot
        }

        return updated; // Return the modified stage copy
      })
    );
    audioRef.current.playSound("ui-click"); // Confirm removal with click sound
  }, []);

  // ─── VALIDATION & STATS ───────────────────────────────────────────────────

  /**
   * Compute live statistics for the current rocket build.
   * All physics is correct to the precision needed for the UI display.
   * The Δv and altitude are rough estimates (Tsiolkovsky ignores drag).
   *
   * @returns Object with all computed stats; individual fields documented inline
   */
  const computeStats = useCallback(() => {
    // ── TOTAL DRY MASS (all stages, all parts, no propellant) ──────────────
    let totalDryMass = PAYLOAD_MASS_KG; // Start with the payload at the top of the stack
    for (const stage of stages) {
      for (const e of stage.engines) totalDryMass += e.mass;              // Each engine's dry mass
      for (const t of stage.fuelTanks) totalDryMass += t.dryMassKg;       // Tank structural mass (empty)
      for (const r of stage.rcsThrusters) totalDryMass += r.mass;         // RCS thruster mass
      if (stage.fins) totalDryMass += stage.fins.mass;                     // Fin set mass
      if (stage.landingLegs) totalDryMass += stage.landingLegs.mass;       // Landing leg mass
      if (stage.interstageAdapter) totalDryMass += stage.interstageAdapter.mass; // Interstage mass
      if (stage.noseCone) totalDryMass += stage.noseCone.mass;             // Nose cone mass
    }

    // ── TOTAL PROPELLANT MASS (all tanks, full) ─────────────────────────────
    let totalFuelMass = 0;
    for (const stage of stages) {
      for (const t of stage.fuelTanks) totalFuelMass += t.capacityKg; // Sum all tank capacities
    }

    // ── TOTAL LAUNCH MASS ───────────────────────────────────────────────────
    const totalLaunchMass = totalDryMass + totalFuelMass; // kg — full rocket at T-0

    // ── TOTAL SEA-LEVEL THRUST (first active stage) ─────────────────────────
    // TWR is computed using the FIRST STAGE thrust because that's what must
    // exceed gravity × totalMass at launch. Upper stages fire later at lower total mass.
    const firstStageTotalThrust = computeTotalEngineThrust(stages[0]?.engines ?? []);
    // N — sum of all first stage engine sea-level thrusts

    // ── THRUST-TO-WEIGHT RATIO ──────────────────────────────────────────────
    // TWR = Thrust / (TotalMass × g₀)
    // Must be > 1.0 for the rocket to accelerate upward against gravity.
    // Typical values: 1.2–1.8 for orbital launchers; below 1.0 = cannot lift off.
    const twr = totalLaunchMass > 0
      ? firstStageTotalThrust / (totalLaunchMass * GRAVITY_MS2)
      : 0; // Avoid division by zero if no parts are added yet

    // ── MULTI-STAGE Δv CALCULATION (Tsiolkovsky) ────────────────────────────
    // For each stage, compute its Δv contribution:
    //   m₀_stage = total vehicle mass at the START of that stage's burn
    //   m_f_stage = total vehicle mass at the END of that stage's burn (tanks empty)
    //   Δv_stage = Isp_eff × g₀ × ln(m₀_stage / m_f_stage)
    // After each stage burns, its dry mass is jettisoned before the next stage fires.
    let totalDeltaV = 0; // m/s — accumulated Δv across all stages

    // Compute mass remaining ABOVE each stage (payload + upper stages)
    // This is needed to know the total vehicle mass at each staging event.
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]; // Current stage being evaluated

      // Mass of this specific stage's dry structure
      let stageDryMass = 0;
      for (const e of stage.engines) stageDryMass += e.mass;
      for (const t of stage.fuelTanks) stageDryMass += t.dryMassKg;
      for (const r of stage.rcsThrusters) stageDryMass += r.mass;
      if (stage.fins) stageDryMass += stage.fins.mass;
      if (stage.landingLegs) stageDryMass += stage.landingLegs.mass;
      if (stage.interstageAdapter) stageDryMass += stage.interstageAdapter.mass;
      if (stage.noseCone) stageDryMass += stage.noseCone.mass;

      // Fuel mass in THIS stage's tanks
      const stageFuelMass = stage.fuelTanks.reduce((s, t) => s + t.capacityKg, 0);

      if (stageFuelMass === 0) continue; // No fuel: this stage contributes no Δv

      const stageEngines = stage.engines;
      if (stageEngines.length === 0) continue; // No engines: this stage contributes no Δv

      // Mass of all stages ABOVE this one (stages i+1, i+2, ...) plus payload
      let massAbove = PAYLOAD_MASS_KG; // Start with fixed payload mass
      for (let j = i + 1; j < stages.length; j++) {
        const upperStage = stages[j]; // Each upper stage contributes its full mass
        for (const e of upperStage.engines) massAbove += e.mass;
        for (const t of upperStage.fuelTanks) massAbove += t.dryMassKg + t.capacityKg;
        for (const r of upperStage.rcsThrusters) massAbove += r.mass;
        if (upperStage.fins) massAbove += upperStage.fins.mass;
        if (upperStage.landingLegs) massAbove += upperStage.landingLegs.mass;
        if (upperStage.interstageAdapter) massAbove += upperStage.interstageAdapter.mass;
        if (upperStage.noseCone) massAbove += upperStage.noseCone.mass;
      }

      // m₀ = mass of THIS stage (dry + fuel) + all mass above it
      const m0 = stageDryMass + stageFuelMass + massAbove;
      // m_f = mass after THIS stage's fuel is exhausted (dry mass + mass above)
      const mf = stageDryMass + massAbove;

      if (mf <= 0 || m0 <= mf) continue; // Degenerate case: skip (no fuel or no structure)

      const massRatio = m0 / mf;              // m₀/m_f: the "mass ratio" in Tsiolkovsky equation
      const ispEff = computeEffectiveIsp(stageEngines); // Thrust-weighted average Isp
      if (ispEff <= 0) continue; // No valid Isp: skip this stage

      // Tsiolkovsky rocket equation: Δv = Isp × g₀ × ln(m₀/m_f)
      const stageDv = ispEff * GRAVITY_MS2 * Math.log(massRatio);
      totalDeltaV += stageDv; // Add this stage's contribution to total Δv
    }

    // ── ESTIMATED ALTITUDE ────────────────────────────────────────────────
    // Rough estimate using energy: h ≈ Δv² / (2 × g₀)
    // This assumes ALL Δv converts to potential energy in a straight vertical shot.
    // Reality has gravity losses (~1500 m/s) and drag (~200 m/s), so this
    // OVERESTIMATES altitude significantly for large Δv. It's shown as a rough upper bound.
    const estimatedAltitudeM = (totalDeltaV * totalDeltaV) / (2 * GRAVITY_MS2);
    const estimatedAltitudeKm = estimatedAltitudeM / 1000; // Convert to km for display

    return {
      totalLaunchMass,          // kg — rocket + fuel at launch
      totalDryMass,             // kg — rocket structure without propellant
      totalFuelMass,            // kg — all propellant loaded
      firstStageTotalThrust,    // N — first stage total sea-level thrust
      twr,                      // dimensionless — thrust-to-weight at launch
      totalDeltaV,              // m/s — total Δv from Tsiolkovsky equation (multi-stage)
      estimatedAltitudeKm,      // km — rough upper bound estimate
    };
  }, [stages]); // Recompute whenever the stages change

  /**
   * Generate the list of warnings/errors/successes for the current build.
   * Shown in the stats panel. These guide the user toward a flight-ready rocket.
   *
   * @returns  Array of BuildWarning objects, ordered: errors first, then warnings, then successes
   */
  const getWarnings = useCallback((): BuildWarning[] => {
    const warnings: BuildWarning[] = []; // Accumulate warnings here

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]; // Check each stage independently
      const stageLabel = `Stage ${i + 1}`; // Human-readable label (1-based for display)

      // ── RULE: EVERY STAGE MUST HAVE AT LEAST ONE ENGINE ───────────────
      if (stage.engines.length === 0) {
        warnings.push({
          severity: "error", // Error: rocket cannot fly without an engine
          message: `${stageLabel}: No engine attached. Every stage needs at least one engine.`,
        });
      }

      // ── RULE: EVERY STAGE MUST HAVE AT LEAST ONE FUEL TANK ────────────
      if (stage.fuelTanks.length === 0) {
        warnings.push({
          severity: "error", // Error: engine has nothing to burn
          message: `${stageLabel}: No fuel tank attached. Add a tank to feed the engine.`,
        });
      }

      // ── RULE: ENGINE/TANK PROPELLANT COMPATIBILITY ─────────────────────
      if (stage.engines.length > 0 && stage.fuelTanks.length > 0) {
        const enginePropellant = stage.engines[0].propellant; // First engine's propellant (all should match)
        for (const tank of stage.fuelTanks) {
          // Check if the tank's propellant type matches the engine's propellant type
          if (tank.propellantType !== enginePropellant) {
            warnings.push({
              severity: "error",
              message: `${stageLabel}: Fuel mismatch! Engines require ${enginePropellant} but tank contains ${tank.propellantType}.`,
            });
          }
        }

        // ── RULE: ALL ENGINES ON A STAGE SHOULD USE THE SAME PROPELLANT ──
        for (let j = 1; j < stage.engines.length; j++) {
          if (stage.engines[j].propellant !== enginePropellant) {
            warnings.push({
              severity: "warning",
              message: `${stageLabel}: Mixed engine propellants (${stage.engines[0].name} uses ${enginePropellant}, ${stage.engines[j].name} uses ${stage.engines[j].propellant}).`,
            });
          }
        }
      }

      // ── RULE: MAX 9 ENGINES PER STAGE ─────────────────────────────────
      if (stage.engines.length > MAX_ENGINES_PER_STAGE) {
        warnings.push({
          severity: "warning",
          message: `${stageLabel}: ${stage.engines.length} engines exceeds the recommended max of ${MAX_ENGINES_PER_STAGE} (plumbing complexity).`,
        });
      }

      // ── RULE: FINS/LEGS ONLY ON BOTTOM STAGE ─────────────────────────
      if (i > 0 && (stage.fins || stage.landingLegs)) {
        warnings.push({
          severity: "warning",
          message: `${stageLabel}: Fins and landing legs should only be on the first (bottom) stage.`,
        });
      }

      // ── RULE: INTERSTAGE ADAPTER NEEDED BETWEEN STAGES ────────────────
      if (i < stages.length - 1 && !stage.interstageAdapter) {
        warnings.push({
          severity: "warning",
          message: `Between Stage ${i + 1} and Stage ${i + 2}: Missing interstage adapter. Add one to connect the stages structurally.`,
        });
      }
    }

    // ── RULE: NOSE CONE ON TOP STAGE ─────────────────────────────────────
    const topStage = stages[stages.length - 1]; // The topmost stage
    if (!topStage.noseCone) {
      warnings.push({
        severity: "warning",
        message: "No nose cone on top stage! High drag will significantly reduce altitude. Add a nose cone.",
      });
    }

    // ── COMPUTE STATS FOR TWR CHECK ────────────────────────────────────────
    const stats = computeStats(); // Get current stats for TWR evaluation

    // ── RULE: TWR MUST BE > 1.0 TO LIFT OFF ──────────────────────────────
    if (stats.twr > 0 && stats.twr < 1.0) {
      warnings.push({
        severity: "error", // Error: rocket physically cannot lift off
        message: `TWR is ${stats.twr.toFixed(2)} — rocket CANNOT lift off. Need TWR > 1.0. Add more engines or reduce mass.`,
      });
    } else if (stats.twr >= 1.0 && stats.twr < 1.2) {
      warnings.push({
        severity: "warning", // Warning: will barely lift off; slow ascent
        message: `TWR is ${stats.twr.toFixed(2)} — rocket will barely lift off. TWR of 1.3+ recommended for good performance.`,
      });
    }

    // ── SUCCESS: ALL GOOD ─────────────────────────────────────────────────
    const hasErrors = warnings.some((w) => w.severity === "error"); // Check if any errors exist
    const hasWarnings = warnings.some((w) => w.severity === "warning"); // Check if any warnings exist
    if (!hasErrors && !hasWarnings && stats.twr > 1.2 && stages.every((s) => s.engines.length > 0 && s.fuelTanks.length > 0)) {
      warnings.push({
        severity: "success",
        message: `Rocket is flight-ready! TWR: ${stats.twr.toFixed(2)}, Est. Δv: ${fmtNum(Math.round(stats.totalDeltaV))} m/s, Est. Altitude: ${fmtNum(Math.round(stats.estimatedAltitudeKm))} km`,
      });
    }

    return warnings; // Caller will render these in the stats panel
  }, [stages, computeStats]); // Recompute when stages or stats change

  /**
   * Convert the current BuildStage array into a MultiStageRocketConfig that
   * the physics engine can simulate.
   * Returns null if the build is not valid (missing engines or fuel tanks).
   *
   * @returns  Ready-to-fly MultiStageRocketConfig, or null if build is incomplete
   */
  const convertToConfig = useCallback((): MultiStageRocketConfig | null => {
    // Validate that every stage has at least one engine and one tank
    for (const stage of stages) {
      if (stage.engines.length === 0 || stage.fuelTanks.length === 0) {
        return null; // Incomplete build: cannot simulate
      }
    }

    // Also check propellant compatibility — refuse to launch with a type mismatch
    for (const stage of stages) {
      if (stage.engines.length > 0 && stage.fuelTanks.length > 0) {
        const engineProp = stage.engines[0].propellant; // First engine's propellant requirement
        for (const tank of stage.fuelTanks) {
          if (tank.propellantType !== engineProp) return null; // Mismatch: cannot launch
        }
      }
    }

    // Build the MultiStageRocketConfig stages array
    const configStages = stages.map((buildStage, i) => {
      // ── DRY MASS (everything except propellant) ──
      let dryMass = 0;
      for (const e of buildStage.engines) dryMass += e.mass;              // Engine dry masses
      for (const t of buildStage.fuelTanks) dryMass += t.dryMassKg;       // Empty tank structures
      for (const r of buildStage.rcsThrusters) dryMass += r.mass;         // RCS thrusters
      if (buildStage.fins) dryMass += buildStage.fins.mass;               // Fin set
      if (buildStage.landingLegs) dryMass += buildStage.landingLegs.mass; // Landing legs
      if (buildStage.interstageAdapter) dryMass += buildStage.interstageAdapter.mass; // Interstage adapter
      if (buildStage.noseCone) dryMass += buildStage.noseCone.mass;       // Nose cone
      dryMass = Math.max(dryMass, 1); // Minimum 1 kg dry mass to prevent division-by-zero

      // ── FUEL CAPACITY (sum of all tank capacities) ──────────────────────
      const fuelCapacity = buildStage.fuelTanks.reduce((s, t) => s + t.capacityKg, 0);

      // ── COMBINED THRUST (all engines, sea-level) ────────────────────────
      const engineThrust = computeTotalEngineThrust(buildStage.engines);

      // ── EFFECTIVE SPECIFIC IMPULSE (thrust-weighted average) ────────────
      const specificImpulse = computeEffectiveIsp(buildStage.engines);

      // ── CREATE THE STAGE via the factory function ────────────────────────
      // createRocketStage auto-calculates burnRate from thrust and Isp
      return createRocketStage({
        stageNumber: i,                          // 0 = first to fire, matching physics engine convention
        name: `Stage ${i + 1}`,                 // Human-readable name for telemetry display
        dryMass,                                  // kg — structural mass without propellant
        fuelCapacity: Math.max(fuelCapacity, 1), // kg — propellant load (min 1 to avoid zero burn time)
        engineThrust: Math.max(engineThrust, 1), // N — total thrust (min 1 to avoid zero TWR)
        specificImpulse: Math.max(specificImpulse, 1), // s — effective Isp (min 1 to avoid zero burnRate)
      });
    });

    // Build the complete config with the custom rocket name and a small payload
    return {
      name: "Custom Build",  // Name shown in the simulator HUD
      stages: configStages,  // All assembled stages, bottom-to-top
      payloadMass: PAYLOAD_MASS_KG, // 500 kg generic payload (satellite)
    };
  }, [stages]); // Recompute when stages change

  // ─── SAVE / LOAD ─────────────────────────────────────────────────────────

  /**
   * Return the list of saved build names from localStorage.
   * These are displayed in the load panel for selection.
   *
   * @returns  Array of user-given rocket names (may be empty if nothing saved)
   */
  const getSavedBuildNames = (): string[] => {
    try {
      const raw = localStorage.getItem(LOCALSTORAGE_KEY); // Read the JSON string from localStorage
      if (!raw) return []; // Nothing saved yet: return empty array
      const saves: SavedBuild[] = JSON.parse(raw); // Parse the JSON array of saved builds
      return saves.map((s) => s.name); // Return only the names for the dropdown list
    } catch {
      return []; // JSON parse error or localStorage unavailable: return empty array
    }
  };

  /**
   * Save the current build under the given name to localStorage.
   * Overwrites any existing save with the same name.
   *
   * @param name  User-given name for this rocket configuration
   */
  const saveBuild = useCallback((name: string) => {
    if (!name.trim()) return; // Empty name: don't save (would create an unnamed entry)

    try {
      // Build the save data object with part IDs (not full part objects)
      const saveData: SavedBuild = {
        name: name.trim(),                    // Trimmed name removes accidental leading/trailing spaces
        savedAt: new Date().toISOString(),    // ISO timestamp for display in load list
        stageCount: stages.length,            // Quick summary for the load list
        stages: stages.map((stage) => ({
          engineIds: stage.engines.map((e) => e.id),           // Save only IDs, not full part objects
          tankIds: stage.fuelTanks.map((t) => t.id),
          rcsThrusterIds: stage.rcsThrusters.map((r) => r.id),
          finId: stage.fins?.id ?? null,
          landingLegId: stage.landingLegs?.id ?? null,
          interstageAdapterId: stage.interstageAdapter?.id ?? null,
          noseConeId: stage.noseCone?.id ?? null,
        })),
      };

      // Load existing saves so we can merge (not overwrite the entire localStorage key)
      const raw = localStorage.getItem(LOCALSTORAGE_KEY);
      const existing: SavedBuild[] = raw ? JSON.parse(raw) : []; // Parse or empty array

      // Remove any existing save with the same name (overwrite behavior)
      const filtered = existing.filter((s) => s.name !== name.trim());
      filtered.push(saveData); // Add the new save at the end

      localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(filtered)); // Persist to localStorage
      setSavedBuilds(getSavedBuildNames()); // Refresh the displayed list
      setSaveNameInput(""); // Clear the save name input field
      audioRef.current.playSound("ui-select"); // Confirm save with a pleasant sound
    } catch {
      // localStorage unavailable (private browsing, quota exceeded): silently ignore
    }
  }, [stages]);

  /**
   * Load a previously saved build by name.
   * Replaces the current stages array with the saved configuration.
   *
   * @param name  The saved build name to load
   */
  const loadBuild = useCallback((name: string) => {
    try {
      const raw = localStorage.getItem(LOCALSTORAGE_KEY); // Read all saves
      if (!raw) return; // No saves: nothing to load

      const saves: SavedBuild[] = JSON.parse(raw); // Parse the saves array
      const save = saves.find((s) => s.name === name); // Find the matching save
      if (!save) return; // Name not found: ignore

      // Reconstruct BuildStage array from saved part IDs
      const loadedStages: BuildStage[] = save.stages.map((stageSave, i) => {
        const engines: Engine[] = stageSave.engineIds
          .map((id) => findPartById(id)) // Look up full part object by ID
          .filter((p): p is Engine => p?.category === "engine"); // Type guard: keep only engines

        const fuelTanks: FuelTank[] = stageSave.tankIds
          .map((id) => findPartById(id))
          .filter((p): p is FuelTank => p?.category === "fuelTank");

        const rcsThrusters: RCSThruster[] = stageSave.rcsThrusterIds
          .map((id) => findPartById(id))
          .filter((p): p is RCSThruster => p?.category === "rcsThruster");

        const finPart = stageSave.finId ? findPartById(stageSave.finId) : null; // Optional
        const legPart = stageSave.landingLegId ? findPartById(stageSave.landingLegId) : null;
        const adapterPart = stageSave.interstageAdapterId ? findPartById(stageSave.interstageAdapterId) : null;
        const noseCone = stageSave.noseConeId ? findPartById(stageSave.noseConeId) : null;

        return {
          stageIndex: i,                                                            // Re-index stages in case order changed
          engines,                                                                   // Loaded engine array
          fuelTanks,                                                                 // Loaded tank array
          rcsThrusters,                                                             // Loaded RCS array
          fins: (finPart?.category === "fin" ? finPart as Fin : null),             // Type-safe cast
          landingLegs: (legPart?.category === "landingLeg" ? legPart as LandingLeg : null),
          interstageAdapter: (adapterPart?.category === "interstageAdapter" ? adapterPart as InterstageAdapter : null),
          noseCone: (noseCone?.category === "noseCone" ? noseCone as NoseCone : null),
        };
      });

      setStages(loadedStages);             // Replace current build with loaded stages
      cancelAssembly();                    // Cancel any in-progress assembly
      audioRef.current.playSound("ui-select"); // Confirm load with pleasant sound
    } catch {
      // Parse error or missing part (catalog changed): silently ignore
    }
  }, [cancelAssembly]);

  /**
   * Handle the LAUNCH button click.
   * Converts the current build to a MultiStageRocketConfig and passes it to the parent.
   */
  const handleLaunch = useCallback(() => {
    const config = convertToConfig(); // Try to convert build to config
    if (!config) return; // Invalid build: button should be disabled, but guard anyway
    audioRef.current.playSound("engine-ignition"); // Launch ignition sound
    onLaunch(config); // Pass config to App.tsx which will switch to FLY mode
  }, [convertToConfig, onLaunch]);

  // ─── CATALOG HELPERS ─────────────────────────────────────────────────────

  /**
   * Check if a part can currently be added to the target stage.
   * Returns false with a reason if placement is invalid (used to grey out parts).
   *
   * @param part         The part to check
   * @param stageIndex   The target stage
   * @returns            { allowed: boolean, reason: string }
   */
  const checkPartAllowed = useCallback((part: AnyRocketPart, stageIndex: number): { allowed: boolean; reason: string } => {
    const stage = stages[stageIndex]; // The target stage
    if (!stage) return { allowed: false, reason: "Invalid stage" }; // Out-of-bounds index

    const topStageIndex = stages.length - 1; // The topmost stage index

    if (part.category === "engine") {
      // Engines can go on any stage; limit is MAX_ENGINES_PER_STAGE
      if (stage.engines.length >= MAX_ENGINES_PER_STAGE) {
        return { allowed: false, reason: `Max ${MAX_ENGINES_PER_STAGE} engines per stage` };
      }
      return { allowed: true, reason: "" }; // All other engine checks: allowed
    }

    if (part.category === "fuelTank") {
      // Fuel tanks can go on any stage; check propellant compatibility if engines exist
      if (stage.engines.length > 0) {
        const engineProp = stage.engines[0].propellant; // First engine's propellant
        const tank = part as FuelTank;
        if (tank.propellantType !== engineProp) {
          return { allowed: true, reason: `Propellant mismatch: ${tank.propellantType} vs engine needs ${engineProp}` };
          // We allow it but warn — user might want to see the mismatch rather than be blocked
        }
      }
      return { allowed: true, reason: "" };
    }

    if (part.category === "noseCone") {
      // Nose cone can ONLY go on the top stage
      if (stageIndex !== topStageIndex) {
        return { allowed: false, reason: "Nose cone must go on the topmost stage only" };
      }
      if (stage.noseCone) {
        return { allowed: true, reason: "Replaces existing nose cone" }; // Allow replacement
      }
      return { allowed: true, reason: "" };
    }

    if (part.category === "fin") {
      // Fins can ONLY go on the bottom stage (stageIndex 0)
      if (stageIndex !== 0) {
        return { allowed: false, reason: "Fins attach to the bottom stage only (aerodynamic stability)" };
      }
      return { allowed: true, reason: "" };
    }

    if (part.category === "landingLeg") {
      // Landing legs can ONLY go on the bottom stage (stageIndex 0)
      if (stageIndex !== 0) {
        return { allowed: false, reason: "Landing legs attach to the bottom stage only" };
      }
      return { allowed: true, reason: "" };
    }

    if (part.category === "interstageAdapter") {
      // Interstage adapter connects this stage to the one ABOVE; needs an upper stage to connect to
      if (stageIndex >= stages.length - 1) {
        return { allowed: false, reason: "Interstage adapter requires a stage above this one to connect to" };
      }
      return { allowed: true, reason: "" };
    }

    if (part.category === "rcsThruster") {
      // RCS thrusters can go on any stage; no limit defined
      return { allowed: true, reason: "" };
    }

    return { allowed: true, reason: "" }; // Unknown category: allow by default
  }, [stages]);

  // ─── COMPUTED DATA (memoized to avoid recalculating every render) ─────────
  const stats = computeStats();          // Current rocket statistics
  const warnings = getWarnings();        // Current list of warnings
  const canLaunch = !warnings.some((w) => w.severity === "error") && stages.every((s) => s.engines.length > 0 && s.fuelTanks.length > 0);
  // canLaunch: true only when there are no errors AND every stage has engine + fuel

  // ─── SHARED STYLES ────────────────────────────────────────────────────────

  // Root container: full viewport height, dark background, 3-column flex layout
  const containerStyle: React.CSSProperties = {
    display: "flex",           // Horizontal flex: catalog | rocket | stats
    flexDirection: "row",
    height: "100vh",           // Full viewport height
    width: "100vw",            // Full viewport width
    backgroundColor: "#03050f", // Very dark background matching the space simulator theme
    color: COLORS.text,        // Light text on dark background
    fontFamily: "monospace",   // Consistent monospace font across the simulator
    overflow: "hidden",        // Prevent any scroll bars on the root container
  };

  // Shared panel base style (left, center, right columns all share this base)
  const panelBase: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",         // Each panel scrolls independently
    borderRight: "1px solid rgba(74,111,165,0.3)", // Subtle column dividers
  };

  // Header bar shared across all three panels
  const panelHeader: React.CSSProperties = {
    backgroundColor: "rgba(5, 8, 25, 0.95)", // Dark header band
    borderBottom: "1px solid rgba(74,111,165,0.5)", // Accent-colored border
    padding: "10px 12px",
    flexShrink: 0,              // Header never shrinks; only the content area scrolls
    fontSize: "13px",
    fontWeight: "bold",
    color: COLORS.trajectory,   // Bright accent color for panel headers
  };

  // Tab button style factory: returns highlighted style when this tab is active
  const tabBtn = (isActive: boolean): React.CSSProperties => ({
    padding: "4px 8px",
    backgroundColor: isActive ? COLORS.ui : "rgba(15, 25, 50, 0.9)", // Highlight active tab
    color: isActive ? "#fff" : COLORS.text,
    border: `1px solid ${isActive ? COLORS.ui : "rgba(74,111,165,0.3)"}`,
    borderRadius: "3px",
    cursor: "pointer",
    fontSize: "11px",
    fontFamily: "monospace",
    flexShrink: 0,
  });

  // ─── CATALOG TAB LABELS ────────────────────────────────────────────────────
  // Human-readable labels for each catalog category tab
  const TAB_LABELS: Record<string, string> = {
    engine: "Engines",
    fuelTank: "Tanks",
    noseCone: "Nose",
    rcsThruster: "RCS",
    fin: "Fins",
    interstageAdapter: "Interstage",
    landingLeg: "Legs",
  };

  // Which catalog items to show for the active tab
  const catalogItemsForTab: AnyRocketPart[] =
    activeTab === "engine" ? ENGINES
    : activeTab === "fuelTank" ? FUEL_TANKS
    : activeTab === "noseCone" ? NOSE_CONES
    : activeTab === "rcsThruster" ? RCS_THRUSTERS
    : activeTab === "fin" ? FINS
    : activeTab === "interstageAdapter" ? INTERSTAGE_ADAPTERS
    : activeTab === "landingLeg" ? LANDING_LEGS
    : [];

  // Current assembly step message to display (cycles through 4 messages during assembly)
  const assemblyMessage = assembly
    ? ASSEMBLY_MESSAGES[assembly.part.category][assembly.messageIndex]
    : "";

  // ─── RENDER HELPERS ───────────────────────────────────────────────────────

  /**
   * Render a single part tile in the catalog.
   * Shows: name, key spec, assembly time, and a click handler.
   *
   * @param part  The part to render
   * @returns     A clickable div tile
   */
  const renderCatalogTile = (part: AnyRocketPart) => {
    const { allowed, reason } = checkPartAllowed(part, targetStageIndex); // Check if this part can be added
    const isAssembling = assembly !== null; // Cannot add parts while assembly is in progress

    // Build the key spec line (most relevant data for this part type)
    let keySpec = "";
    if (part.category === "engine") {
      const e = part as Engine;
      keySpec = `${fmtThrust(e.thrustSeaLevel)} · Isp ${e.specificImpulseSeaLevel}s · ${fmtMass(e.mass)}`;
    } else if (part.category === "fuelTank") {
      const t = part as FuelTank;
      keySpec = `${fmtMass(t.capacityKg)} propellant · ${t.propellantType}`;
    } else if (part.category === "noseCone") {
      const n = part as NoseCone;
      keySpec = `${fmtMass(n.mass)} · Cd -${n.dragCoefficientReduction.toFixed(2)} · ${fmtMass(n.payloadCapacityKg)} cap`;
    } else if (part.category === "rcsThruster") {
      const r = part as RCSThruster;
      keySpec = `${fmtThrust(r.thrustN)} · Isp ${r.specificImpulseS}s`;
    } else if (part.category === "fin") {
      const f = part as Fin;
      keySpec = `${fmtMass(f.mass)} · ${f.controllable ? "Active" : "Passive"}`;
    } else if (part.category === "interstageAdapter") {
      const a = part as InterstageAdapter;
      keySpec = `${a.topDiameterM}m→${a.bottomDiameterM}m · ${fmtMass(a.mass)}`;
    } else if (part.category === "landingLeg") {
      const l = part as LandingLeg;
      keySpec = `${fmtMass(l.mass)} · ${(l.shockAbsorptionJ / 1000).toFixed(0)} kJ absorb · ${l.deployable ? "Deployable" : "Fixed"}`;
    }

    const isDisabled = isAssembling || !allowed; // Grey out if assembling or placement invalid

    // isCurrentlyAssembling: true if THIS specific part is the one currently being installed.
    // Used to pass the assemblyProgress to HologramViewer for the spinning-brighter animation.
    const isCurrentlyAssembling = assembly?.part.id === part.id && assembly?.stageIndex === targetStageIndex;

    return (
      <div
        key={part.id} // Unique key for React list reconciliation
        title={reason || part.description} // Tooltip: show placement rule violation or description
        style={{
          padding: "8px 10px",
          marginBottom: "4px",
          backgroundColor: isDisabled ? "rgba(10,12,25,0.5)" : "rgba(15,25,55,0.8)", // Grey if disabled
          border: `1px solid ${isDisabled ? "rgba(74,111,165,0.2)" : "rgba(74,111,165,0.5)"}`,
          borderRadius: "4px",
          opacity: isDisabled ? 0.5 : 1,       // Dim disabled tiles
          transition: "background-color 0.15s", // Smooth hover transition
          display: "flex",                       // Row layout: hologram on left, text on right
          gap: "10px",                           // Space between hologram and text
          alignItems: "flex-start",              // Align hologram to the top of the tile
        }}
        onMouseEnter={(e) => { // Highlight on hover when enabled
          if (!isDisabled) (e.currentTarget as HTMLDivElement).style.backgroundColor = "rgba(20,40,90,0.9)";
        }}
        onMouseLeave={(e) => { // Restore when mouse leaves
          if (!isDisabled) (e.currentTarget as HTMLDivElement).style.backgroundColor = "rgba(15,25,55,0.8)";
        }}
      >
        {/* ── HOLOGRAM THUMBNAIL ─────────────────────────────────────────────
             The HologramViewer renders a self-contained 100×100 canvas with a rotating
             3D wireframe of this part. Clicking the hologram opens the 300×300 modal.
             We stop click propagation on the hologram wrapper so clicking the hologram
             does NOT also trigger the tile's assembly — only clicking the text area does. */}
        <div
          onClick={(e) => e.stopPropagation()} // Clicking the hologram opens the 3D modal, not assembly
          style={{ flexShrink: 0 }}             // Hologram never shrinks even if catalog is narrow
        >
          <HologramViewer
            partId={part.id}                            // Shape looked up from PART_SHAPES by this ID
            isAssembling={isCurrentlyAssembling}        // Spin faster and glow during assembly
            assemblyProgress={isCurrentlyAssembling ? assemblyProgress : 0} // Glow intensity 0–1
          />
        </div>

        {/* ── PART TEXT INFO ────────────────────────────────────────────────
             Clicking this area starts assembly. The hologram click is handled separately above. */}
        <div
          style={{ flex: 1, cursor: isDisabled ? "not-allowed" : "pointer", minWidth: 0 }}
          onClick={() => { // Click handler on text area: start assembly if allowed
            if (isDisabled) return; // Ignore clicks when disabled
            startAssembly(part, targetStageIndex); // Begin the real-time assembly countdown
          }}
        >
          {/* Part name line */}
          <div style={{ fontWeight: "bold", fontSize: "12px", color: COLORS.text, marginBottom: "2px" }}>
            {part.name}
          </div>
          {/* Key specifications line */}
          <div style={{ fontSize: "10px", color: "#8899bb", marginBottom: "2px" }}>
            {keySpec}
          </div>
          {/* Assembly time badge */}
          <div style={{ fontSize: "10px", color: "#667799" }}>
            {part.manufacturer} · {part.assemblyTimeSeconds}s install
          </div>
          {/* Warning tag if placement requires attention */}
          {reason && (
            <div style={{ fontSize: "10px", color: "#cc9900", marginTop: "2px" }}>
              ⚠ {reason}
            </div>
          )}
        </div>
      </div>
    );
  };

  /**
   * Render one stage's part list in the center assembly view.
   * Shows all installed parts as labelled colored blocks stacked vertically.
   * The rocket is rendered from BOTTOM to TOP matching physical reality.
   *
   * @param stage   The BuildStage to render
   * @param isTop   True if this is the topmost stage (where nose cone goes)
   */
  const renderStageVisual = (stage: BuildStage, isTop: boolean) => {
    const isTarget = stage.stageIndex === targetStageIndex; // Highlight the currently-targeted stage

    return (
      <div
        key={stage.stageIndex}
        onClick={() => setTargetStageIndex(stage.stageIndex)} // Click stage to select it as target
        style={{
          border: `2px solid ${isTarget ? COLORS.trajectory : "rgba(74,111,165,0.3)"}`, // Bright border when selected
          borderRadius: "4px",
          padding: "6px",
          marginBottom: "4px",
          backgroundColor: isTarget ? "rgba(20,40,90,0.4)" : "rgba(10,15,30,0.4)", // Subtle highlight
          cursor: "pointer",
          fontSize: "11px",
        }}
      >
        {/* Stage header row: label + remove button */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <span style={{ color: COLORS.trajectory, fontWeight: "bold" }}>
            {isTarget ? "▶ " : "  "}Stage {stage.stageIndex + 1} {isTarget ? "(active)" : ""}
          </span>
          {/* Only show the nose cone indicator on the top stage */}
          {isTop && <span style={{ color: "#8899bb", fontSize: "10px" }}>← nose cone here</span>}
        </div>

        {/* ── NOSE CONE (top stage only) ── */}
        {isTop && stage.noseCone && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(80,60,20,0.3)", borderRadius: "3px", padding: "3px 6px", marginBottom: "3px" }}>
            {/* Small hologram icon next to the nose cone name in the assembly stack */}
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ transform: "scale(0.35)", transformOrigin: "left center", width: 35, height: 35, overflow: "hidden", flexShrink: 0 }}
                onClick={(e) => e.stopPropagation()}>
                {/* Scale-down wrapper: renders a 100×100 hologram shrunk to 35×35px via CSS transform */}
                <HologramViewer partId={stage.noseCone.id} />
              </div>
              <span style={{ color: "#ddcc88" }}>▲ {stage.noseCone.name}</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); removePart(stage.noseCone!, stage.stageIndex); }}
              style={{ background: "none", border: "none", color: "#cc4444", cursor: "pointer", fontSize: "12px", padding: "0 2px" }}
            >×</button>
          </div>
        )}

        {/* ── RCS THRUSTERS ── */}
        {stage.rcsThrusters.map((r, idx) => (
          <div key={idx} style={{ display: "flex", justifyContent: "space-between", backgroundColor: "rgba(20,60,80,0.3)", borderRadius: "3px", padding: "3px 6px", marginBottom: "2px" }}>
            <span style={{ color: "#88ccdd" }}>⊕ {r.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); removePart(r, stage.stageIndex); }}
              style={{ background: "none", border: "none", color: "#cc4444", cursor: "pointer", fontSize: "12px", padding: "0 2px" }}
            >×</button>
          </div>
        ))}

        {/* ── FUEL TANKS ── */}
        {stage.fuelTanks.map((t, idx) => (
          <div key={idx} style={{ display: "flex", justifyContent: "space-between", backgroundColor: "rgba(20,50,80,0.4)", borderRadius: "3px", padding: "4px 6px", marginBottom: "2px", minHeight: "24px" }}>
            <span style={{ color: "#88aadd" }}>◻ {t.name} ({fmtMass(t.capacityKg)})</span>
            <button
              onClick={(e) => { e.stopPropagation(); removePart(t, stage.stageIndex); }}
              style={{ background: "none", border: "none", color: "#cc4444", cursor: "pointer", fontSize: "12px", padding: "0 2px" }}
            >×</button>
          </div>
        ))}
        {stage.fuelTanks.length === 0 && (
          <div style={{ color: "#664444", fontSize: "10px", padding: "3px 6px", marginBottom: "2px" }}>
            [No fuel tank — required]
          </div>
        )}

        {/* ── ENGINES ── */}
        {stage.engines.map((e, idx) => (
          <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(60,25,15,0.5)", borderRadius: "3px", padding: "3px 6px", marginBottom: "2px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {/* Tiny hologram icon for each engine in the assembly stack */}
              <div style={{ transform: "scale(0.35)", transformOrigin: "left center", width: 35, height: 35, overflow: "hidden", flexShrink: 0 }}
                onClick={(ev) => ev.stopPropagation()}>
                <HologramViewer partId={e.id} />
              </div>
              <span style={{ color: "#ffaa66" }}>🔥 {e.name} ({fmtThrust(e.thrustSeaLevel)})</span>
            </div>
            <button
              onClick={(ev) => { ev.stopPropagation(); removePart(e, stage.stageIndex); }}
              style={{ background: "none", border: "none", color: "#cc4444", cursor: "pointer", fontSize: "12px", padding: "0 2px" }}
            >×</button>
          </div>
        ))}
        {stage.engines.length === 0 && (
          <div style={{ color: "#664444", fontSize: "10px", padding: "3px 6px", marginBottom: "2px" }}>
            [No engine — required]
          </div>
        )}

        {/* ── FINS (bottom stage only) ── */}
        {stage.stageIndex === 0 && stage.fins && (
          <div style={{ display: "flex", justifyContent: "space-between", backgroundColor: "rgba(30,50,20,0.4)", borderRadius: "3px", padding: "3px 6px", marginBottom: "2px" }}>
            <span style={{ color: "#88cc88" }}>↔ {stage.fins.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); removePart(stage.fins!, stage.stageIndex); }}
              style={{ background: "none", border: "none", color: "#cc4444", cursor: "pointer", fontSize: "12px", padding: "0 2px" }}
            >×</button>
          </div>
        )}

        {/* ── LANDING LEGS (bottom stage only) ── */}
        {stage.stageIndex === 0 && stage.landingLegs && (
          <div style={{ display: "flex", justifyContent: "space-between", backgroundColor: "rgba(30,40,60,0.4)", borderRadius: "3px", padding: "3px 6px", marginBottom: "2px" }}>
            <span style={{ color: "#aabb99" }}>⫠ {stage.landingLegs.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); removePart(stage.landingLegs!, stage.stageIndex); }}
              style={{ background: "none", border: "none", color: "#cc4444", cursor: "pointer", fontSize: "12px", padding: "0 2px" }}
            >×</button>
          </div>
        )}

        {/* ── INTERSTAGE ADAPTER (between stages) ── */}
        {stage.interstageAdapter && (
          <div style={{ display: "flex", justifyContent: "space-between", backgroundColor: "rgba(40,30,60,0.4)", borderRadius: "3px", padding: "3px 6px", marginBottom: "2px" }}>
            <span style={{ color: "#aa99cc" }}>↕ {stage.interstageAdapter.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); removePart(stage.interstageAdapter!, stage.stageIndex); }}
              style={{ background: "none", border: "none", color: "#cc4444", cursor: "pointer", fontSize: "12px", padding: "0 2px" }}
            >×</button>
          </div>
        )}
      </div>
    );
  };

  // ─── MAIN RENDER ─────────────────────────────────────────────────────────
  return (
    <div style={containerStyle}>

      {/* ═══════════════════════════════════════════════════════════════
           LEFT PANEL — PARTS CATALOG (40% width)
          ═══════════════════════════════════════════════════════════════ */}
      <div style={{ ...panelBase, width: "40%" }}>

        {/* Left panel header with mode switch button */}
        <div style={{ ...panelHeader, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>PARTS CATALOG</span>
          <button
            onClick={onSwitchToFlyMode} // Go back to the flight simulator view
            style={{
              padding: "3px 8px",
              backgroundColor: "rgba(15,25,50,0.9)",
              color: COLORS.text,
              border: `1px solid rgba(74,111,165,0.5)`,
              borderRadius: "3px",
              cursor: "pointer",
              fontSize: "11px",
              fontFamily: "monospace",
            }}
          >
            ← Back to FLY
          </button>
        </div>

        {/* Target stage selector: tells the catalog which stage to add parts to */}
        <div style={{ padding: "8px 12px", backgroundColor: "rgba(5,8,20,0.8)", borderBottom: "1px solid rgba(74,111,165,0.2)", flexShrink: 0 }}>
          <span style={{ fontSize: "11px", color: "#8899bb" }}>Adding to: </span>
          {stages.map((s) => (
            <button
              key={s.stageIndex}
              onClick={() => setTargetStageIndex(s.stageIndex)} // Switch target stage
              style={tabBtn(targetStageIndex === s.stageIndex)}
            >
              Stage {s.stageIndex + 1}
            </button>
          ))}
          <span style={{ margin: "0 4px" }} />
          {/* Add/remove stage buttons */}
          {stages.length < MAX_STAGES && (
            <button onClick={addStage} style={{ ...tabBtn(false), color: "#88cc88" }}>+ Stage</button>
          )}
          {stages.length > 1 && (
            <button onClick={removeTopStage} style={{ ...tabBtn(false), color: "#cc8888", marginLeft: "4px" }}>− Stage</button>
          )}
        </div>

        {/* Category tabs: Engines, Tanks, Nose, RCS, Fins, Interstage, Legs */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "3px", padding: "6px 8px", flexShrink: 0, borderBottom: "1px solid rgba(74,111,165,0.2)" }}>
          {(Object.keys(TAB_LABELS) as CatalogTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)} // Switch catalog category tab
              style={tabBtn(activeTab === tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        {/* Scrollable catalog tiles */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
          {catalogItemsForTab.map((part) => renderCatalogTile(part))}
        </div>

        {/* Assembly progress area — shown at the bottom of the catalog panel when assembling */}
        {assembly && (
          <div style={{
            flexShrink: 0,
            padding: "10px 12px",
            backgroundColor: "rgba(5, 8, 25, 0.95)",
            borderTop: `1px solid ${COLORS.ui}`,
          }}>
            {/* Assembly title */}
            <div style={{ fontWeight: "bold", fontSize: "12px", color: COLORS.trajectory, marginBottom: "4px" }}>
              Installing: {assembly.part.name}
            </div>
            {/* Rotating status message */}
            <div style={{ fontSize: "11px", color: "#8899bb", marginBottom: "6px", minHeight: "14px" }}>
              {assemblyMessage}
            </div>
            {/* Progress bar container */}
            <div style={{
              height: "10px",
              backgroundColor: "rgba(20,30,60,0.8)",
              borderRadius: "5px",
              overflow: "hidden",
              border: "1px solid rgba(74,111,165,0.3)",
              marginBottom: "6px",
            }}>
              {/* Progress fill: width driven by assemblyProgress (0–1) */}
              <div style={{
                height: "100%",
                width: `${assemblyProgress * 100}%`, // Convert 0-1 progress to percentage width
                backgroundColor: COLORS.ui,           // Accent color for the filled portion
                borderRadius: "5px",
                transition: "none",                   // No CSS transition: JS updates it at 20fps
              }} />
            </div>
            {/* Time remaining display and cancel button */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "11px", color: "#667799" }}>
                {Math.ceil((1 - assemblyProgress) * assembly.part.assemblyTimeSeconds)}s remaining...
              </span>
              <button
                onClick={cancelAssembly} // Abort assembly: removes in-progress state
                style={{
                  padding: "2px 8px",
                  backgroundColor: "rgba(80,20,20,0.8)",
                  color: "#ff8888",
                  border: "1px solid rgba(180,50,50,0.5)",
                  borderRadius: "3px",
                  cursor: "pointer",
                  fontSize: "11px",
                  fontFamily: "monospace",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════
           CENTER PANEL — ROCKET ASSEMBLY VISUAL (30% width)
          ═══════════════════════════════════════════════════════════════ */}
      <div style={{ ...panelBase, width: "30%", borderRight: "1px solid rgba(74,111,165,0.3)" }}>

        <div style={panelHeader}>
          ROCKET ASSEMBLY — {stages.length} STAGE{stages.length > 1 ? "S" : ""}
        </div>

        {/* Scrollable rocket stack visual: rendered from top to bottom */}
        {/* We reverse stages for display: top stage shown at top of column */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px" }}>

          {/* Arrow label at the top */}
          <div style={{ textAlign: "center", fontSize: "11px", color: "#667799", marginBottom: "8px" }}>
            ↑ UP (orbit direction)
          </div>

          {/* Render stages from TOP to BOTTOM (highest index first visually) */}
          {[...stages].reverse().map((stage) =>
            renderStageVisual(stage, stage.stageIndex === stages.length - 1)
            // isTop = true only for the highest-indexed stage (last stage added)
          )}

          {/* Arrow label at the bottom */}
          <div style={{ textAlign: "center", fontSize: "11px", color: "#667799", marginTop: "8px" }}>
            ↓ GROUND (launch pad)
          </div>
        </div>

        {/* Bottom decoration: launch pad indicator */}
        <div style={{
          flexShrink: 0,
          padding: "6px",
          backgroundColor: "rgba(10,12,20,0.9)",
          borderTop: "1px solid rgba(74,111,165,0.2)",
          textAlign: "center",
          fontSize: "11px",
          color: "#556677",
        }}>
          ≡≡≡≡≡≡≡≡≡≡≡ LAUNCH PAD ≡≡≡≡≡≡≡≡≡≡≡
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════
           RIGHT PANEL — STATS & LAUNCH (30% width)
          ═══════════════════════════════════════════════════════════════ */}
      <div style={{ ...panelBase, width: "30%", borderRight: "none" }}>

        <div style={panelHeader}>ROCKET STATS &amp; VALIDATION</div>

        {/* Scrollable stats content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px" }}>

          {/* ── MASS BREAKDOWN ── */}
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontSize: "11px", color: COLORS.trajectory, marginBottom: "4px", borderBottom: "1px solid rgba(74,111,165,0.3)", paddingBottom: "2px" }}>
              MASS BREAKDOWN
            </div>
            {/* Launch mass: total rocket + full propellant at T-0 */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "2px" }}>
              <span style={{ color: "#8899bb" }}>Launch Mass:</span>
              <span style={{ fontWeight: "bold" }}>{fmtMass(stats.totalLaunchMass)}</span>
            </div>
            {/* Dry mass: rocket without propellant */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "2px" }}>
              <span style={{ color: "#8899bb" }}>Dry Mass:</span>
              <span>{fmtMass(stats.totalDryMass)}</span>
            </div>
            {/* Propellant mass: just the fuel and oxidizer */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "2px" }}>
              <span style={{ color: "#8899bb" }}>Propellant:</span>
              <span>{fmtMass(stats.totalFuelMass)}</span>
            </div>
            {/* Mass ratio: higher is better (more fuel per unit of structure) */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
              <span style={{ color: "#8899bb" }}>Mass Ratio:</span>
              <span style={{ color: stats.totalLaunchMass > 0 && stats.totalDryMass > 0 ? "#88ddaa" : "#8899bb" }}>
                {stats.totalDryMass > 0 ? (stats.totalLaunchMass / stats.totalDryMass).toFixed(2) + ":1" : "—"}
              </span>
            </div>
          </div>

          {/* ── PERFORMANCE ── */}
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontSize: "11px", color: COLORS.trajectory, marginBottom: "4px", borderBottom: "1px solid rgba(74,111,165,0.3)", paddingBottom: "2px" }}>
              PERFORMANCE
            </div>
            {/* Total thrust (first stage, sea level) */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "2px" }}>
              <span style={{ color: "#8899bb" }}>Stage 1 Thrust:</span>
              <span>{fmtThrust(stats.firstStageTotalThrust)}</span>
            </div>
            {/* TWR: highlighted red if < 1, yellow if < 1.3, green if ≥ 1.3 */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "2px" }}>
              <span style={{ color: "#8899bb" }}>TWR (launch):</span>
              <span style={{
                fontWeight: "bold",
                color: stats.twr < 1.0 ? "#ff4444"   // Red: cannot lift off
                     : stats.twr < 1.3 ? "#ffaa00"   // Yellow: marginal
                     : "#44ee88",                     // Green: good
              }}>
                {stats.twr > 0 ? stats.twr.toFixed(2) : "—"}
              </span>
            </div>
            {/* Total Δv from Tsiolkovsky rocket equation (multi-stage) */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "2px" }}>
              <span style={{ color: "#8899bb" }}>Total Δv:</span>
              <span style={{ color: stats.totalDeltaV > 7800 ? "#44ee88" : COLORS.text }}>
                {stats.totalDeltaV > 0 ? fmtNum(Math.round(stats.totalDeltaV)) + " m/s" : "—"}
                {/* Show LEO/GTO labels for context: LEO needs ~9.4 km/s with gravity losses */}
                {stats.totalDeltaV >= 11200 ? " (escape!)" : stats.totalDeltaV >= 9000 ? " (GEO)" : stats.totalDeltaV >= 7800 ? " (LEO)" : ""}
              </span>
            </div>
            {/* Estimated altitude: rough upper bound (Δv²/2g) */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
              <span style={{ color: "#8899bb" }}>Est. Altitude:</span>
              <span>
                {stats.estimatedAltitudeKm > 0
                  ? fmtNum(Math.round(stats.estimatedAltitudeKm)) + " km*"
                  : "—"}
              </span>
            </div>
            {/* Altitude estimate disclaimer */}
            {stats.estimatedAltitudeKm > 0 && (
              <div style={{ fontSize: "9px", color: "#556677", marginTop: "2px" }}>
                * rough upper bound, ignores drag/gravity losses
              </div>
            )}
          </div>

          {/* ── STAGE BREAKDOWN ── */}
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontSize: "11px", color: COLORS.trajectory, marginBottom: "4px", borderBottom: "1px solid rgba(74,111,165,0.3)", paddingBottom: "2px" }}>
              STAGE BREAKDOWN
            </div>
            {stages.map((stage, i) => {
              const stageThrust = computeTotalEngineThrust(stage.engines); // Stage total thrust
              const stageFuel = stage.fuelTanks.reduce((s, t) => s + t.capacityKg, 0); // Stage fuel
              const stageIsp = computeEffectiveIsp(stage.engines); // Effective Isp
              return (
                <div key={i} style={{ marginBottom: "6px", paddingLeft: "8px", borderLeft: "2px solid rgba(74,111,165,0.3)" }}>
                  <div style={{ fontSize: "11px", fontWeight: "bold", color: "#aabbcc", marginBottom: "2px" }}>
                    Stage {i + 1}: {stage.engines.length} engine{stage.engines.length !== 1 ? "s" : ""}, {stage.fuelTanks.length} tank{stage.fuelTanks.length !== 1 ? "s" : ""}
                  </div>
                  <div style={{ fontSize: "10px", color: "#667788" }}>
                    {stageThrust > 0 ? fmtThrust(stageThrust) : "—"} thrust
                    {stageIsp > 0 ? ` · Isp ${Math.round(stageIsp)}s` : ""}
                    {stageFuel > 0 ? ` · ${fmtMass(stageFuel)} fuel` : ""}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── WARNINGS / VALIDATION ── */}
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontSize: "11px", color: COLORS.trajectory, marginBottom: "4px", borderBottom: "1px solid rgba(74,111,165,0.3)", paddingBottom: "2px" }}>
              VALIDATION
            </div>
            {warnings.length === 0 && (
              <div style={{ fontSize: "11px", color: "#667788" }}>Building rocket...</div>
            )}
            {warnings.map((w, i) => (
              <div key={i} style={{
                fontSize: "11px",
                color: w.severity === "error" ? "#ff6666" : w.severity === "warning" ? "#ffcc66" : "#66ee88", // Color by severity
                marginBottom: "4px",
                paddingLeft: "8px",
                borderLeft: `2px solid ${w.severity === "error" ? "#cc3333" : w.severity === "warning" ? "#cc9900" : "#33aa55"}`,
              }}>
                {w.severity === "error" ? "✕" : w.severity === "warning" ? "⚠" : "✓"} {w.message}
              </div>
            ))}
          </div>

          {/* ── COST ESTIMATE ── */}
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontSize: "11px", color: COLORS.trajectory, marginBottom: "4px", borderBottom: "1px solid rgba(74,111,165,0.3)", paddingBottom: "2px" }}>
              EST. COST
            </div>
            <div style={{ fontSize: "12px" }}>
              ${fmtNum(stages.reduce((sum, s) => {
                // Sum costs of all parts on all stages
                let stageCost = 0;
                s.engines.forEach((e) => stageCost += e.cost);
                s.fuelTanks.forEach((t) => stageCost += t.cost);
                s.rcsThrusters.forEach((r) => stageCost += r.cost);
                if (s.fins) stageCost += s.fins.cost;
                if (s.landingLegs) stageCost += s.landingLegs.cost;
                if (s.interstageAdapter) stageCost += s.interstageAdapter.cost;
                if (s.noseCone) stageCost += s.noseCone.cost;
                return sum + stageCost;
              }, 0))}
            </div>
          </div>

          {/* ── SAVE / LOAD SECTION ── */}
          <div style={{ marginBottom: "12px" }}>
            <button
              onClick={() => setShowSavePanel((p) => !p)} // Toggle save/load panel visibility
              style={{
                width: "100%",
                padding: "5px",
                backgroundColor: "rgba(15,25,55,0.8)",
                color: COLORS.text,
                border: `1px solid rgba(74,111,165,0.4)`,
                borderRadius: "3px",
                cursor: "pointer",
                fontSize: "12px",
                fontFamily: "monospace",
                marginBottom: "4px",
              }}
            >
              {showSavePanel ? "▲ Save/Load" : "▼ Save/Load"}
            </button>

            {showSavePanel && (
              <div style={{ padding: "8px", backgroundColor: "rgba(5,8,20,0.8)", border: "1px solid rgba(74,111,165,0.3)", borderRadius: "3px" }}>
                {/* Save input + button */}
                <div style={{ display: "flex", gap: "4px", marginBottom: "8px" }}>
                  <input
                    type="text"
                    value={saveNameInput}
                    onChange={(e) => setSaveNameInput(e.target.value)} // Update save name as user types
                    placeholder="Rocket name..."
                    style={{
                      flex: 1,
                      padding: "4px 6px",
                      backgroundColor: "#0d1a35",
                      color: COLORS.text,
                      border: "1px solid rgba(74,111,165,0.5)",
                      borderRadius: "3px",
                      fontSize: "11px",
                      fontFamily: "monospace",
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter" && saveNameInput.trim()) saveBuild(saveNameInput); }}
                    // Pressing Enter saves without needing to click the button
                  />
                  <button
                    onClick={() => saveBuild(saveNameInput)} // Trigger save
                    disabled={!saveNameInput.trim()} // Disable if no name entered
                    style={{
                      padding: "4px 8px",
                      backgroundColor: saveNameInput.trim() ? "rgba(15,60,20,0.8)" : "rgba(10,15,25,0.8)",
                      color: saveNameInput.trim() ? "#88dd88" : "#445566",
                      border: "1px solid rgba(74,111,165,0.3)",
                      borderRadius: "3px",
                      cursor: saveNameInput.trim() ? "pointer" : "default",
                      fontSize: "11px",
                      fontFamily: "monospace",
                    }}
                  >
                    SAVE
                  </button>
                </div>

                {/* Saved builds list */}
                {savedBuilds.length === 0 && (
                  <div style={{ fontSize: "10px", color: "#445566" }}>No saved rockets yet.</div>
                )}
                {savedBuilds.map((name) => (
                  <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                    <span style={{ fontSize: "11px", color: "#aabbcc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {name}
                    </span>
                    <button
                      onClick={() => loadBuild(name)} // Load this saved rocket
                      style={{
                        padding: "2px 6px",
                        backgroundColor: "rgba(15,25,55,0.9)",
                        color: "#88aacc",
                        border: "1px solid rgba(74,111,165,0.4)",
                        borderRadius: "3px",
                        cursor: "pointer",
                        fontSize: "10px",
                        fontFamily: "monospace",
                        marginLeft: "4px",
                        flexShrink: 0,
                      }}
                    >
                      LOAD
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── LAUNCH BUTTON ── */}
        {/* Sticky at the bottom of the stats panel, always visible */}
        <div style={{
          flexShrink: 0,
          padding: "12px",
          borderTop: `1px solid ${COLORS.ui}`,
          backgroundColor: "rgba(5,8,20,0.95)",
        }}>
          <button
            onClick={handleLaunch}  // Convert build to config and notify parent
            disabled={!canLaunch}  // Disabled if there are validation errors
            style={{
              width: "100%",
              padding: "10px",
              backgroundColor: canLaunch ? "rgba(20,80,20,0.9)" : "rgba(20,20,20,0.5)", // Green when ready, grey when not
              color: canLaunch ? "#88ff88" : "#445566",
              border: `2px solid ${canLaunch ? "#44aa44" : "rgba(74,111,165,0.2)"}`,
              borderRadius: "5px",
              cursor: canLaunch ? "pointer" : "not-allowed",
              fontSize: "16px",
              fontFamily: "monospace",
              fontWeight: "bold",
              letterSpacing: "2px",
              transition: "background-color 0.2s",
            }}
          >
            {canLaunch ? "🚀 LAUNCH" : "⛔ NOT READY"}
          </button>
          {!canLaunch && (
            <div style={{ fontSize: "10px", color: "#664444", marginTop: "4px", textAlign: "center" }}>
              Fix all errors above to enable launch
            </div>
          )}
        </div>
      </div>

    </div>
  );
};
