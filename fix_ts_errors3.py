with open("src/physics/engine.ts", "r") as f:
    engine_lines = f.readlines()
for i, l in enumerate(engine_lines):
    if l.startswith("function calculateTotalMass"):
        engine_lines[i] = l.replace("function calculateTotalMass", "export function calculateTotalMass")
    elif l.startswith("function calculateTotalThrust"):
        engine_lines[i] = l.replace("function calculateTotalThrust", "export function calculateTotalThrust")
with open("src/physics/engine.ts", "w") as f:
    f.writelines(engine_lines)

with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

def replace_line(search, repl):
    for i, l in enumerate(lines):
        if search in l:
            lines[i] = repl
            break

replace_line("setShowFullscreenTrajectory", "")
replace_line("setAutoFlyEnabled", "")
replace_line("setTrajectoryHistory", "")
replace_line("const handleCustomGoal = (e: any) => {", "  const handleCustomGoal = (v: number) => {")
for i, l in enumerate(lines):
    if "const val = parseInt(e.target.value, 10);" in l:
        lines[i] = "    const val = v;\n"

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(lines)
print("fixed")

