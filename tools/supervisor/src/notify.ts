import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DIR } from "./state.js";
import type { Signal } from "./types.js";

const LOG_PATH = join(TOOL_DIR, "supervisor.log");

export function notify(signals: Signal[], now: Date): void {
  for (const sig of signals) {
    const line = JSON.stringify({
      ts: now.toISOString(),
      triggerId: sig.triggerId,
      urgent: sig.urgent ?? false,
      key: sig.key,
      summary: sig.summary,
    });
    appendFileSync(LOG_PATH, line + "\n", "utf8");
    const tag = sig.urgent ? "[URGENT]" : "[notify]";
    console.log(`${tag} ${sig.triggerId}: ${sig.summary}`);
  }
}
