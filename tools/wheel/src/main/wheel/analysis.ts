import { join } from 'node:path';
import { app } from 'electron';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import type {
  WheelAnalysis,
  WheelAnalysisData,
  WheelFundamental,
  WheelEarnings,
  WheelNewsItem,
  WheelVerdict
} from '../../shared/types';
import { spawnClaude, extractJsonObject, str, CWD, type ClaudeResult } from './headless';

const MODEL = 'claude-sonnet-4-6';
const KILL_MS = 240_000;
const CACHE_TTL_DAYS = 7;

const WEB_TOOLS = 'WebSearch,WebFetch';

const ANALYSIS_PROXY: Record<string, string> = { TQQQ: 'QQQ', SQQQ: 'QQQ' };

function buildPrompt(symbol: string): string {
  const proxy = ANALYSIS_PROXY[symbol];
  const research = proxy ?? symbol;
  const lead = proxy
    ? `${symbol} is a leveraged ETF that tracks ${proxy}; base this breakdown on ${proxy} (the underlying index ETF), not the leveraged product. `
    : '';
  return (
    lead +
    `You are an equity analyst producing a fundamental breakdown of ${research} for an ` +
    'OPTIONS-WHEEL (cash-secured put) decision. Use WebSearch/WebFetch for CURRENT figures; ' +
    'do not read any local files. Apply this framework:\n' +
    '1. Business model: what the company actually does and how it makes money, in plain English.\n' +
    '2. Fundamentals: revenue growth, margins / profitability, EPS and forward EPS, P/E and forward P/E ' +
    '(or P/S / PEG for non-earners), free cash flow, balance-sheet health (cash vs debt), and dividend ' +
    'yield if any. ALSO research INSIDER activity (recent Form 4 buys/sells and net direction) and ' +
    'CONGRESSIONAL trading activity (notable politician buys/sells) for the name.\n' +
    '3. Earnings & catalysts: next earnings date and upcoming catalysts; judge assignment risk ' +
    'against a ~2-3 week option expiry.\n' +
    '4. Wheel suitability: would you be comfortable being assigned shares of this name? Rate it.\n' +
    '5. Technical read: trend, key support, and momentum (moving-average posture / RSI).\n' +
    '6. Recent news: WebSearch for SIGNIFICANT news on the company from roughly the last 4 weeks ' +
    '(earnings results, guidance changes, analyst upgrades/downgrades, M&A, regulatory or legal events, ' +
    'major product or leadership changes) that bears on the wheel decision. Cite each with its source and URL.\n' +
    'Output ONLY a single JSON object with the EXACT shape below. NO prose before or after, ' +
    'NO code fences, NO explanations:\n' +
    '{\n' +
    '  "companyName": string,\n' +
    '  "whatItDoes": string,            // 2-3 sentence plain-English description of the business; this leads the page; required\n' +
    '  "fundamentals": [ { "label": string, "value": string, "def": string } ],  // ~10 metrics: revenue growth, margins/profitability, EPS, forward EPS, P/E, forward P/E (or P/S / PEG), free cash flow, balance sheet (cash vs debt), dividend yield, PLUS "Insider activity" (e.g. "net buying, 3 buys 90d") and "Congress trades" (e.g. "2 buys, 1 sell, 60d"). value = a SHORT figure/phrase only, e.g. "+18% YoY", "EPS $3.20", "Fwd P/E 19x", "net buying 90d" (no sentences). def = a SHORT plain-English definition (<=12 words).\n' +
    '  "earnings": { "nextDate": string, "beforeExpiry": boolean, "note": string },  // nextDate "" if unknown; beforeExpiry true if earnings land before the ~2-3 week option expiry; note = short assignment-risk comment\n' +
    '  "catalysts": [ string ],         // upcoming catalysts / watch items, short phrases\n' +
    '  "verdict": { "rating": "favorable"|"caution"|"avoid", "summary": string, "risks": [ string ] },  // is this a name you would be comfortable being assigned? summary one sentence; risks short phrases\n' +
    '  "technical": string,             // 1-2 sentence technical read: trend, key support, and momentum (e.g. RSI / moving-average posture); pairs with the fundamental verdict; required\n' +
    '  "recentNews": [ { "note": string, "date": string, "source": string, "url": string } ]  // up to ~4 SIGNIFICANT items from the last ~4 weeks, newest first. note = a 1-2 sentence plain-English explanation of what happened and why it matters (NOT a terse headline). source = the outlet name, url = the article link. [] if nothing material\n' +
    '}\n' +
    'Be specific with numbers in the values. No preamble, no disclaimers, no code fences. ' +
    'If a figure is unavailable use a brief "n/a" string rather than inventing it.'
  );
}

type Cache = Record<string, WheelAnalysis>;

let cache: Cache | null = null;
const inflight = new Map<string, Promise<WheelAnalysis>>();

