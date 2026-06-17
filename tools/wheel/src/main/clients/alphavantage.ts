/**
 * Alpha Vantage client — daily bars only, used for local technicals.
 *
 * Reads ALPHAVANTAGE_KEY from env. The free key is 25 requests/DAY and 5/min,
 * so daily bars are fetched AT MOST ONCE PER DAY PER SYMBOL (the WheelEngine
 * caches by date). All indicators are computed locally from those bars — no
 * extra API calls.
 */
import type { Bar } from '../../shared/types';

const BASE = 'https://www.alphavantage.co/query';

export interface DailyTechnicals {
  rsi: number;
  sma20: number;
  sma50: number;
  /** Most recent close. */
  last: number;
  /** Short human label, e.g. "Uptrend / above 50DMA". */
  label: string;
  /** Recent swing-low support level from the daily bars. */
  support: number;
  /** Recent swing-high resistance level from the daily bars. */
  resistance: number;
  /** 0..1, higher = better for selling puts. */
  score: number;
}

export class AlphaVantageClient {
  private key: string;

  constructor(key: string) {
    this.key = key;
  }

  hasKey(): boolean {
    return this.key.trim().length > 0;
  }

  /**
   * Fetch the OVERVIEW fundamentals for a symbol (1 call). Used ONLY to enrich
   * a small set of finalists as a quality gate — never the whole universe — to
   * respect the 25/day free cap. Throws on transport / rate errors.
   */
  async getOverview(symbol: string): Promise<CompanyOverview | null> {
    const url =
      `${BASE}?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}` +
      `&apikey=${encodeURIComponent(this.key)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`alphavantage ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, string>;
    if (data['Note'] || data['Information']) {
      throw new Error(`alphavantage rate-limited: ${data['Note'] ?? data['Information']}`);
    }
    if (!data['Symbol']) return null;
    return {
      symbol: data['Symbol'],
      sector: data['Sector'] ?? '',
      profitMargin: Number(data['ProfitMargin']) || 0,
      peRatio: Number(data['PERatio']) || 0,
      marketCap: Number(data['MarketCapitalization']) || 0
    };
  }
}

export interface CompanyOverview {
  symbol: string;
  sector: string;
  profitMargin: number;
  peRatio: number;
  marketCap: number;
}

function sma(values: number[], period: number): number {
  if (values.length < period) return values.reduce((s, v) => s + v, 0) / values.length;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

/** Compute indicators locally from daily bars. No API calls. */
export function computeTechnicals(bars: Bar[]): DailyTechnicals {
  const closes = bars.map((b) => b.c);
  const last = closes[closes.length - 1] ?? 0;
  const sma20 = Math.round(sma(closes, 20) * 100) / 100;
  const sma50 = Math.round(sma(closes, 50) * 100) / 100;
  const r = rsi(closes, 14);

  const window = bars.slice(-30);
  const support = window.length ? Math.min(...window.map((b) => b.l)) : last;
  const resistance = window.length ? Math.max(...window.map((b) => b.h)) : last;

  const aboveTrend = last > sma50;
  const stacked = sma20 > sma50;

  let label: string;
  let score: number;
  if (aboveTrend && stacked) {
    label = 'Uptrend / above 50DMA';
    score = 0.85;
  } else if (aboveTrend || stacked) {
    label = 'Near support';
    score = 0.6;
  } else {
    label = 'Downtrend — avoid';
    score = 0.2;
  }

  if (r > 70) score -= 0.15;
  else if (r < 35) score += 0.1;
  score = Math.max(0, Math.min(1, score));

  return {
    rsi: r,
    sma20,
    sma50,
    last: Math.round(last * 100) / 100,
    label,
    support: Math.round(support * 100) / 100,
    resistance: Math.round(resistance * 100) / 100,
    score: Math.round(score * 100) / 100
  };
}
