with open("src/components/RocketSimulator.tsx") as f:
    lines = f.readlines()

def check_parens(lines):
    stack = []
    for i, line in enumerate(lines):
        for j, char in enumerate(line):
            if char in "({[":
                stack.append((char, i+1, j+1))
            elif char in ")}]":
                if not stack:
                    return f"Extra closing {char} at line {i+1}, col {j+1}"
                top_char, top_line, top_col = stack.pop()
                expected = {'(': ')', '{': '}', '[': ']'}[top_char]
                if char != expected:
                    return f"Mismatched closing {char} at line {i+1}, col {j+1} (expected {expected} to close {top_char} from line {top_line})"
    if stack:
        return f"Unclosed {stack[-1][0]} from line {stack[-1][1]}, col {stack[-1][2]}"
    return "All brackets match!"

print(check_parens(lines))
