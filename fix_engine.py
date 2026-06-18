with open("src/physics/engine.ts", "r") as f:
    lines = f.readlines()

for i, l in enumerate(lines):
    if l.startswith("const calculateTotalMass = "):
        lines[i] = l.replace("const calculateTotalMass = ", "export const calculateTotalMass = ")
    elif l.startswith("const calculateTotalThrust = "):
        lines[i] = l.replace("const calculateTotalThrust = ", "export const calculateTotalThrust = ")

with open("src/physics/engine.ts", "w") as f:
    f.writelines(lines)
