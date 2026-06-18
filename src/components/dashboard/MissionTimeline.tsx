/**
 * MissionTimeline — Horizontal Scrolling Event Timeline
 * =====================================================
 * Renders a horizontal timeline of mission events (ignition, liftoff,
 * MAX-Q, staging, landing, etc.) as colored dots connected by lines.
 * Automatically scrolls to keep the latest event visible.
 *
 * Each event shows:
 *   - A color-coded dot (8px, color based on event.type)
 *   - Event name (8px uppercase)
 *   - T+ timestamp (7px grey, formatted MM:SS or H:MM:SS)
 *
 * Subscribes to `selectMission` for the `events` array.
 */

import React, { useRef, useEffect } from 'react';
import { useTelemetryStore, selectMission } from '../../store/telemetryStore';
import type { MissionEvent } from '../../store/telemetryStore';

/** Map event type to dot color. */
const EVENT_COLORS: Record<MissionEvent['type'], string> = {
  ignition:  '#ff8c00',
  liftoff:   '#00d4ff',
  maxq:      '#ffd000',
  staging:   '#ffffff',
  parachute: '#00ff88',
  landing:   '#00ff88',
  failure:   '#ff3040',
  info:      '#3388ff',
};

/**
 * Format elapsed seconds as T+MM:SS or T+H:MM:SS when > 1 hour.
 */
const formatTime = (seconds: number): string => {
  const totalSec = Math.max(0, Math.floor(seconds));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');

  if (h > 0) {
    return `T+${h}:${mm}:${ss}`;
  }
  return `T+${mm}:${ss}`;
};

export const MissionTimeline: React.FC = () => {
  const mission = useTelemetryStore(selectMission);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest event whenever events change.
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'end',
    });
  }, [mission.events.length]);

  return (
    <div className="panel">
      {/* Panel header */}
      <div className="panel__header">
        <span className="panel__title">Mission Timeline</span>
        {mission.events.length > 0 && (
          <span className="panel__badge" style={{ color: '#8899bb' }}>
            {mission.events.length} events
          </span>
        )}
      </div>

      {/* Scrollable timeline */}
      <div className="timeline">
        {mission.events.length === 0 && (
          <span
            style={{
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-tertiary)',
              letterSpacing: '0.5px',
            }}
          >
            AWAITING EVENTS…
          </span>
        )}

        {mission.events.map((event, i) => (
          <React.Fragment key={`${event.type}-${event.time}-${i}`}>
            {/* Connector line (before every event except the first) */}
            {i > 0 && <div className="timeline__connector" />}

            {/* Event node */}
            <div className="timeline__event">
              <div
                className="timeline__dot"
                style={{
                  backgroundColor: EVENT_COLORS[event.type],
                  boxShadow: `0 0 6px ${EVENT_COLORS[event.type]}`,
                }}
              />
              <span
                className="timeline__event-name"
                style={{ color: EVENT_COLORS[event.type] }}
              >
                {event.message}
              </span>
              <span className="timeline__event-time">
                {formatTime(event.time)}
              </span>
            </div>
          </React.Fragment>
        ))}

        {/* Invisible anchor for auto-scroll */}
        <div ref={scrollAnchorRef} style={{ width: 1, flexShrink: 0 }} />
      </div>
    </div>
  );
};
