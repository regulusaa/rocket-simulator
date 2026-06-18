with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

def replace_line(search, repl):
    for i, l in enumerate(lines):
        if search in l:
            lines[i] = repl
            break

# Fix unused states
replace_line("const [trajectoryHistory, setTrajectoryHistory] = useState<Array<{ x: number; y: number }>>([]);", "")
replace_line("const [showFullscreenTrajectory, setShowFullscreenTrajectory] = useState<boolean>(false);", "")
replace_line("const [autoFlyEnabled, setAutoFlyEnabled] = useState<boolean>(false);", "")
replace_line("setAutoFlyEnabled(newEnabled);", "")

# Fix unused styles
replace_line("const topBarStyle_unused: React.CSSProperties = {", "/* unused topBarStyle */")
replace_line("const controlGroupStyle_unused: React.CSSProperties = {", "/* unused controlGroupStyle */")
replace_line("const selectStyle_unused: React.CSSProperties = {", "/* unused selectStyle */")

# Remove unused variables and import calculateTotalMass and calculateTotalThrust
for i, l in enumerate(lines):
    if "  calculateLandingScore," in l:
        new_import = """  calculateLandingScore,
  getStageFuelStatus,
  calculateTotalMass,
  calculateTotalThrust,
} from "../physics/engine";\n"""
        
        # Replace up to engine import
        for j in range(i, len(lines)):
            if '} from "../physics/engine";' in lines[j]:
                lines[i:j+1] = [new_import]
                break
        break

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(lines)
print("RocketSimulator fixed again")

