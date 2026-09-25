# Rocket Simulator

**Build a rocket, launch it, and follow the flight.**

Choose rocket parts, put your own rocket together, and launch it in the browser. A 3D view lets you follow the flight while the dashboard shows what is happening.

## Explore

- Switch between **Build** and **Fly** modes.
- Put rocket sections together and check their details before launch.
- Launch a custom configuration into the simulation.
- Follow a 3D flight view and telemetry dashboard.
- Come back to the rocket you last launched after refreshing the page.

## Run locally

```bash
npm install
npm run dev
```

To check the project:

```bash
npm run lint
npm run build
```

## Project map

| Path | Purpose |
| --- | --- |
| `src/components/RocketBuilder*` | Vehicle assembly interface |
| `src/components/RocketSimulator*` | Flight view and controls |
| `src/physics/` | Simulation models and multi stage systems |
| `src/data/` | Rocket and part data |
| `src/store/` | Shared application state |

**Stack:** React, TypeScript, Vite, Three.js, React Three Fiber, Zustand, and Recharts.

This is an interactive software simulation, not a flight planning tool.
