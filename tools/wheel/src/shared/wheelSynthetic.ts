// Deterministic synthetic wheel data — the graceful fallback used when keys or
// live data are missing. Shared by main (engine fallback) and renderer (banner).

import type { WheelRow } from './types';

export const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'SPY'];

/** Target DTE for the chosen contract: ~2-3 weeks out. */
export const WHEEL_DTE = 17;

const SYNTHETIC_SECTORS: Record<string, string> = {
  AAPL: 'Technology',
  MSFT: 'Technology',
  NVDA: 'Technology',
  AMD: 'Technology',
  SPY: 'ETF'
};

function syntheticSector(symbol: string): string {
  if (SYNTHETIC_SECTORS[symbol]) return SYNTHETIC_SECTORS[symbol];
  const sectors = [
    'Technology',
    'Financials',
    'Consumer Discretionary',
    'Industrials',
    'Energy',
    'Communication Services',
    'Materials'
  ];
  return sectors[Math.floor(hash(symbol + ':sector') * sectors.length)];
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function expiryFor(dte: number): string {
  const d = new Date(Date.now() + dte * 86400000);
  return d.toISOString().slice(0, 10);
}

function syntheticTech(symbol: string): { label: string; rsi: number; techScore: number } {
  const t = hash(symbol + ':tech');
  const rsi = Math.round(28 + t * 52);
  if (t > 0.66) return { label: 'Uptrend / above 50DMA', rsi, techScore: 0.85 };
  if (t > 0.33) return { label: 'Near support', rsi, techScore: 0.6 };
  return { label: 'Downtrend — avoid', rsi, techScore: 0.2 };
}

export function syntheticRow(symbol: string): WheelRow {
  const p = hash(symbol + ':price');
  const last = Math.round((40 + p * 460) * 100) / 100;
  const ivRank = Math.round(hash(symbol + ':ivr') * 100);
  const iv = Math.round((0.18 + hash(symbol + ':iv') * 0.6) * 1000) / 1000;
  const tech = syntheticTech(symbol);

  const putStrike = Math.round(last * (0.9 - 0.05 * tech.techScore));
  const supportLevel = Math.round(putStrike * 1.01 * 100) / 100;
  const premium = Math.round(putStrike * (0.012 + (ivRank / 100) * 0.03) * 100) / 100;
  const premiumPct = Math.round((premium / putStrike) * 10000) / 100;
  const annualizedYield = Math.round((premium / putStrike) * (365 / WHEEL_DTE) * 10000) / 100;
  const score = Math.round((ivRank * 0.6 + tech.techScore * 100 * 0.4) * 10) / 10;

  return {
    symbol,
    sector: syntheticSector(symbol),
    last,
    iv,
    ivRank,
    ivRankBuilding: true,
    technicalLabel: tech.label,
    rsi: tech.rsi,
    technicalScore: tech.techScore,
    strategy: 'CSP',
    supportLevel,
    putStrike,
    expiry: expiryFor(WHEEL_DTE),
    dte: WHEEL_DTE,
    premium,
    premiumPct,
    annualizedYield,
    score,
    synthetic: true,
    premiumSource: 'synthetic',
    optionsAvailable: true,
    delta: null,
    deltaSource: null
  };
}

export function syntheticList(watchlist: string[]): WheelRow[] {
  return watchlist.map(syntheticRow).sort((a, b) => b.score - a.score);
}
