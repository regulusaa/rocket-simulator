with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

for i, l in enumerate(lines):
    if "const handleCustomGoal = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {" in l:
        lines[i] = "  const handleCustomGoal = useCallback((v: number) => {\n"
    elif "const val = parseInt(e.target.value, 10);" in l:
        lines[i] = "    const val = v;\n"

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(lines)
