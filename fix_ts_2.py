import re

with open("src/components/RocketSimulator.tsx", "r") as f:
    code = f.read()

# Remove canvasWidth/Height unused definitions if any
code = re.sub(r'const \[canvasWidth, setCanvasWidth\].*?\n', '', code)
code = re.sub(r'const \[canvasHeight, setCanvasHeight\].*?\n', '', code)

# Remove starsRef assignment
code = re.sub(r'starsRef\.current = generateStars\(.*?\);\n', '', code)

# Look for particleSystemRef and cameraRef
code = re.sub(r'particleSystemRef\.current.*?\n', '', code)
code = re.sub(r'cameraRef\.current.*?\n', '', code)

# "state" undefined at line 1565. Let's look at lines around 1565.
# They are probably:
# camera.setTargetZoom(state.position.y);
# camera.setTarget(state.position.x, 0);
# Which I forgot to strip entirely?
# Let's just remove any lines mentioning `cameraRef.current` or `camera.` or `camera,` ... Wait, no, `state` is what is undefined.
# If I remove all lines with `camera.`, the `state` might be on the same line.
# Let's just replace `state.` with `flightStateRef.current.` globally in the landing logic if needed, or remove the block.
# Let's replace "state.hasLanded" with "flightStateRef.current.hasLanded"
code = code.replace("state.hasLanded", "flightStateRef.current.hasLanded")
code = code.replace("state.position.", "flightStateRef.current.position.")

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.write(code)

