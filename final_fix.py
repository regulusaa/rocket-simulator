with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

def fix_funcs():
    for i in range(len(lines)):
        if "const handleCustomGoal = useCallback" in lines[i]:
            lines[i] = "  const handleCustomGoal = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {\n"
            lines[i+1] = "    const val = parseFloat(e.target.value);\n"
            lines[i+2] = "    if (!isNaN(val) && val > 0) {\n"
            lines[i+3] = "      setCustomGoalAltitude(val);\n"
            lines[i+4] = "      setSelectedGoal(null);\n"
            lines[i+5] = "    } else {\n"
            lines[i+6] = "      setCustomGoalAltitude(null);\n"
            lines[i+7] = "      setSelectedGoal(ALTITUDE_GOALS[0]);\n"
            lines[i+8] = "    }\n"
            lines[i+9] = "  }, []);\n"
        
        if "const handleVolumeChange = useCallback" in lines[i]:
            lines[i] = "  const handleVolumeChange = useCallback((v: number) => {\n"
            lines[i+1] = "    setMasterVolume(v);\n"
            lines[i+2] = "    audioManagerRef.current.setMasterVolume(v);\n"
            lines[i+3] = "  }, []);\n"

fix_funcs()

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(lines)
