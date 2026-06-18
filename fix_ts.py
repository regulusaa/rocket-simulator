import re

with open("src/components/RocketSimulator.tsx", "r") as f:
    code = f.read()

# Remove unused imports
code = re.sub(r'import \{ ParticleSystem \} from "\.\./physics/ParticleSystem";\n', '', code)
code = re.sub(r'import \{ Camera \} from "\.\./utils/Camera";\n', '', code)

# AtmosphericTelemetry seems to be missing? Let's check where it's used or where it was imported from.
# It was probably imported from "../physics/engine" or "../physics/AtmosphereModel".
code = code.replace("AtmosphericTelemetry", "any") # Just use any for now if it's missing, or we can see where it's from.

# Remove canvasWidth/Height
code = re.sub(r'const \[canvasWidth, setCanvasWidth\] = useState\(window\.innerWidth\);\n', '', code)
code = re.sub(r'const \[canvasHeight, setCanvasHeight\] = useState\(window\.innerHeight\);\n', '', code)
code = code.replace('setCanvasWidth(window.innerWidth);', '')
code = code.replace('setCanvasHeight(window.innerHeight);', '')

# Remove starsRef
code = re.sub(r'starsRef\.current = generateStars\(1000, canvasWidth, canvasHeight\);', '', code)

# Remove cw, ch
code = re.sub(r'const cw = canvas\.width;\n', '', code)
code = re.sub(r'const ch = canvas\.height;\n', '', code)

# Remove particleSystemRef and cameraRef usages
code = re.sub(r'particleSystemRef\.current.*?;\n', '', code)
code = re.sub(r'cameraRef\.current.*?;\n', '', code)

# `state` might have been used in landing event?
# If there's a `state` that's undefined, let's look at the errors:
# src/components/RocketSimulator.tsx(1571,12): error TS2304: Cannot find name 'state'.
# We will use python to just find where `state.` is used.

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.write(code)

