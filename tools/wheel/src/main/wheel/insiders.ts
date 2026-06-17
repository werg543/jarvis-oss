import { join } from 'node:path';
import { app } from 'electron';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import type { InsiderSummary } from '../../shared/types';

const USER_AGENT = 'wheel-screener/1.0';
const FETCH_DELAY_MS = 1500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const KILL_MS = 15_000;

type Cache = Record<string, InsiderSummary>;

let cache: Cache | null = null;

function cacheFile(): string {
  return join(app.getPath('userData'), 'wheel-insiders.json');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

async function saveCache(): Promise<void> {
  if (!cache) return;
  try {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(cacheFile(), JSON.stringify(cache), 'utf8');
  } catch {
    /* best effort */
  }
}

function isFresh(entry: InsiderSummary | undefined): boolean {
  if (!entry) return false;
  const stamped = Date.parse(`${entry.asOf}T00:00:00Z`);
  return Number.isFinite(stamped) && Date.now() - stamped < CACHE_TTL_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoney(raw: string): number {
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

interface ParsedBuy {
  insider: string;
  title: string;
  value: number;
}

function parseRows(html: string): ParsedBuy[] {
  const tableStart = html.search(/class="tinytable"/);
  if (tableStart < 0) return [];
  const bodyStart = html.indexOf('<tbody>', tableStart);
  if (bodyStart < 0) return [];
  const bodyEnd = html.indexOf('</tbody>', bodyStart);
  const body = html.slice(bodyStart + 7, bodyEnd < 0 ? undefined : bodyEnd);

  const out: ParsedBuy[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(body)) !== null) {
    const cells: string[] = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(row[1])) !== null) cells.push(cell[1]);
    if (cells.length < 12) continue;
    const tradeType = stripTags(cells[6]);
    if (!/^P\b/.test(tradeType)) continue;
    out.push({
      insider: stripTags(cells[4]),
      title: stripTags(cells[5]),
      value: parseMoney(stripTags(cells[11]))
    });
  }
  return out;
}

function summarize(symbol: string, buys: ParsedBuy[]): InsiderSummary {
  const distinct = new Set(buys.map((b) => b.insider.toLowerCase()).filter((n) => n.length > 0));
  let top: ParsedBuy | null = null;
  for (const b of buys) {
    if (!top || b.value > top.value) top = b;
  }
  const topBuyer = top ? (top.title ? `${top.insider} (${top.title})` : top.insider) : null;
  return {
    symbol,
    buyCount30d: buys.length,
    totalValue30d: buys.reduce((s, b) => s + b.value, 0),
    clusterBuy: distinct.size >= 2,
    topBuyer,
    asOf: today()
  };
}

export async function fetchInsiderBuys(symbol: string): Promise<InsiderSummary> {
  const sym = symbol.toUpperCase().trim();
  const url = `https://openinsider.com/screener?s=${encodeURIComponent(sym)}&fd=30&xp=1&cnt=100`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KILL_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`openinsider ${res.status}`);
    const html = await res.text();
    return summarize(sym, parseRows(html));
  } finally {
    clearTimeout(timer);
  }
}

export async function prefetchInsiders(symbols: string[]): Promise<void> {
  if (cache === null) await loadCache();
  cache = cache ?? {};
  const stale: string[] = [];
  for (const raw of symbols) {
    const sym = raw.toUpperCase().trim();
    if (sym && !isFresh(cache[sym])) stale.push(sym);
  }
  let first = true;
  for (const sym of stale) {
    if (!first) await delay(FETCH_DELAY_MS);
    first = false;
    try {
      cache[sym] = await fetchInsiderBuys(sym);
    } catch {
      /* non-fatal: leave any prior entry, render blank for this symbol */
    }
  }
  await saveCache();
}

export async function insiderSummariesToday(): Promise<Record<string, InsiderSummary>> {
  if (cache === null) await loadCache();
  const out: Record<string, InsiderSummary> = {};
  for (const [sym, entry] of Object.entries(cache ?? {})) {
    if (isFresh(entry)) out[sym] = entry;
  }
  return out;
}
