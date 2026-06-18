with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

def replace_line(search, repl):
    for i, l in enumerate(lines):
        if search in l:
            lines[i] = repl
            break

# Remove them from engine.ts import
for i, l in enumerate(lines):
    if "  getStageFuelStatus," in l:
        new_import = """  getStageFuelStatus,
} from "../physics/engine";\n"""
        
        for j in range(i, len(lines)):
            if '} from "../physics/engine";' in lines[j]:
                lines[i:j+1] = [new_import]
                break
        break

# Add them to MultiStageSystem import
for i, l in enumerate(lines):
    if "  resetAllStages," in l:
        new_import = """  resetAllStages,
  calculateTotalMass,
  calculateTotalThrust,
} from "../physics/MultiStageSystem";\n"""
        
        for j in range(i, len(lines)):
            if '} from "../physics/MultiStageSystem";' in lines[j]:
                lines[i:j+1] = [new_import]
                break
        break

# Fix handleCustomGoal typing
for i, l in enumerate(lines):
    if "const handleCustomGoal = (e: any) => {" in l:
        lines[i] = "  const handleCustomGoal = (v: number) => {\n"
    if "const val = parseInt(e.target.value, 10);" in l:
        lines[i] = "    const val = v;\n"
    if "const val = v;" in l:
        lines[i] = "    const val = v;\n" # ensure it's correct

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(lines)
print("fixed")
