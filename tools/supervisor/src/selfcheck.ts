import { filterSignals, isQuietHours } from "./filter.js";
import { DEFAULT_CONFIG } from "./state.js";
import type { Signal, SupervisorState, Trigger } from "./types.js";

function freshState(): SupervisorState {
  return {
    config: { ...DEFAULT_CONFIG },
    triggers: {},
    lastTickISO: null,
    dispatch: { dateISO: null, count: 0 },
  };
}

const triggers: Trigger[] = [
  { id: "deadline-soon", cooldownMin: 720, async check() { return null; } },
];

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

console.log("filter self-check\n");

// quiet-hours boundary math (default window 23:00 -> 07:00)
assert("00:30 is quiet", isQuietHours(new Date(2026, 5, 14, 0, 30), DEFAULT_CONFIG.quietHours));
assert("23:30 is quiet", isQuietHours(new Date(2026, 5, 14, 23, 30), DEFAULT_CONFIG.quietHours));
assert("06:59 is quiet", isQuietHours(new Date(2026, 5, 14, 6, 59), DEFAULT_CONFIG.quietHours));
assert("07:00 is NOT quiet", !isQuietHours(new Date(2026, 5, 14, 7, 0), DEFAULT_CONFIG.quietHours));
assert("12:00 is NOT quiet", !isQuietHours(new Date(2026, 5, 14, 12, 0), DEFAULT_CONFIG.quietHours));

const sigNormal: Signal = { triggerId: "deadline-soon", key: "k1", summary: "normal" };
const sigUrgent: Signal = { triggerId: "deadline-soon", key: "k2", summary: "urgent", urgent: true };

// quiet-hours suppression
{
  const night = new Date(2026, 5, 14, 2, 0);
  const r = filterSignals([sigNormal], triggers, freshState(), night);
  assert("non-urgent suppressed in quiet hours", r.survivors.length === 0 && r.dropped[0]?.reason === "quiet-hours");
}
{
  const night = new Date(2026, 5, 14, 2, 0);
  const r = filterSignals([sigUrgent], triggers, freshState(), night);
  assert("urgent survives quiet hours", r.survivors.length === 1);
}

// dedupe: same key already fired
{
  const day = new Date(2026, 5, 14, 12, 0);
  const st = freshState();
  st.triggers["deadline-soon"] = { lastFiredISO: new Date(2026, 5, 14, 11, 0).toISOString(), lastKey: "k1" };
  const r = filterSignals([sigNormal], triggers, st, day);
  assert("duplicate key dropped", r.survivors.length === 0 && r.dropped[0]?.reason === "duplicate-key");
}

// cooldown: different key but within cooldown window
{
  const day = new Date(2026, 5, 14, 12, 0);
  const st = freshState();
  st.triggers["deadline-soon"] = { lastFiredISO: new Date(2026, 5, 14, 11, 30).toISOString(), lastKey: "old" };
  const r = filterSignals([sigNormal], triggers, st, day);
  assert("within-cooldown dropped", r.survivors.length === 0 && (r.dropped[0]?.reason ?? "").startsWith("cooldown"));
}

// fresh signal survives in daytime
{
  const day = new Date(2026, 5, 14, 12, 0);
  const r = filterSignals([sigNormal], triggers, freshState(), day);
  assert("fresh signal survives in daytime", r.survivors.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
