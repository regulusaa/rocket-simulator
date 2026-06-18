with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

new_lines = []
skip_next = False
for i, line in enumerate(lines):
    if skip_next:
        skip_next = False
        continue
        
    # Remove the canvas resize effect completely
    if "useEffect(() => {" in line and "canvasRef.current.width" in lines[i+2]:
        skip_next = True
        continue
        
    if "canvasRef.current.width" in line or "canvasRef.current.height" in line:
        continue
        
    # Remove the game loop early returns
    if "const canvas = canvasRef.current;" in line:
        continue
    if "if (!canvas) return;" in line:
        continue
    if 'const ctx = canvas.getContext("2d");' in line:
        continue
    if "if (!ctx) return;" in line:
        continue

    # Remove the canvasRef definition
    if "const canvasRef = useRef<HTMLCanvasElement>(null);" in line:
        continue
        
    # Remove unused refs that we stripped from rendering
    if "const cameraRef = useRef<Camera>" in line:
        continue
    if "const particleSystemRef = useRef<ParticleSystem>" in line:
        continue
    if "const starsRef = useRef<Star[]>" in line:
        continue

    new_lines.append(line)

# Now, we also have to fix `handleCanvasClick` which relied on `onClick`.
# It is still passed to the `div` wrapper, which is fine.

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(new_lines)
