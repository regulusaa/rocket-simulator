with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    if "const starsRef = useRef<Star[]>" in line:
        continue
    if "starsRef.current = generateStars(" in line:
        continue
    if "const cw = window.innerWidth;" in line or "const ch = window.innerHeight;" in line:
        continue
    if "AtmosphericTelemetry" in line:
        line = line.replace("AtmosphericTelemetry", "any")
    
    new_lines.append(line)

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(new_lines)
