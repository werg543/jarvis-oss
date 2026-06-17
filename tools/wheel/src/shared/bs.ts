/**
 * Minimal Black-Scholes greeks engine. Pure, no dependencies. Used by the
 * interactive course Greeks playground and reusable by the future flow tools
 * (the OptionsFlow blueprints reference this as the shared `bs.ts`).
 *
 * Conventions: t in YEARS, sigma annualized (0.25 = 25% IV), no dividend.
 * vega is per 1.00 vol; theta and charm are returned PER DAY; vanna is
 * per 1.00 vol. The UI scales vega to per-1% for display.
 */

export type OptType = 'C' | 'P';

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number; // per day
  vega: number; // per 1.00 vol
  vanna: number; // d(delta)/d(vol), per 1.00 vol
  charm: number; // d(delta)/d(time), per day
  d1: number;
  d2: number;
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 erf approximation.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  let p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) p = 1 - p;
  return p;
}

export function bsGreeks(
  type: OptType,
  S: number,
  K: number,
  sigma: number,
  tDays: number,
  r = 0
): Greeks {
  const t = Math.max(tDays, 0.0001) / 365;
  const sig = Math.max(sigma, 0.0001);
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(S / K) + (r + 0.5 * sig * sig) * t) / (sig * sqrtT);
  const d2 = d1 - sig * sqrtT;
  const nd1 = normPdf(d1);

  const gamma = nd1 / (S * sig * sqrtT);
  const vega = S * nd1 * sqrtT;
  const vanna = -nd1 * (d2 / sig);

  let price: number;
  let delta: number;
  let thetaYear: number;
  let charmYear: number;

  if (type === 'C') {
    delta = normCdf(d1);
    price = S * delta - K * Math.exp(-r * t) * normCdf(d2);
    thetaYear = -(S * nd1 * sig) / (2 * sqrtT) - r * K * Math.exp(-r * t) * normCdf(d2);
    charmYear = -nd1 * ((2 * r * t - d2 * sig * sqrtT) / (2 * t * sig * sqrtT));
  } else {
    delta = normCdf(d1) - 1;
    price = K * Math.exp(-r * t) * normCdf(-d2) - S * normCdf(-d1);
    thetaYear = -(S * nd1 * sig) / (2 * sqrtT) + r * K * Math.exp(-r * t) * normCdf(-d2);
    charmYear = -nd1 * ((2 * r * t - d2 * sig * sqrtT) / (2 * t * sig * sqrtT));
  }

  return {
    price,
    delta,
    gamma,
    theta: thetaYear / 365,
    vega,
    vanna,
    charm: charmYear / 365,
    d1,
    d2
  };
}
