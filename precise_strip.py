with open("src/components/RocketSimulator.tsx", "r") as f:
    lines = f.readlines()

out = []
i = 0
while i < len(lines):
    line = lines[i]
    if "// ── PARTICLES ──" in line:
        # We found the start of the massive block.
        # Let's insert the replacement block.
        replacement = """      // ── WARNING BANNER TIMER DECAY (real time) ──────────────────────────
      warningBannersRef.current = warningBannersRef.current
        .map((w) => ({ ...w, timeLeft: w.timeLeft - rawDelta }))
        .filter((w) => w.timeLeft > 0);

      // ── MAX-Q FLASH TIMER DECAY (real time) ─────────────────────────────
      if (maxQFlashTimerRef.current > 0) {
        maxQFlashTimerRef.current -= rawDelta;
      }

      performanceMonitorRef.current.endRenderTimer();
      performanceMonitorRef.current.setTrajectoryPointCount(trajectoryBufferRef.current.length);
      performanceMonitorRef.current.endFrame();

"""
        out.append(replacement)
        
        # Skip lines until we find the "SYNC TO REACT STATE" line
        while i < len(lines) and "// ── SYNC TO REACT STATE" not in lines[i]:
            i += 1
        
        continue

    out.append(line)
    i += 1

with open("src/components/RocketSimulator.tsx", "w") as f:
    f.writelines(out)
