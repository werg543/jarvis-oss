/**
 * Alpaca client — REST for bars/quotes, WS for live ticks.
 *
 * Reads creds from env: ALPACA_KEY_ID, ALPACA_SECRET, ALPACA_PAPER ("true"/"false").
 */
import Alpaca from '@alpacahq/alpaca-trade-api';
import type { Bar } from '../../shared/types';
import { dteFromIso } from '../../shared/options';

export interface AlpacaConfig {
  keyId: string;
  secret: string;
  paper: boolean;
}

export interface Snapshot {
  /** Best "last close" reference: dailyBar close, else latest trade, else prev close. */
  last: number;
  /** Today's (or most recent) daily bar close, if any. */
  dailyClose: number | null;
  /** Prior trading day's close, if any. */
  prevClose: number | null;
  /** Last printed trade price, if any. */
  latestTrade: number | null;
}

export interface OptionIv {
  /** Near-the-money put IV, as a decimal (e.g. 0.32 = 32%). */
  iv: number;
  /** Strike of the contract the IV was read from. */
  strike: number;
  /** Mid price of that contract, if a quote was available. */
  mid: number | null;
  /** Expiry (YYYY-MM-DD) of the contract used. */
  expiry: string;
}

/** A single REAL listed option contract resolved for a wheel candidate. */
export interface OptionContract {
  /** OCC symbol of the chosen contract. */
  occ: string;
  /** REAL listed expiration date (YYYY-MM-DD). */
  expiry: string;
  /** Days to that expiry. */
  dte: number;
  /** REAL listed strike price. */
  strike: number;
  right: 'P' | 'C';
  /** Latest bid, when quoted. */
  bid: number | null;
  /** Latest ask, when quoted. */
  ask: number | null;
  /** Latest trade price, when printed. */
  last: number | null;
  /**
   * "Latest price at the strike": mid of (bid+ask)/2 when both present, else the
   * latest trade. Null when neither is available (caller treats as no quote).
   */
  price: number | null;
  /** Source of `price`: a two-sided quote mid, or the last trade. */
  priceSource: 'quote' | 'trade' | 'none';
  /** Real implied volatility from the contract greeks, as a decimal. */
  iv: number;
  /** Contract delta from the greeks; null when the feed omits greeks. */
  delta: number | null;
}

interface ParsedOptionSnapshot {
  occ: string;
  expiry: string;
  strike: number;
  right: 'P' | 'C';
  bid: number | null;
  ask: number | null;
  last: number | null;
  iv: number;
  delta: number | null;
}

interface OptionSnapshotFilter {
  right?: 'P' | 'C';
  expGte?: string;
  expLte?: string;
  strikeGte?: number;
  strikeLte?: number;
}

export class AlpacaClient {
  private client: any;
  private keyId: string;
  private secret: string;

  constructor(cfg: AlpacaConfig) {
    this.keyId = cfg.keyId;
    this.secret = cfg.secret;
    this.client = new Alpaca({
      keyId: cfg.keyId,
      secretKey: cfg.secret,
      paper: cfg.paper
    });
  }

  hasCreds(): boolean {
    return this.keyId.trim().length > 0 && this.secret.trim().length > 0;
  }

