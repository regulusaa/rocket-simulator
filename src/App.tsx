/**
 * APP ROOT — MODE SWITCHER
 * ========================
 * Top-level component that owns the two application modes:
 *
 *   BUILD mode — shows RocketBuilder (parts catalog, assembly, stats)
 *   FLY mode   — shows RocketSimulator (physics simulation, camera, HUD)
 *
 * STATE FLOW:
 *   1. Default: FLY mode with no custom config (uses simulator's built-in selection)
 *   2. User selects "Build Custom" in the rocket dropdown → App switches to BUILD mode
 *   3. User assembles a rocket and clicks LAUNCH → App passes the config back to FLY mode
 *   4. RocketSimulator receives the config via `initialConfig` prop and simulates it
 *   5. User can return to BUILD mode at any time via the "← Build" button in the HUD
 */

import { useState, useCallback } from "react";
// useState and useCallback are the only hooks needed here; React itself is in scope via the JSX transform

import { RocketSimulator } from "./components/RocketSimulator";
// The flight simulation component: fullscreen canvas with physics, camera, and HUD

import { RocketBuilder } from "./components/RocketBuilder";
// The assembly UI component: three-panel catalog, visual, and stats

import type { MultiStageRocketConfig } from "./physics/MultiStageSystem";
// The physics engine's rocket format: passed from builder to simulator when launching

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * The two top-level modes of the application.
 *
 *   BUILD — user is browsing parts and assembling a custom rocket
 *   FLY   — user is flying a rocket in the physics simulation
 */
type AppMode = "BUILD" | "FLY";

// ─── COMPONENT ────────────────────────────────────────────────────────────────

/**
 * App — the root component mounted in main.tsx.
 * Manages mode state and passes callbacks/configs between builder and simulator.
 */
function App() {

  // ── MODE STATE ──────────────────────────────────────────────────────────────
  // Current application mode: "FLY" by default so the simulator is the first thing
  // the user sees (matches the previous single-mode experience).
  const [mode, setMode] = useState<AppMode>("FLY");

  // ── CUSTOM ROCKET CONFIG ─────────────────────────────────────────────────────
  // When the user launches from RocketBuilder, the assembled config is stored here
  // and passed to RocketSimulator as `initialConfig`.
  // null means "use the simulator's default rocket selection" (Simple Two-Stage).
  //
  // BUG FIX: We initialize from localStorage `rocket_custom_active` if available.
  // Without this, a page refresh clears React state and reverts to the default rocket.
  // The lazy initializer runs once on mount and reads the last-launched custom config.
  // If the stored JSON is invalid or missing, we fall back to null (use default).
  const [customConfig, setCustomConfig] = useState<MultiStageRocketConfig | null>(() => {
    // Lazy initializer: runs once when App first mounts, not on every render.
    // This allows us to perform the localStorage read without a useEffect + re-render.
    try {
      const raw = localStorage.getItem("rocket_custom_active"); // Read the last-launched config
      if (!raw) return null; // No saved config: start with default rocket
      const parsed = JSON.parse(raw) as MultiStageRocketConfig; // Deserialize JSON
      // Validate the parsed object has the minimum required fields (name and stages array).
      // Guards against corrupted localStorage data from old versions or manual edits.
      if (typeof parsed.name !== "string" || !Array.isArray(parsed.stages)) return null;
      return parsed; // Valid config: use it as the initial custom config
    } catch {
      // JSON parse error or localStorage unavailable: fall back to default gracefully.
      return null; // Start with default rocket selection (Simple Two-Stage)
    }
  });

  // ── HANDLER: LAUNCH FROM BUILDER ─────────────────────────────────────────────
  // Called by RocketBuilder when the user clicks the LAUNCH button.
  // Receives the validated MultiStageRocketConfig and switches to FLY mode.
  const handleLaunchFromBuilder = useCallback((config: MultiStageRocketConfig) => {
    setCustomConfig(config);  // Store the config so RocketSimulator receives it as a prop
    setMode("FLY");            // Switch to flight simulation mode
  }, []); // No deps: setCustomConfig and setMode are stable setState functions

  // ── HANDLER: SWITCH TO BUILD MODE ────────────────────────────────────────────
  // Called by RocketSimulator when the user selects "Build Custom" from the dropdown,
  // or by RocketBuilder's "← Back to FLY" button (which calls onSwitchToFlyMode).
  const handleSwitchToBuild = useCallback(() => {
    setMode("BUILD"); // Switch to builder mode; custom config is preserved
  }, []); // No deps: setMode is stable

  // ── HANDLER: SWITCH BACK TO FLY ──────────────────────────────────────────────
  // Called by RocketBuilder when the user clicks "← Back to FLY".
  // Returns to the simulator WITHOUT launching a new rocket (keeps previous state).
  const handleSwitchToFly = useCallback(() => {
    setMode("FLY"); // Return to the simulator; keeps whatever rocket was last flying
  }, []); // No deps: setMode is stable

  // ── RENDER ───────────────────────────────────────────────────────────────────
  // Render only ONE mode at a time to prevent two game loops from running simultaneously.
  // The RocketSimulator starts a requestAnimationFrame loop on mount and cancels it
  // on unmount — by unmounting it when switching to BUILD mode, the loop is properly
  // cancelled, preventing performance issues.
  if (mode === "BUILD") {
    return (
      // RocketBuilder: full-screen assembly UI
      <RocketBuilder
        onLaunch={handleLaunchFromBuilder}  // When user launches, receive the config and switch to FLY
        onSwitchToFlyMode={handleSwitchToFly} // "← Back to FLY" button without launching
      />
    );
  }

  // Default: FLY mode — the physics simulation
  return (
    <RocketSimulator
      initialConfig={customConfig ?? undefined}   // Pass custom config if one was built; otherwise simulator uses its own default
      onSwitchToBuildMode={handleSwitchToBuild}   // Called when user selects "Build Custom" from the dropdown
    />
  );
}

export default App; // Exported as default; mounted in main.tsx via ReactDOM.render
