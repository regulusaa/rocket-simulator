with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

def replace_line(search, repl):
    for i, l in enumerate(lines):
        if search in l:
            lines[i] = repl
            break

# 1. Imports
replace_line("import type { FlightPhase } from \"../store/telemetryStore\";", "")
replace_line("INFO_PANEL_MARGIN,", "")
replace_line("TRAJECTORY_PANEL_WIDTH,", "")
replace_line("TRAJECTORY_PANEL_HEIGHT,", "")
replace_line("drawTelemetry,", "")

# 2. Unused states
replace_line("const [trajectoryHistory, setTrajectoryHistory] = useState<{ x: number; y: number }[]>([]);", "")
replace_line("const [showFullscreenTrajectory, setShowFullscreenTrajectory] = useState(false);", "")
replace_line("const [autoFlyEnabled, setAutoFlyEnabled] = useState(false);", "")
replace_line("setAutoFlyEnabled(newEnabled);", "")

# 3. Store Update Vehicle
for i, l in enumerate(lines):
    if "const stagesInfo = getStageFuelStatus(config);" in l:
        new_block = """        const stagesInfo = getStageFuelStatus(config);
        const totalMass = calculateTotalMass(config);
        const totalThrust = calculateTotalThrust(config);
        store.updateVehicle({
          structuralIntegrity: struct.structuralIntegrity,
          throttlePercent: activeStage ? activeStage.thrustPercentage : 0,
          stages: stagesInfo.map(s => {
            const stg = config.stages.find(st => st.stageNumber === s.stageNumber);
            return {
              stageNumber: s.stageNumber,
              name: s.name,
              fuelPercent: s.fuelPercent,
              isActive: s.isActive,
              isSeparated: s.isSeparated,
              isThrusting: stg ? stg.thrustPercentage > 0 : false,
              thrustPercentage: stg ? stg.thrustPercentage : 0
            };
          }),
          activeStage: activeStageIdx + 1,
          totalMass: totalMass,
          totalThrust: totalThrust,
          twr: totalMass > 0 ? totalThrust / (totalMass * GRAVITY) : 0,
          didBreakApart: isStructuralFailureRef.current
        });\n"""
        
        # find where store.updateVehicle ends
        end_idx = i
        for j in range(i, len(lines)):
            if "didBreakApart: isStructuralFailureRef.current" in lines[j]:
                end_idx = j + 2
                break
        
        lines[i:end_idx] = [new_block]
        break

# 4. Remove unused styles
replace_line("const topBarStyle: React.CSSProperties = {", "const topBarStyle_unused: React.CSSProperties = {")
replace_line("const controlGroupStyle: React.CSSProperties = {", "const controlGroupStyle_unused: React.CSSProperties = {")
replace_line("const selectStyle: React.CSSProperties = {", "const selectStyle_unused: React.CSSProperties = {")

# 5. Fix handleCustomGoal
replace_line("const handleCustomGoal = (e: React.ChangeEvent<HTMLInputElement>) => {", "const handleCustomGoal = (e: any) => {")

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(lines)
print("RocketSimulator fixed")

with open("src/components/dashboard/GMeter.tsx", "r") as f:
    gmeter_lines = f.readlines()
for i, l in enumerate(gmeter_lines):
    if "const R_INNER" in l:
        gmeter_lines[i] = ""
        break
with open("src/components/dashboard/GMeter.tsx", "w") as f:
    f.writelines(gmeter_lines)
print("GMeter fixed")

