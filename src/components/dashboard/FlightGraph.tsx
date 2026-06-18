/**
 * FlightGraph — Real-Time Dual-Axis Flight Data Chart
 * ====================================================
 * Renders a recharts LineChart with two Y-axes:
 *   - Left axis: Velocity (m/s) — cyan line
 *   - Right axis: Dynamic Pressure Q (kPa) — orange line with area fill
 *
 * Data is sourced from the telemetry store's `chartData` slice,
 * merging `velocityHistory` and `qHistory` into a unified array
 * keyed by time. Only the most recent 120 seconds are shown.
 *
 * Styling matches the dark dashboard theme with transparent background,
 * subtle grid lines, and a custom dark tooltip.
 */

import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { useTelemetryStore, selectChartData } from '../../store/telemetryStore';

/** Merge velocity and Q histories into a single array keyed by time `t`. */
interface MergedPoint {
  t: number;
  velocity: number | undefined;
  qKpa: number | undefined;
}

/** Maximum time window to display (seconds). */
const TIME_WINDOW = 120;

/** Custom tooltip component matching the dark panel aesthetic. */
const ChartTooltip: React.FC<{
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
}> = ({ active, payload, label }) => {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div
      style={{
        background: 'rgba(8, 14, 32, 0.92)',
        border: '1px solid rgba(50, 90, 160, 0.3)',
        borderRadius: '4px',
        padding: '6px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: '10px',
      }}
    >
      <div style={{ color: '#8899bb', marginBottom: '3px' }}>
        T+{label?.toFixed(0)}s
      </div>
      {payload.map((entry) => (
        <div key={entry.name} style={{ color: entry.color, lineHeight: '16px' }}>
          {entry.name}: {entry.value.toFixed(1)}
        </div>
      ))}
    </div>
  );
};

export const FlightGraph: React.FC = () => {
  const chartData = useTelemetryStore(selectChartData);

  // Merge velocity and Q histories, trimmed to last TIME_WINDOW seconds.
  const mergedData = useMemo<MergedPoint[]>(() => {
    const map = new Map<number, MergedPoint>();

    // Index velocity points by rounded time
    for (const pt of chartData.velocityHistory) {
      const tKey = Math.round(pt.t * 10) / 10; // round to 0.1s
      const existing = map.get(tKey);
      if (existing) {
        existing.velocity = pt.v;
      } else {
        map.set(tKey, { t: tKey, velocity: pt.v, qKpa: undefined });
      }
    }

    // Index Q points by rounded time (Q stored in Pa, convert to kPa)
    for (const pt of chartData.qHistory) {
      const tKey = Math.round(pt.t * 10) / 10;
      const existing = map.get(tKey);
      if (existing) {
        existing.qKpa = pt.v / 1000;
      } else {
        map.set(tKey, { t: tKey, velocity: undefined, qKpa: pt.v / 1000 });
      }
    }

    // Sort by time and trim to last TIME_WINDOW seconds
    const sorted = Array.from(map.values()).sort((a, b) => a.t - b.t);
    if (sorted.length === 0) return sorted;

    const latestTime = sorted[sorted.length - 1].t;
    const cutoff = latestTime - TIME_WINDOW;
    return sorted.filter((p) => p.t >= cutoff);
  }, [chartData.velocityHistory, chartData.qHistory]);

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Panel header */}
      <div className="panel__header">
        <span className="panel__title">Flight Data</span>
        <span className="panel__badge" style={{ color: '#8899bb' }}>
          {mergedData.length > 0
            ? `${mergedData[mergedData.length - 1].t.toFixed(0)}s`
            : '—'}
        </span>
      </div>

      {/* Chart container — fills remaining panel height */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={mergedData}
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(50,90,160,0.15)"
              vertical={false}
            />

            {/* X-axis: time in seconds */}
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => `${v.toFixed(0)}s`}
              tick={{ fontSize: 9, fill: '#556688' }}
              stroke="rgba(50,90,160,0.2)"
              tickLine={false}
              axisLine={false}
            />

            {/* Left Y-axis: Velocity (m/s) */}
            <YAxis
              yAxisId="velocity"
              orientation="left"
              tick={{ fontSize: 9, fill: '#556688' }}
              stroke="rgba(50,90,160,0.2)"
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `${v.toFixed(0)}`}
              width={36}
              label={{
                value: 'm/s',
                position: 'insideTopLeft',
                offset: -4,
                style: { fontSize: 8, fill: '#00d4ff', fontWeight: 600 },
              }}
            />

            {/* Right Y-axis: Dynamic Pressure Q (kPa) */}
            <YAxis
              yAxisId="q"
              orientation="right"
              tick={{ fontSize: 9, fill: '#556688' }}
              stroke="rgba(50,90,160,0.2)"
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `${v.toFixed(1)}`}
              width={36}
              label={{
                value: 'kPa',
                position: 'insideTopRight',
                offset: -4,
                style: { fontSize: 8, fill: '#ff8c00', fontWeight: 600 },
              }}
            />

            <Tooltip content={<ChartTooltip />} />

            {/* Velocity line — cyan */}
            <Line
              yAxisId="velocity"
              type="monotone"
              dataKey="velocity"
              name="Velocity"
              stroke="#00d4ff"
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />

            {/* Q pressure line — orange with area fill */}
            <Line
              yAxisId="q"
              type="monotone"
              dataKey="qKpa"
              name="Q (kPa)"
              stroke="#ff8c00"
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
              fill="rgba(255,140,0,0.1)"
              fillOpacity={1}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
