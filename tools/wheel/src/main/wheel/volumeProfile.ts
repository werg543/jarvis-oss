/**
 * Volume-at-price profile from intraday bars (sourced from Alpaca IEX, NOT
 * Alpha Vantage, to protect the AV daily cap). Buckets bar volume into price
 * bins, finds the POC, the ~70% value area, and the nearest high-volume support
 * node below the current price. The wheel anchors its put strike to that node.
 */
import type { Bar } from '../../shared/types';

export interface VolumeProfile {
  poc: number;
  valueAreaHigh: number;
  valueAreaLow: number;
  /** Nearest high-volume node below current price (the put-strike anchor). */
  support: number;
  /** Nearest high-volume node above current price (the call-strike anchor). */
  resistance: number;
  /** Number of price bins used. */
  bins: number;
}

export function computeVolumeProfile(bars: Bar[], last: number, binCount = 50): VolumeProfile | null {
  if (bars.length === 0 || last <= 0) return null;

  const lows = bars.map((b) => b.l);
  const highs = bars.map((b) => b.h);
  const lo = Math.min(...lows, last);
  const hi = Math.max(...highs, last);
  if (hi <= lo) return null;

  const step = (hi - lo) / binCount;
  const vol = new Array<number>(binCount).fill(0);

  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    let idx = Math.floor((typical - lo) / step);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    vol[idx] += b.v;
  }

  const priceAt = (i: number): number => lo + (i + 0.5) * step;

  let pocIdx = 0;
  for (let i = 1; i < binCount; i++) if (vol[i] > vol[pocIdx]) pocIdx = i;

  const total = vol.reduce((s, v) => s + v, 0);
  let included = vol[pocIdx];
  let loIdx = pocIdx;
  let hiIdx = pocIdx;
  while (included < total * 0.7 && (loIdx > 0 || hiIdx < binCount - 1)) {
    const below = loIdx > 0 ? vol[loIdx - 1] : -1;
    const above = hiIdx < binCount - 1 ? vol[hiIdx + 1] : -1;
    if (above >= below) {
      hiIdx += 1;
      included += vol[hiIdx];
    } else {
      loIdx -= 1;
      included += vol[loIdx];
    }
  }

  const lastIdx = Math.min(binCount - 1, Math.max(0, Math.floor((last - lo) / step)));
  let supportIdx = -1;
  let supportVol = -1;
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (vol[i] > supportVol) {
      supportVol = vol[i];
      supportIdx = i;
    }
  }
  const support = supportIdx >= 0 ? priceAt(supportIdx) : priceAt(loIdx);

  let resistanceIdx = -1;
  let resistanceVol = -1;
  for (let i = lastIdx + 1; i < binCount; i++) {
    if (vol[i] > resistanceVol) {
      resistanceVol = vol[i];
      resistanceIdx = i;
    }
  }
  const resistance = resistanceIdx >= 0 ? priceAt(resistanceIdx) : priceAt(hiIdx);

  return {
    poc: Math.round(priceAt(pocIdx) * 100) / 100,
    valueAreaHigh: Math.round(priceAt(hiIdx) * 100) / 100,
    valueAreaLow: Math.round(priceAt(loIdx) * 100) / 100,
    support: Math.round(support * 100) / 100,
    resistance: Math.round(resistance * 100) / 100,
    bins: binCount
  };
}

function strikeIncrement(price: number): number {
  if (price < 25) return 0.5;
  if (price < 100) return 1;
  if (price < 250) return 2.5;
  return 5;
}

/** Round a raw price down to a sensible option strike increment. */
export function roundToStrike(price: number): number {
  const inc = strikeIncrement(price);
  return Math.floor(price / inc) * inc;
}

/** Round a raw price up to a sensible option strike increment. */
export function roundToStrikeUp(price: number): number {
  const inc = strikeIncrement(price);
  return Math.ceil(price / inc) * inc;
}

/**
 * TA-based cash-secured-put strike, placed 10-15% OTM. Anchors to a support
 * level below price (volume-profile node or swing low) when it falls inside the
 * band; otherwise clamps to the band edge. The band itself slides with IV:
 * low-IV names sit near 10% OTM, high-IV / fatter-premium names near 15% OTM,
 * interpolated linearly over IV in [0.30, 0.80]. Rounds down to a real strike
 * increment and keeps it a put (entry leg) below spot.
 */
export function recommendStrike(last: number, support: number, iv = 0): number {
  const maxStrike = last * 0.9; // 10% OTM
  const minStrike = last * 0.85; // 15% OTM
  const ivClamped = Math.max(0.3, Math.min(0.8, iv > 0 ? iv : 0.3));
  const ivFrac = (ivClamped - 0.3) / (0.8 - 0.3);
  const anchorPct = 0.1 + ivFrac * 0.05;
  let raw = support > 0 && support < last ? support : last * (1 - anchorPct);
  if (raw > maxStrike) raw = maxStrike;
  if (raw < minStrike) raw = minStrike;
  return roundToStrike(raw);
}

/**
 * TA-based covered-call (buy-write) strike, placed 5-12% OTM ABOVE price.
 * Mirrors recommendStrike: anchors to a resistance level above price (volume-
 * profile node) when it falls inside the band; otherwise clamps to the band
 * edge, with the anchor sliding from 5% OTM at low IV to 12% OTM at high IV.
 * Rounds up to a real strike increment and keeps it a call above spot.
 */
export function recommendCallStrike(last: number, resistance: number, iv = 0): number {
  const minStrike = last * 1.05; // 5% OTM
  const maxStrike = last * 1.12; // 12% OTM
  const ivClamped = Math.max(0.3, Math.min(0.8, iv > 0 ? iv : 0.3));
  const ivFrac = (ivClamped - 0.3) / (0.8 - 0.3);
  const anchorPct = 0.05 + ivFrac * 0.07;
  let raw = resistance > last ? resistance : last * (1 + anchorPct);
  if (raw < minStrike) raw = minStrike;
  if (raw > maxStrike) raw = maxStrike;
  return roundToStrikeUp(raw);
}
