import type {
  Signal,
  SupervisorState,
  Trigger,
  QuietHours,
} from "./types.js";
import { emptyTriggerState } from "./state.js";

export interface FilterResult {
  survivors: Signal[];
  dropped: { signal: Signal; reason: string }[];
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

export function isQuietHours(now: Date, quiet: QuietHours): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  // window wraps midnight, e.g. 23:00 -> 07:00
  return cur >= start || cur < end;
}

export function filterSignals(
  signals: Signal[],
  triggers: Trigger[],
  state: SupervisorState,
  now: Date
): FilterResult {
  const survivors: Signal[] = [];
  const dropped: { signal: Signal; reason: string }[] = [];
  const cooldownById = new Map(triggers.map((t) => [t.id, t.cooldownMin]));
  const quiet = isQuietHours(now, state.config.quietHours);

  for (const sig of signals) {
    if (quiet && !sig.urgent) {
      dropped.push({ signal: sig, reason: "quiet-hours" });
      continue;
    }

    const ts = state.triggers[sig.triggerId] ?? emptyTriggerState();

    if (ts.lastKey !== null && ts.lastKey === sig.key) {
      dropped.push({ signal: sig, reason: "duplicate-key" });
      continue;
    }

    if (ts.lastFiredISO !== null) {
      const cooldownMin = cooldownById.get(sig.triggerId) ?? 0;
      const elapsedMin =
        (now.getTime() - Date.parse(ts.lastFiredISO)) / 60000;
      if (elapsedMin < cooldownMin) {
        dropped.push({
          signal: sig,
          reason: `cooldown (${Math.round(elapsedMin)}/${cooldownMin}m)`,
        });
        continue;
      }
    }

    survivors.push(sig);
  }

  return { survivors, dropped };
}
