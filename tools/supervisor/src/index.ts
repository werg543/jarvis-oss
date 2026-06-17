import {
  loadState,
  saveState,
  emptyTriggerState,
  DEFAULT_STATE_PATH,
} from "./state.js";
import { buildRegistry } from "./triggers/index.js";
import { filterSignals, isQuietHours } from "./filter.js";
import { notify } from "./notify.js";
import { RouterDispatcher } from "./dispatch.js";
import type { Signal, SupervisorState, Trigger } from "./types.js";

async function tick(): Promise<void> {
  const now = new Date();
  const state = loadState();
  const triggers = buildRegistry(state.config.deadlineHorizonDays);

  if (state.lastTickISO !== null) {
    const elapsedMin =
      (now.getTime() - Date.parse(state.lastTickISO)) / 60000;
    if (elapsedMin < state.config.minIntervalMin) {
      console.log(
        `[skip] global min-interval not elapsed (${Math.round(
          elapsedMin
        )}/${state.config.minIntervalMin}m)`
      );
      return;
    }
  }

  const raw: Signal[] = [];
  for (const t of triggers) {
    if (state.config.enabled[t.id] !== true) continue;
    try {
      const sig = await t.check();
      if (sig) raw.push(sig);
    } catch (err) {
      console.error(`[error] trigger ${t.id} check failed:`, err);
    }
  }

  const { survivors, dropped } = filterSignals(raw, triggers, state, now);

  for (const d of dropped) {
    console.log(`[drop:${d.reason}] ${d.signal.triggerId}: ${d.signal.summary}`);
  }

  notify(survivors, now);

  if (
    state.config.modelDispatcherEnabled &&
    survivors.length > 0 &&
    !isQuietHours(now, state.config.quietHours)
  ) {
    const today = now.toISOString().slice(0, 10);
    if (state.dispatch.dateISO !== today) {
      state.dispatch = { dateISO: today, count: 0 };
    }
    const dispatcher = new RouterDispatcher({
      localModel: state.config.localModel,
      nvidiaApiKey: process.env.NVIDIA_NIM_API_KEY || state.config.nvidiaApiKey,
      nvidiaModel: state.config.nvidiaModel,
    });
    for (const sig of survivors) {
      if (state.dispatch.count >= state.config.modelDispatcherDailyCap) {
        console.log(
          `[dispatch] daily cap ${state.config.modelDispatcherDailyCap} reached; skipping rest`
        );
        break;
      }
      try {
        const res = await dispatcher.dispatch(sig);
        state.dispatch.count++;
        console.log(`[proposal:${res.via}] ${res.triggerId}: ${res.proposal}`);
      } catch (err) {
        console.error(`[dispatch] ${sig.triggerId} failed:`, err);
      }
    }
  }

  recordFires(state, survivors, triggers, now);
  state.lastTickISO = now.toISOString();
  saveState(state);

  console.log(
    `[tick] raw=${raw.length} survivors=${survivors.length} dropped=${dropped.length} quietHours=${isQuietHours(
      now,
      state.config.quietHours
    )}`
  );
}

function recordFires(
  state: SupervisorState,
  survivors: Signal[],
  _triggers: Trigger[],
  now: Date
): void {
  for (const sig of survivors) {
    const ts = state.triggers[sig.triggerId] ?? emptyTriggerState();
    ts.lastFiredISO = now.toISOString();
    ts.lastKey = sig.key;
    state.triggers[sig.triggerId] = ts;
  }
}

async function runWatch(minutes: number): Promise<void> {
  const ms = Math.max(1, minutes) * 60000;
  console.log(`[watch] interval=${minutes}m state=${DEFAULT_STATE_PATH}`);
  await tick();
  setInterval(() => {
    tick().catch((err) => console.error("[error] tick failed:", err));
  }, ms);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--once")) {
    await tick();
    return;
  }
  const watchIdx = args.indexOf("--watch");
  if (watchIdx !== -1) {
    const raw = args[watchIdx + 1];
    const minutes = raw ? parseInt(raw, 10) : 10;
    await runWatch(Number.isNaN(minutes) ? 10 : minutes);
    return;
  }
  console.log("usage: node dist/index.js --once | --watch [minutes]");
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
