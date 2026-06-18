import re

with open("src/components/RocketSimulator.tsx", "r") as f:
    code = f.read()

# Remove the whole PARTICLES to SYNC TO REACT STATE block
pattern = r"// ── PARTICLES ────────────────────────────────────────────────────────.*?// ── SYNC TO REACT STATE & ZUSTAND STORE \(every 3 frames\) ──────────"

replacement = """// ── WARNING BANNER TIMER DECAY (real time) ──────────────────────────
      warningBannersRef.current = warningBannersRef.current
        .map((w) => ({ ...w, timeLeft: w.timeLeft - rawDelta }))
        .filter((w) => w.timeLeft > 0);

      // ── MAX-Q FLASH TIMER DECAY (real time) ─────────────────────────────
      if (maxQFlashTimerRef.current > 0) {
        maxQFlashTimerRef.current -= rawDelta;
      }

      performanceMonitorRef.current.endRenderTimer();
      performanceMonitorRef.current.setTrajectoryPointCount(trajectoryBufferRef.current.length);
      performanceMonitorRef.current.endFrame();

      // ── SYNC TO REACT STATE & ZUSTAND STORE (every 3 frames) ──────────"""

new_code = re.sub(pattern, replacement, code, flags=re.DOTALL)

# Remove drawHelpers imports
import_pattern = r"import \{\n\s*generateStars,\s*drawBackground,.*?\} from \"\.\./utils/drawHelpers\";\n"
new_code = re.sub(import_pattern, "", new_code, flags=re.DOTALL)

# Add R3F imports at the top
r3f_imports = """
import { Canvas } from '@react-three/fiber';
import { SceneSetup } from './3d/SceneSetup';
import { RocketMesh } from './3d/RocketMesh';
import { ExhaustParticles } from './3d/ExhaustParticles';
import { CameraRig } from './3d/CameraRig';
"""
new_code = new_code.replace('import { TelemetryDashboard } from "./dashboard/TelemetryDashboard";', 'import { TelemetryDashboard } from "./dashboard/TelemetryDashboard";' + r3f_imports)

# Replace the <canvas> element with the 3D Canvas
canvas_element_pattern = r"        <canvas\s+ref=\{canvasRef\}.*?/>"
r3f_canvas = """        <div style={{ position: "absolute", inset: 0, cursor: "crosshair" }} onClick={handleCanvasClick}>
          <Canvas>
            <SceneSetup flightStateRef={flightStateRef} />
            <RocketMesh flightStateRef={flightStateRef} configRef={rocketConfigRef} />
            <ExhaustParticles flightStateRef={flightStateRef} configRef={rocketConfigRef} />
            <CameraRig flightStateRef={flightStateRef} />
          </Canvas>
        </div>"""
new_code = re.sub(canvas_element_pattern, r3f_canvas, new_code, flags=re.DOTALL)

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.write(new_code)

