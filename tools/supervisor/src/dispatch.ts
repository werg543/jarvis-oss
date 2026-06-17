import { spawn } from "node:child_process";
import type { Signal } from "./types.js";

export interface DispatchResult {
  triggerId: string;
  proposal: string;
  via: string;
}

export interface ModelDispatcher {
  dispatch(signal: Signal): Promise<DispatchResult>;
}

export interface RouterOptions {
  localModel: string;
  nvidiaApiKey?: string;
  nvidiaModel?: string;
}

// The dispatcher PROPOSES a next action for a fired trigger. It never executes
// anything: spawned with --strict-mcp-config and no MCP servers, so it cannot
// reach email/money/trade tools.
//
// 3-tier cost cascade:
//   - Ollama (local)   -> most basic tasks. Free, fully private (stays on box).
//   - NVIDIA NIM (free) -> harder middle tasks. Free up to limits, CLOUD.
//   - Claude           -> important work and every decision. The decision maker.
// HARD GATE: sensitive content (email/finance/secrets) NEVER goes to the NVIDIA
// cloud tier. It stays on the local Ollama (private) or escalates to Claude.

const buildPrompt = (s: Signal): string =>
  `You are an always-on supervisor. A trigger just fired:\n` +
  `- trigger: ${s.triggerId}\n- detail: ${s.summary}\n\n` +
  `In 2-3 sentences, propose the single best next action for the user to consider. ` +
  `Propose only; never claim to have done anything. Be concrete, concise, no preamble.`;

const SENSITIVE =
  /\b(email|inbox|gmail|invoice|payment|bank|password|secret|api[_ ]?key|token|ssn|wire|transfer|trade|order|broker|brokerage)\b/i;
const IMPORTANT =
  /\b(urgent|deadline|filing|legal|security|breach|money|overdue|lawsuit|contract|irs|tax)\b/i;

type Tier = "basic" | "mid" | "important";

function classify(s: Signal): { tier: Tier; sensitive: boolean } {
  const text = `${s.triggerId} ${s.summary}`;
  const sensitive = SENSITIVE.test(text);
  if (s.urgent || IMPORTANT.test(text)) return { tier: "important", sensitive };
  if ((s.summary ?? "").length < 140) return { tier: "basic", sensitive };
  return { tier: "mid", sensitive };
}

// Ordered list of backends to try. Sensitive content never includes "nvidia".
function plan(tier: Tier, sensitive: boolean, hasNvidia: boolean): Array<"ollama" | "nvidia" | "claude"> {
  const nvidia: Array<"nvidia"> = !sensitive && hasNvidia ? ["nvidia"] : [];
  if (tier === "important") return ["claude", "ollama"];
  if (tier === "basic") return ["ollama", ...nvidia, "claude"];
  return [...nvidia, "ollama", "claude"];
}

async function tryOllama(prompt: string, model: string, timeoutMs = 75000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = (await r.json()) as { response?: string };
    const out = (j.response ?? "").trim();
    return out || null;
  } catch {
    return null;
  }
}

async function tryNvidia(
  prompt: string,
  model: string,
  apiKey: string,
  timeoutMs = 45000
): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 512,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const out = (j.choices?.[0]?.message?.content ?? "").trim();
    return out || null;
  } catch {
    return null;
  }
}

function tryClaude(prompt: string, timeoutMs = 90000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | null): void => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const child = spawn("claude", ["-p", prompt, "--strict-mcp-config"], {
      shell: true,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(out.trim() || null);
    });
  });
}

export class RouterDispatcher implements ModelDispatcher {
  private readonly localModel: string;
  private readonly nvidiaApiKey: string;
  private readonly nvidiaModel: string;

  constructor(opts: RouterOptions) {
    this.localModel = opts.localModel;
    this.nvidiaApiKey = opts.nvidiaApiKey ?? "";
    this.nvidiaModel = opts.nvidiaModel || "meta/llama-3.3-70b-instruct";
  }

  async dispatch(signal: Signal): Promise<DispatchResult> {
    const prompt = buildPrompt(signal);
    const { tier, sensitive } = classify(signal);
    const order = plan(tier, sensitive, !!this.nvidiaApiKey);
    for (const t of order) {
      let out: string | null = null;
      if (t === "ollama") out = await tryOllama(prompt, this.localModel);
      else if (t === "nvidia") out = await tryNvidia(prompt, this.nvidiaModel, this.nvidiaApiKey);
      else out = await tryClaude(prompt);
      if (out) {
        const via =
          t === "ollama" ? `ollama:${this.localModel}` : t === "nvidia" ? `nvidia:${this.nvidiaModel}` : "claude";
        return { triggerId: signal.triggerId, proposal: out, via: `${via} [${tier}${sensitive ? "/sensitive" : ""}]` };
      }
    }
    return { triggerId: signal.triggerId, proposal: "(dispatch failed: no model reachable)", via: "none" };
  }
}
