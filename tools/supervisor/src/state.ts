import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SupervisorState, SupervisorConfig, TriggerState } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = join(here, "..");
export const DEFAULT_STATE_PATH = join(TOOL_DIR, "supervisor-state.json");

export const DEFAULT_CONFIG: SupervisorConfig = {
  quietHours: { start: "23:00", end: "07:00" },
  enabled: {
    "deadline-soon": true,
  },
  minIntervalMin: 5,
  deadlineHorizonDays: 3,
  modelDispatcherEnabled: true,
  modelDispatcherDailyCap: 24,
  localModel: "llama3.2",
  nvidiaApiKey: "",
  nvidiaModel: "meta/llama-3.3-70b-instruct",
};

function defaultState(): SupervisorState {
  return {
    config: { ...DEFAULT_CONFIG },
    triggers: {},
    lastTickISO: null,
    dispatch: { dateISO: null, count: 0 },
  };
}

export function emptyTriggerState(): TriggerState {
  return { lastFiredISO: null, lastKey: null };
}

export function loadState(path: string = DEFAULT_STATE_PATH): SupervisorState {
  if (!existsSync(path)) return defaultState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return defaultState();
  }
  if (typeof parsed !== "object" || parsed === null) return defaultState();
  const raw = parsed as Partial<SupervisorState>;
  const rawConfig = (raw.config ?? {}) as Partial<SupervisorConfig>;
  return {
    config: {
      quietHours: {
        start: rawConfig.quietHours?.start ?? DEFAULT_CONFIG.quietHours.start,
        end: rawConfig.quietHours?.end ?? DEFAULT_CONFIG.quietHours.end,
      },
      enabled: { ...DEFAULT_CONFIG.enabled, ...(rawConfig.enabled ?? {}) },
      minIntervalMin: rawConfig.minIntervalMin ?? DEFAULT_CONFIG.minIntervalMin,
      deadlineHorizonDays:
        rawConfig.deadlineHorizonDays ?? DEFAULT_CONFIG.deadlineHorizonDays,
      modelDispatcherEnabled:
        rawConfig.modelDispatcherEnabled ??
        DEFAULT_CONFIG.modelDispatcherEnabled,
      modelDispatcherDailyCap:
        rawConfig.modelDispatcherDailyCap ??
        DEFAULT_CONFIG.modelDispatcherDailyCap,
      localModel: rawConfig.localModel ?? DEFAULT_CONFIG.localModel,
      nvidiaApiKey: rawConfig.nvidiaApiKey ?? DEFAULT_CONFIG.nvidiaApiKey,
      nvidiaModel: rawConfig.nvidiaModel ?? DEFAULT_CONFIG.nvidiaModel,
    },
    triggers: raw.triggers ?? {},
    lastTickISO: raw.lastTickISO ?? null,
    dispatch: raw.dispatch ?? { dateISO: null, count: 0 },
  };
}

export function saveState(
  state: SupervisorState,
  path: string = DEFAULT_STATE_PATH
): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}
