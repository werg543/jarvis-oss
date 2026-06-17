// Shared types used by the wheel screener (main + renderer).

/** OHLCV bar. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Honest data state for the Wheel screener.
 *   - `live`      data-provider creds present, IV rank has real history
 *   - `partial`   some real data, but IV rank is still building (<10 readings)
 *   - `synthetic` no creds / fetch failed; deterministic placeholders shown
 */
export type WheelFeedState = 'live' | 'partial' | 'synthetic';

/**
 * Data-quality snapshot computed on every refresh. The watchdog uses it to
 * decide whether the feed is DEGRADED (returning rows but stripped of the
 * greeks/IV we depend on) and to surface coverage in the UI, so a silent
 * data regression (like the negative-delta parse bug) is loud, not hidden.
 */
export interface WheelHealth {
  /** Rows that resolved a real options contract. */
  optionRows: number;
  /** ...of those, how many carry a real FEED delta. */
  feedDelta: number;
  /** ...how many fell back to a Black-Scholes ESTIMATE. */
  estDelta: number;
  /** ...how many have no delta at all. */
  noDelta: number;
  /** Rows with a real IV reading (>0). */
  feedIv: number;
  /** Watchdog verdict: the feed is returning contracts but missing greeks/IV. */
  degraded: boolean;
  /** Off-session: the watchdog is intentionally idle (closed feed, nothing to watch). */
  idle: boolean;
  /** Human reason when degraded (also logged). */
  note: string | null;
  /** Last credential/greeks self-test result. */
  credsOk: boolean;
  greeksOk: boolean;
  /** Epoch ms of the last heartbeat self-test (0 = never). */
  lastSelfTest: number;
}

/** A single wheel candidate row for the screener (CSP or covered call). */
export interface WheelRow {
  symbol: string;
  /** Bundled sector tag from the scan universe. */
  sector: string;
  last: number;
  iv: number;
  ivRank: number;
  /** True when IV history is too thin for a real rank (proxy in use). */
  ivRankBuilding: boolean;
  technicalLabel: string;
  /** Live RSI from daily technicals; undefined when no current technicals exist. */
  rsi?: number;
  /** 0..1, higher = better for selling puts. */
  technicalScore: number;
  /**
   * Recommended wheel strategy for this candidate:
   *   - 'CSP' cash-secured put (default): a PUT strike below price.
   *   - 'CC'  covered call (buy-write) when oversold at strong support: a CALL
   *           strike above price.
   */
  strategy: 'CSP' | 'CC';
  /**
   * Volume-profile / swing node the strike is anchored to: support below price
   * for a CSP, resistance above price for a CC.
   */
  supportLevel: number;
  /**
   * TA-based recommended strike for whichever strategy applies: a put strike
   * below price for a CSP, a call strike above price for a CC.
   */
  putStrike: number;
  expiry: string;
  /** Days to expiry of the chosen contract (~14-28). */
  dte: number;
  premium: number;
  /** Premium as a % of capital at risk (premium / strike). */
  premiumPct: number;
  annualizedYield: number;
  score: number;
  /** True when any field on this row fell back to synthetic. */
  synthetic: boolean;
  /**
   * Where the premium/strike/expiry came from:
   *   - 'quote' a REAL listed contract: mid of (bid+ask)/2 at a REAL strike.
   *   - 'trade' a REAL listed contract priced off its latest trade (no quote).
   *   - 'none'  no quotable options chain — premium/strike/expiry are unavailable.
   *   - 'synthetic' the whole-screener synthetic fallback (no data-provider creds).
   */
  premiumSource: 'quote' | 'trade' | 'none' | 'synthetic';
  /** False when the candidate has no usable options chain (show as unavailable). */
  optionsAvailable: boolean;
  /** Delta of the recommended contract; null when unavailable. */
  delta: number | null;
  /**
   * Where `delta` came from:
   *   - 'feed' live chain greeks (the real number).
   *   - 'bs'   Black-Scholes estimate — the feed omitted greeks (no live bid),
   *            so this is computed and must be flagged as approximate.
   *   - null   no delta at all.
   */
  deltaSource: 'feed' | 'bs' | null;
}

/** Payload pushed/returned by the wheel engine. */
export interface WheelList {
  rows: WheelRow[];
  /** The finalist candidate symbols surfaced by the last daily scan. */
  watchlist: string[];
  feedState: WheelFeedState;
  lastUpdated: number;
  nextRefresh: number;
  /** Number of universe names scanned in the last daily pass. */
  universeScanned: number;
  /** Epoch ms of the last full daily universe scan. */
  lastDailyScan: number;
  /** Feed data-quality snapshot from the watchdog. */
  health: WheelHealth;
}

/** Insider open-market buying over the trailing 30 days, from SEC Form 4 filings. */
export interface InsiderSummary {
  symbol: string;
  /** Count of open-market purchase (Form 4 "P") filings in the last 30 days. */
  buyCount30d: number;
  /** Summed dollar value of those purchases. */
  totalValue30d: number;
  /** True when >=2 distinct insiders bought within the 30-day window. */
  clusterBuy: boolean;
  /** Name + title of the insider behind the single largest buy, null if none. */
  topBuyer: string | null;
  /** ISO date the summary was produced (cache stamp). */
  asOf: string;
}

/** One key fundamental metric (label + short value string + plain-English def). */
export interface WheelFundamental {
  label: string;
  value: string;
  /** Short plain-English definition of the term, shown as a hover tooltip. */
  def?: string;
}

/** Next-earnings / assignment-risk block for a wheel candidate. */
export interface WheelEarnings {
  /** Next earnings date, '' when unknown. */
  nextDate: string;
  /** True when earnings land before the ~2-3 week expiry (assignment risk). */
  beforeExpiry: boolean;
  /** Short assignment-risk note. */
  note: string;
}

/** Wheel verdict: a rating, a one-line summary, and key risks. */
export interface WheelVerdict {
  rating: 'favorable' | 'caution' | 'avoid';
  summary: string;
  risks: string[];
}

/** One significant recent-news item: a plain-English note with its source. */
export interface WheelNewsItem {
  /** 1-2 sentence plain-English note of what happened and why it matters (not a headline). */
  note: string;
  /** Date or rough timeframe of the item ('' if unknown). */
  date: string;
  /** Source name, e.g. "Reuters", "Bloomberg". */
  source: string;
  /** Link to the source article ('' if none). */
  url: string;
}

/** Structured fundamental payload rendered by the analysis view. */
export interface WheelAnalysisData {
  companyName: string;
  /** 2-3 sentence plain-English description of the business. Leads the page. */
  whatItDoes: string;
  fundamentals: WheelFundamental[];
  earnings: WheelEarnings;
  catalysts: string[];
  verdict: WheelVerdict;
  /** 1-2 sentence technical read (trend / support / momentum), shown with the verdict. */
  technical: string;
  /** Significant recent news (~last 4 weeks) with sources; [] if nothing material. */
  recentNews: WheelNewsItem[];
}

/** On-demand fundamental breakdown for one wheel candidate. */
export interface WheelAnalysis {
  symbol: string;
  /** True when the headless analysis returned a usable structured payload. */
  ok: boolean;
  /** Structured breakdown produced by the headless analysis call. */
  data?: WheelAnalysisData;
  /** Raw markdown fallback rendered plainly when JSON parsing fails. */
  markdown?: string;
  /** Epoch ms the analysis was produced. */
  fetchedAt: number;
  /** Human-readable note when the analysis failed. */
  error?: string;
}
