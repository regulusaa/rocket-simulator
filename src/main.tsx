/**
 * main.tsx — APPLICATION ENTRY POINT
 * ====================================
 * This is the very first file that runs when the browser loads the app.
 * It connects React to the HTML page and kicks off the component tree.
 *
 * HOW REACT APPS START:
 *   A plain HTML page has a <div id="root"></div> in index.html.
 *   React's job is to take over that empty div and fill it with interactive UI.
 *   This file does exactly that — it finds the div and hands it to React.
 *
 * THE RENDER PIPELINE:
 *   1. Browser loads index.html, which contains <div id="root" />.
 *   2. Browser loads this file (main.tsx) as a JavaScript module.
 *   3. createRoot() wraps the #root div in React's fiber reconciler.
 *      The fiber reconciler is React's internal engine that figures out the
 *      minimum DOM changes needed when state updates — it's very fast.
 *   4. .render(<App />) mounts our App component tree into that container.
 *   5. React renders App → RocketSimulator / RocketBuilder → all children.
 *   6. The game loop starts (inside RocketSimulator's useEffect) and the
 *      simulation begins.
 *
 * STRICTMODE EXPLAINED:
 *   <StrictMode> is a development-only wrapper (does nothing in production).
 *   It intentionally double-invokes effects and renders to help you find bugs.
 *   If you see the game loop starting twice — that's StrictMode at work.
 *   It helps catch:
 *     - Side effects in render functions (which should be pure)
 *     - Missing cleanup in useEffect (the double-mount catches uncanelled rAF loops)
 *     - Use of deprecated React APIs
 *   In production builds (npm run build), StrictMode does nothing.
 *
 * TYPESCRIPT ENTRY POINT:
 *   Vite knows this is the entry point because it's listed in index.html:
 *   <script type="module" src="/src/main.tsx">
 *   TypeScript is transpiled to JavaScript by Vite's esbuild transform.
 */

import { StrictMode } from "react";
// StrictMode: development-only wrapper that adds extra runtime checks.
// See explanation above — it's a safety net that catches bugs early.

import { createRoot } from "react-dom/client";
// createRoot: React 18's new root API. The previous API was ReactDOM.render().
// createRoot enables React's concurrent features (Transitions, Suspense, etc.)
// and is faster because it can interrupt renders to handle urgent updates.
// The "client" path distinguishes this from react-dom/server (used for SSR).

import "./index.css";
// Global CSS reset and base styles:
//   * { margin: 0; padding: 0; box-sizing: border-box; }
// This removes default browser spacing so our fullscreen canvas fills
// the viewport exactly without any unexpected margins.
// Also sets the dark background (#0a0e27) and monospace font globally.
// Imported before App so it applies before any component styles render.

import App from "./App.tsx";
// The root component — manages BUILD mode vs FLY mode.
// Using .tsx extension explicitly is required with some Vite configs.

/**
 * MOUNTING REACT INTO THE DOM
 *
 * document.getElementById("root") finds the single <div id="root"> in index.html.
 * The non-null assertion (!) tells TypeScript: "trust me, this element exists."
 * If it somehow doesn't exist (typo in index.html), this will throw at runtime —
 * which is an appropriate crash since the app truly can't run without it.
 *
 * createRoot().render() is equivalent to the old ReactDOM.render() but:
 *   - Returns a root object with .render() and .unmount() methods
 *   - Enables concurrent rendering (React can batch updates more aggressively)
 *   - Required for React 18+ features like useTransition and useDeferredValue
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/*
      StrictMode wraps the entire app so ALL components benefit from its checks.
      Placing it here (at the very top) rather than inside App ensures no component
      escapes the extra validation during development.
    */}
    <App />
    {/*
      App is the root component. It decides whether to show:
        - RocketSimulator (fly mode — default)
        - RocketBuilder (build mode — when user selects "Build Custom")
      Both are mutually exclusive; only one renders at a time.
    */}
  </StrictMode>
);
