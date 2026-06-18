with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

def replace_line(search, repl):
    for i, l in enumerate(lines):
        if search in l:
            lines[i] = repl
            break

replace_line("const limited = trajectoryLimiterRef.current.limitTrajectory(", "        trajectoryLimiterRef.current.limitTrajectory(")
replace_line("setTrajectoryHistory([]);", "")
replace_line("setShowFullscreenTrajectory(false);", "")
replace_line("setAutoFlyEnabled(false);", "")

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(lines)
print("fixed")