  /**
   * GET the Alpaca data API with retry on TRANSIENT failures (network throw,
   * 429, 5xx). Non-transient responses (e.g. 401/403/404) return immediately so
   * callers can handle them. Returns null only when every attempt failed to get
   * a response at all.
   */
  private async restGet(url: string): Promise<Response | null> {
    const headers = {
      'APCA-API-KEY-ID': this.keyId,
      'APCA-API-SECRET-KEY': this.secret
    };
    const delays = [0, 500, 1500];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      try {
        const res = await fetch(url, { headers });
        if (res.ok || (res.status !== 429 && res.status < 500)) return res;
      } catch {
        /* network error — retry */
      }
    }
    return null;
  }

  /**
   * Heartbeat probe for the watchdog: confirms the creds still authenticate AND
   * the options feed still carries greeks (the data the wheel depends on). A
   * green creds / red greeks result is the exact signature of the delta-parse
   * class of regression — surfaced loudly instead of silently estimated.
   */
  async feedSelfTest(): Promise<{ credsOk: boolean; greeksOk: boolean }> {
    if (!this.hasCreds()) return { credsOk: false, greeksOk: false };
    const lo = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const hi = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
    const url = `https://data.alpaca.markets/v1beta1/options/snapshots/AAPL?type=put&limit=200&expiration_date_gte=${lo}&expiration_date_lte=${hi}`;
    const res = await this.restGet(url);
    if (!res || !res.ok) return { credsOk: false, greeksOk: false };
    try {
      const data = (await res.json()) as { snapshots?: Record<string, unknown> };
      const snaps = Object.values(data.snapshots ?? {});
      const greeksOk = snaps.some((s) => {
        const d = (s as { greeks?: { delta?: unknown } })?.greeks?.delta;
        return typeof d === 'number' && Number.isFinite(d);
      });
      return { credsOk: true, greeksOk };
    } catch {
      return { credsOk: true, greeksOk: false };
    }
  }

  /** Get historical bars for a symbol. */
  async getBars(symbol: string, timeframe = '1Min', limit = 200): Promise<Bar[]> {
    const start = new Date(Date.now() - lookbackMs(timeframe)).toISOString();
    const bars: Bar[] = [];
    const iter = this.client.getBarsV2(symbol, { start, timeframe, limit });
    for await (const b of iter) {
      bars.push({
        t: new Date(b.Timestamp).getTime(),
        o: b.OpenPrice,
        h: b.HighPrice,
        l: b.LowPrice,
        c: b.ClosePrice,
        v: b.Volume
      });
    }
    return bars;
  }

  /** Get the latest quote for a symbol. */
  async getQuote(symbol: string): Promise<{ bid: number; ask: number; ts: number }> {
    const q = await this.client.getLatestQuote(symbol);
    return { bid: q.BidPrice, ask: q.AskPrice, ts: new Date(q.Timestamp).getTime() };
  }

  /**
   * One-call price snapshot for a symbol. Prefers the daily-bar close for "last
   * close", falling back latest trade -> prior-day close. Uses the SDK snapshot
   * if available, else a direct REST GET (mirrors the getOptionIv REST pattern).
   * Returns null when no usable price is available — callers must EXCLUDE such a
   * name rather than fabricate a price.
   */
  async getSnapshot(symbol: string): Promise<Snapshot | null> {
    let dailyClose: number | null = null;
    let prevClose: number | null = null;
    let latestTrade: number | null = null;

    if (typeof this.client.getSnapshot === 'function') {
      try {
        const s = await this.client.getSnapshot(symbol);
        dailyClose = num(s?.DailyBar?.ClosePrice);
        prevClose = num(s?.PrevDailyBar?.ClosePrice);
        latestTrade = num(s?.LatestTrade?.Price);
      } catch {
        /* fall through to REST */
      }
    }

    if (dailyClose === null && prevClose === null && latestTrade === null) {
      const rest = await this.snapshotRest(symbol);
      if (rest) {
        dailyClose = rest.dailyClose;
        prevClose = rest.prevClose;
        latestTrade = rest.latestTrade;
      }
    }

    const last = dailyClose ?? latestTrade ?? prevClose;
    if (last === null || last <= 0) return null;
    return { last, dailyClose, prevClose, latestTrade };
  }

  /** Direct REST fallback for the stocks snapshot endpoint (no feed param). */
  private async snapshotRest(symbol: string): Promise<{
    dailyClose: number | null;
    prevClose: number | null;
    latestTrade: number | null;
  } | null> {
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(
      symbol
    )}/snapshot`;
    const res = await this.restGet(url);
    if (!res || !res.ok) return null;
    const data = (await res.json()) as {
      dailyBar?: { c?: number };
      prevDailyBar?: { c?: number };
      latestTrade?: { p?: number };
    };
    return {
      dailyClose: num(data.dailyBar?.c),
      prevClose: num(data.prevDailyBar?.c),
      latestTrade: num(data.latestTrade?.p)
    };
  }

  /**
   * Read a near-the-money put IV for `symbol`, picking a contract whose DTE
   * falls in [dteLo, dteHi] (default 14-21, the ~2-3wk wheel window). Uses the
   * SDK option-chain snapshot (free indicative feed); on failure or a missing
   * SDK method, falls back to the options-snapshots REST endpoint.
   */
  async getOptionIv(
    symbol: string,
    spot: number,
    dteLo = 14,
    dteHi = 21
  ): Promise<OptionIv | null> {
    const today = new Date();
    const lo = new Date(today.getTime() + dteLo * 86400000).toISOString().slice(0, 10);
    const hi = new Date(today.getTime() + dteHi * 86400000).toISOString().slice(0, 10);

    type Snap = {
      symbol: string;
      impliedVolatility?: number;
      greeks?: { impliedVolatility?: number };
      latestQuote?: { BidPrice?: number; AskPrice?: number };
    };

    let snaps: Snap[] | null = null;
    if (typeof this.client.getOptionChain === 'function') {
      try {
        const iter = this.client.getOptionChain(symbol, {
          feed: 'indicative',
          type: 'put',
          expiration_date_gte: lo,
          expiration_date_lte: hi,
          strike_price_gte: spot * 0.85,
          strike_price_lte: spot * 1.05,
          totalLimit: 200
        });
        const collected: Snap[] = [];
        for await (const s of iter) collected.push(s as Snap);
        snaps = collected;
      } catch {
        snaps = null;
      }
    }

    if (!snaps || snaps.length === 0) {
      snaps = await this.optionSnapshotsRest(symbol, {
        right: 'P',
        expGte: lo,
        expLte: hi,
        strikeGte: spot * 0.85,
        strikeLte: spot * 1.05
      });
    }
    if (!snaps || snaps.length === 0) return null;

    const candidates = snaps
      .map((s) => ({ s, parsed: parseOcc(s.symbol) }))
      .filter((x) => x.parsed && x.parsed.right === 'P')
      .filter((x) => x.parsed!.expiry >= lo && x.parsed!.expiry <= hi)
      .map((x) => {
        const iv = s_iv(x.s);
        const bid = x.s.latestQuote?.BidPrice ?? 0;
        const ask = x.s.latestQuote?.AskPrice ?? 0;
        const mid = bid && ask ? (bid + ask) / 2 : null;
        return { strike: x.parsed!.strike, expiry: x.parsed!.expiry, iv, mid };
      })
      .filter((x) => x.iv > 0);

    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)
    );
    const best = candidates[0];
    return { iv: best.iv, strike: best.strike, mid: best.mid, expiry: best.expiry };
  }

  /** Direct REST fallback for the options snapshots endpoint. */
  private async optionSnapshotsRest(
    symbol: string,
    filter?: OptionSnapshotFilter
  ): Promise<any[] | null> {
    const raw = await this.allOptionSnapshots(symbol, filter);
    if (!raw) return null;
    return raw.map((r) => ({
      symbol: r.occ,
      impliedVolatility: r.iv,
      greeks: { impliedVolatility: r.iv },
      latestQuote: { BidPrice: r.bid ?? undefined, AskPrice: r.ask ?? undefined }
    }));
  }

  /**
   * Resolve a single REAL listed option contract for a wheel candidate:
   *   1. Among the chain's REAL listed expirations, pick the nearest one whose
   *      DTE falls in [dteLo, dteHi] (the ~2-3wk window). NEVER today+N.
   *   2. Among that expiry's REAL listed strikes of the requested `right`, pick
   *      the one nearest `targetStrike`.
   *   3. Price it: mid of (bid+ask)/2 when both quoted, else the latest trade.
   *      IV is the contract's real greeks IV.
   * Returns null when the underlying has no quotable contract in the window —
   * callers must mark the candidate unavailable, NEVER fabricate a premium.
   */
  async getOptionContract(
    symbol: string,
    right: 'P' | 'C',
    targetStrike: number,
    dteLo = 14,
    dteHi = 28
  ): Promise<OptionContract | null> {
    const today = new Date();
    const expGte = new Date(today.getTime() + dteLo * 86400000).toISOString().slice(0, 10);
    const expLte = new Date(today.getTime() + dteHi * 86400000).toISOString().slice(0, 10);
    const snaps = await this.allOptionSnapshots(symbol, {
      right,
      expGte,
      expLte,
      strikeGte: targetStrike > 0 ? targetStrike * 0.75 : undefined,
      strikeLte: targetStrike > 0 ? targetStrike * 1.25 : undefined
    });
    if (!snaps || snaps.length === 0) return null;

    const inWindow = snaps
      .filter((s) => s.right === right)
      .map((s) => ({ ...s, dte: dteFromIso(s.expiry, today.getTime()) }))
      .filter((s) => s.dte >= dteLo && s.dte <= dteHi);
    if (inWindow.length === 0) return null;

    let nearestDte = Infinity;
    for (const s of inWindow) if (s.dte < nearestDte) nearestDte = s.dte;
    const exp = inWindow.filter((s) => s.dte === nearestDte);
    if (exp.length === 0) return null;

    exp.sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));
    const c = exp[0];

    const hasQuote = c.bid !== null && c.ask !== null && c.bid > 0 && c.ask > 0;
    let price: number | null;
    let priceSource: 'quote' | 'trade' | 'none';
    if (hasQuote) {
      price = Math.round(((c.bid! + c.ask!) / 2) * 100) / 100;
      priceSource = 'quote';
    } else if (c.last !== null && c.last > 0) {
      price = Math.round(c.last * 100) / 100;
      priceSource = 'trade';
    } else {
      price = null;
      priceSource = 'none';
    }

    return {
      occ: c.occ,
      expiry: c.expiry,
      dte: c.dte,
      strike: c.strike,
      right,
      bid: c.bid,
      ask: c.ask,
      last: c.last,
      price,
      priceSource,
      iv: c.iv,
      delta: c.delta
    };
  }

  /**
   * Fetch and page the option-snapshots chain for an underlying, parsed into REAL
   * contracts (expiry/strike/right/bid/ask/last/iv). The optional `filter` is sent
   * as REST query params (type / expiration_date_gte/lte / strike_price_gte/lte) so
   * the server narrows the chain instead of paging the whole book and filtering
   * locally. Returns null on transport failure, [] on empty chain.
   */
  private async allOptionSnapshots(
    symbol: string,
    filter?: OptionSnapshotFilter
  ): Promise<ParsedOptionSnapshot[]> {
    const out: ParsedOptionSnapshot[] = [];
    const params = new URLSearchParams({ limit: '1000' });
    if (filter?.right) params.set('type', filter.right === 'P' ? 'put' : 'call');
    if (filter?.expGte) params.set('expiration_date_gte', filter.expGte);
    if (filter?.expLte) params.set('expiration_date_lte', filter.expLte);
    if (filter?.strikeGte !== undefined)
      params.set('strike_price_gte', (Math.round(filter.strikeGte * 100) / 100).toString());
    if (filter?.strikeLte !== undefined)
      params.set('strike_price_lte', (Math.round(filter.strikeLte * 100) / 100).toString());
    let token: string | null = null;
    let pages = 0;
    do {
      if (token) params.set('page_token', token);
      else params.delete('page_token');
      const url = `https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(
        symbol
      )}?${params.toString()}`;
      let data: { snapshots?: Record<string, any>; next_page_token?: string | null };
      const res = await this.restGet(url);
      if (!res || !res.ok) break;
      try {
        data = (await res.json()) as typeof data;
      } catch {
        break;
      }
      const snaps = data.snapshots ?? {};
      for (const [occ, val] of Object.entries(snaps)) {
        const parsed = parseOcc(occ);
        if (!parsed) continue;
        const v = val as {
          latestQuote?: { bp?: number; ap?: number };
          latestTrade?: { p?: number };
          greeks?: { impliedVolatility?: number; delta?: number };
          impliedVolatility?: number;
        };
        const bid = numOrNull(v.latestQuote?.bp);
        const ask = numOrNull(v.latestQuote?.ap);
        const last = numOrNull(v.latestTrade?.p);
        const iv = v.greeks?.impliedVolatility ?? v.impliedVolatility ?? 0;
        out.push({
          occ,
          expiry: parsed.expiry,
          strike: parsed.strike,
          right: parsed.right,
          bid,
          ask,
          last,
          iv,
          delta: signedOrNull(v.greeks?.delta)
        });
      }
      token = data.next_page_token ?? null;
      pages += 1;
    } while (token && pages < 6);
    return out;
  }
}

/**
 * Lookback window wide enough to satisfy the requested timeframe, with a start
 * date far enough back that bars exist off-hours and on weekends.
 */
function lookbackMs(timeframe: string): number {
  const day = 86400000;
  const tf = timeframe.toLowerCase();
  if (tf.includes('day')) return 200 * day;
  if (tf.includes('hour')) return 30 * day;
  if (tf.includes('15min')) return 5 * day;
  if (tf.includes('5min')) return 5 * day;
  if (tf.includes('min')) return 5 * day;
  return 5 * day;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Like numOrNull but keeps signed values (delta is negative for puts). */
function signedOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function s_iv(s: { impliedVolatility?: number; greeks?: { impliedVolatility?: number } }): number {
  return s.impliedVolatility ?? s.greeks?.impliedVolatility ?? 0;
}

/** Parse an OCC option symbol, e.g. AAPL250718P00190000. */
function parseOcc(
  occ: string
): { expiry: string; right: 'P' | 'C'; strike: number } | null {
  const m = /^[A-Z]+(\d{2})(\d{2})(\d{2})([PC])(\d{8})$/.exec(occ);
  if (!m) return null;
  const [, yy, mm, dd, right, strikeRaw] = m;
  return {
    expiry: `20${yy}-${mm}-${dd}`,
    right: right as 'P' | 'C',
    strike: Number(strikeRaw) / 1000
  };
}
