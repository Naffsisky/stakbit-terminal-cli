/**
 * Where the IDX trading day is, computed from the clock.
 *
 * ## Why this exists at all
 *
 * Half of what looks like a broken tracker is really "the market is shut". A tape that has not
 * changed in three hours, a quote identical to the last poll, an empty movers list — all correct
 * answers at 20:00 WIB, and all indistinguishable from a bug unless the UI says which. So the header
 * carries the session phase and the poller backs off when nothing can move.
 *
 * ## Holidays are not modelled, on purpose
 *
 * IDX closes for national holidays and the Idul Fitri week, which move every year. A hard-coded
 * table would be confidently wrong the first time it went stale — the worst failure available,
 * because the answer still looks authoritative. The schedule below is the fixed weekly one; on a
 * holiday the phase says "open" while quotes sit still, which is a much smaller lie than a stale
 * holiday table and is the same trade `stockbit-mcp` makes.
 *
 * ## WIB is UTC+7 with no DST
 *
 * A fixed offset is exact here, not an approximation, and it avoids depending on the host's timezone
 * database — this runs on whatever machine the user has.
 */
import type { SessionPhase, SessionState } from "./types.js";

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

interface Window {
  start: number; // minutes from midnight WIB
  end: number;
  phase: SessionPhase;
  label: string;
}

/** Monday-Thursday and Friday have different schedules; that is the whole reason for the table. */
const WEEKDAY: Window[] = [
  { start: 0, end: 8 * 60 + 45, phase: "closed", label: "Closed" },
  { start: 8 * 60 + 45, end: 9 * 60, phase: "pre-opening", label: "Pre-opening" },
  { start: 9 * 60, end: 12 * 60, phase: "session-1", label: "Session 1 — closes 12:00 WIB" },
  { start: 12 * 60, end: 13 * 60 + 30, phase: "break", label: "Break — Session 2 opens 13:30 WIB" },
  { start: 13 * 60 + 30, end: 15 * 60 + 50, phase: "session-2", label: "Session 2 — closes 15:50 WIB" },
  { start: 15 * 60 + 50, end: 16 * 60 + 15, phase: "post-closing", label: "Post-closing" },
  { start: 16 * 60 + 15, end: 24 * 60, phase: "closed", label: "Closed — market shut" },
];

const FRIDAY: Window[] = [
  { start: 0, end: 8 * 60 + 45, phase: "closed", label: "Closed" },
  { start: 8 * 60 + 45, end: 9 * 60, phase: "pre-opening", label: "Pre-opening" },
  { start: 9 * 60, end: 11 * 60 + 30, phase: "session-1", label: "Session 1 — closes 11:30 WIB" },
  { start: 11 * 60 + 30, end: 14 * 60, phase: "break", label: "Break — Session 2 opens 14:00 WIB" },
  { start: 14 * 60, end: 15 * 60 + 50, phase: "session-2", label: "Session 2 — closes 15:50 WIB" },
  { start: 15 * 60 + 50, end: 16 * 60 + 15, phase: "post-closing", label: "Post-closing" },
  { start: 16 * 60 + 15, end: 24 * 60, phase: "closed", label: "Closed — market shut" },
];

export function toWib(now: Date): Date {
  return new Date(now.getTime() + WIB_OFFSET_MS);
}

/** `HH:MM:SS` in WIB. */
export function formatWibTime(now: Date): string {
  const wib = toWib(now);
  const hh = String(wib.getUTCHours()).padStart(2, "0");
  const mm = String(wib.getUTCMinutes()).padStart(2, "0");
  const ss = String(wib.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Phases where a quote can actually move. */
const LIVE_PHASES: ReadonlySet<SessionPhase> = new Set<SessionPhase>(["session-1", "session-2"]);

export function sessionState(now: Date = new Date()): SessionState {
  const wib = toWib(now);
  const day = wib.getUTCDay(); // 0 Sunday … 6 Saturday
  const minutes = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  const nowWib = formatWibTime(now);

  if (day === 0 || day === 6) {
    return {
      phase: "weekend",
      label: "Weekend — IDX is closed",
      live: false,
      nowWib,
    };
  }

  const table = day === 5 ? FRIDAY : WEEKDAY;
  const window = table.find((w) => minutes >= w.start && minutes < w.end) ?? table[table.length - 1]!;

  return {
    phase: window.phase,
    label: window.label,
    live: LIVE_PHASES.has(window.phase),
    nowWib,
  };
}

/**
 * How long to wait before the next poll.
 *
 * Inside a session, the configured interval. Outside one, a slow heartbeat — long enough to stop
 * burning requests on data that cannot change, short enough that the header clock still ticks and
 * the user can see the tool is alive.
 */
export function nextPollDelay(baseMs: number, state: SessionState, alwaysPoll: boolean): number {
  if (alwaysPoll || state.live) return baseMs;
  return Math.max(baseMs, 15_000);
}
