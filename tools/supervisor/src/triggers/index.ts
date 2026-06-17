import type { Signal, Trigger } from "../types.js";

// Example trigger registry. Replace these stubs with your own checks: a
// calendar lookahead, an inbox scan, a metric threshold, a file watcher.
// Each trigger runs cheap plain code on every tick; only when check() returns
// a Signal does the dispatcher spend a model call. Keep checks free/local so
// the loop costs nothing when there's nothing to do.

function exampleDeadline(horizonDays: number): Trigger {
  return {
    id: "deadline-soon",
    cooldownMin: 720,
    async check(): Promise<Signal | null> {
      // TODO: read your own data source and return a Signal when something is
      // worth surfacing, else null. horizonDays is your lookahead window.
      void horizonDays;
      return null;
    },
  };
}

export function buildRegistry(deadlineHorizonDays: number): Trigger[] {
  return [exampleDeadline(deadlineHorizonDays)];
}