function cacheFile(): string {
  return join(app.getPath('userData'), 'wheel-analysis.json');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function cacheKey(symbol: string): string {
  return `${symbol.toUpperCase()}|${today()}`;
}

async function loadCache(): Promise<void> {
  try {
    const txt = await readFile(cacheFile(), 'utf8');
    const parsed = JSON.parse(txt) as Cache;
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
}

function pruneCache(): void {
  if (!cache) return;
  const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const key of Object.keys(cache)) {
    const date = key.slice(key.lastIndexOf('|') + 1);
    if (date < cutoff) delete cache[key];
  }
}

async function saveCache(): Promise<void> {
  if (!cache) return;
  pruneCache();
  try {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(cacheFile(), JSON.stringify(cache), 'utf8');
  } catch {
    /* best effort */
  }
}

function runClaude(symbol: string): Promise<ClaudeResult> {
  return spawnClaude(
    [
      '-p',
      buildPrompt(symbol),
      '--output-format',
      'json',
      '--strict-mcp-config',
      '--mcp-config',
      join(CWD, 'mcp-none.json'),
      '--allowedTools',
      WEB_TOOLS,
      '--model',
      MODEL
    ],
    KILL_MS
  );
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x).trim()).filter((x) => x.length > 0);
}

function normalizeFundamentals(v: unknown): WheelFundamental[] {
  if (!Array.isArray(v)) return [];
  const out: WheelFundamental[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const label = str(r.label).trim();
    const value = str(r.value).trim();
    const def = str(r.def).trim();
    if (label && value) out.push(def ? { label, value, def } : { label, value });
  }
  return out;
}

function normalizeEarnings(v: unknown): WheelEarnings {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    nextDate: str(r.nextDate).trim(),
    beforeExpiry: r.beforeExpiry === true,
    note: str(r.note).trim()
  };
}

function normalizeVerdict(v: unknown): WheelVerdict {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const ratingRaw = str(r.rating).toLowerCase().trim();
  const rating: WheelVerdict['rating'] =
    ratingRaw === 'favorable' ? 'favorable' : ratingRaw === 'avoid' ? 'avoid' : 'caution';
  return { rating, summary: str(r.summary).trim(), risks: strList(r.risks) };
}

function normalizeNews(v: unknown): WheelNewsItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((it) => {
      const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
      const note = str(o.note).trim();
      if (!note) return null;
      return {
        note,
        date: str(o.date).trim(),
        source: str(o.source).trim(),
        url: str(o.url).trim()
      };
    })
    .filter((x): x is WheelNewsItem => x !== null)
    .slice(0, 6);
}

function normalizeData(obj: Record<string, unknown>): WheelAnalysisData | null {
  const whatItDoes = str(obj.whatItDoes).trim();
  const companyName = str(obj.companyName).trim();
  if (!whatItDoes) return null;
  return {
    companyName,
    whatItDoes,
    fundamentals: normalizeFundamentals(obj.fundamentals),
    earnings: normalizeEarnings(obj.earnings),
    catalysts: strList(obj.catalysts),
    verdict: normalizeVerdict(obj.verdict),
    technical: str(obj.technical).trim(),
    recentNews: normalizeNews(obj.recentNews)
  };
}

async function attempt(sym: string): Promise<WheelAnalysis> {
  const res = await runClaude(sym);
  const raw = (res.result ?? '').trim();
  if (res.is_error || !raw) {
    throw new Error('analysis returned empty');
  }
  const obj = extractJsonObject(raw);
  const data = obj ? normalizeData(obj) : null;
  return data
    ? { symbol: sym, ok: true, data, fetchedAt: Date.now() }
    : { symbol: sym, ok: true, markdown: raw, fetchedAt: Date.now() };
}

async function run(symbol: string): Promise<WheelAnalysis> {
  const sym = symbol.toUpperCase().trim();
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const entry = await attempt(sym);
      cache = cache ?? {};
      cache[cacheKey(sym)] = entry;
      await saveCache();
      return entry;
    } catch (err) {
      lastErr = err;
    }
  }
  return {
    symbol: sym,
    ok: false,
    fetchedAt: Date.now(),
    error: `Could not analyze ${sym}: ${String(lastErr)}`
  };
}

export type FundScoreMap = Record<string, { rating: WheelVerdict['rating']; score: number }>;

/** Maps a fundamental verdict to a 0..1 score for the blended Score column. */
function ratingScore(r: WheelVerdict['rating']): number {
  return r === 'favorable' ? 1 : r === 'avoid' ? 0.15 : 0.55;
}

/**
 * Fundamental scores for every symbol analyzed TODAY (from the analysis cache).
 * The screener folds these into the composite Score and colors the cell.
 */
export async function fundScoresToday(): Promise<FundScoreMap> {
  if (cache === null) await loadCache();
  const out: FundScoreMap = {};
  const suffix = `|${today()}`;
  for (const [key, entry] of Object.entries(cache ?? {})) {
    if (!key.endsWith(suffix) || !entry.ok) continue;
    const rating = entry.data?.verdict?.rating;
    if (!rating) continue;
    out[key.slice(0, key.length - suffix.length)] = { rating, score: ratingScore(rating) };
  }
  return out;
}

export async function analyzeSymbol(symbol: string, force = false): Promise<WheelAnalysis> {
  const sym = symbol.toUpperCase().trim();
  if (!sym) {
    return { symbol: '', ok: false, fetchedAt: Date.now(), error: 'no symbol' };
  }
  if (cache === null) await loadCache();
  const key = cacheKey(sym);
  if (!force && cache && cache[key]?.ok) return cache[key];

  const existing = inflight.get(key);
  if (existing) return existing;

  const p = run(sym).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
