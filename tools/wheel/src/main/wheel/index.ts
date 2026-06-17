/**
 * WheelEngine — a DAILY IV SCREENER for the options wheel.
 *
 * Pipeline (filter order):
 *   1. UNIVERSE   — bundled static list of liquid, optionable names (universe.ts).
 *   2. IV TOP 100 — fetch IV per name, sort desc, take the top 100. Honest
 *                   framing: "top 100 IV within the SCANNED universe" — no free
 *                   feed ranks the entire market.
 *   3. EXCLUDE    — drop binary/event plays only: the static binary list + a
 *                   binary-risk heuristic (small/micro cap AND very high IV).
 *                   Large-cap healthcare is KEPT.
 *   4. TECHNICALS — daily bars + local technicals; drop downtrends / overbought.
 *   5. FUNDAMENTAL— bundled sector + capTier as the free baseline; optionally
 *                   enrich <=20 finalists with Alpha Vantage OVERVIEW (1 call
 *                   each) for a profitability gate, within the 25/day AV cap.
 *   6. RANK       — composite score (IV rank + technical) -> surfaced top N.
 *
 * Cadence: the heavy full-universe scan runs ONCE PER DAY (cached in userData,
 * keyed by date). The surfaced finalists then refresh IV + premium every 30 min
 * from market open via the same msToNextSlot scheduler. No streaming; never
 * touches the broker L2 feed.
 *
 * Score = 0.6 * ivRankNorm + 0.4 * technicalScore.
 *
 * Synthetic fallback: when Alpaca creds are missing the whole screener runs off
 * the wheelSynthetic helpers over the universe, with an honest feed banner.
 */
import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AlpacaClient, OptionContract } from '../clients/alpaca';
import {
  AlphaVantageClient,
  computeTechnicals,
  type DailyTechnicals,
  type CompanyOverview
} from '../clients/alphavantage';
import { computeVolumeProfile, recommendStrike, recommendCallStrike } from './volumeProfile';
import { prefetchInsiders } from './insiders';
import { syntheticRow } from '../../shared/wheelSynthetic';
import { bsGreeks } from '../../shared/bs';
import {
  UNIVERSE,
  UNIVERSE_SYMBOLS,
  BINARY_EXCLUSIONS,
  universeMeta,
  type UniverseName
} from './universe';
import type { WheelRow, WheelList, WheelFeedState, WheelHealth } from '../../shared/types';

const EMPTY_HEALTH: WheelHealth = {
  optionRows: 0,
  feedDelta: 0,
  estDelta: 0,
  noDelta: 0,
  feedIv: 0,
  degraded: false,
  idle: false,
  note: null,
  credsOk: false,
  greeksOk: false,
  lastSelfTest: 0
};

const RECOVERY_DELAY_MS = 45 * 1000;
const MAX_RECOVERY = 2;

const IV_HISTORY_WINDOW = 252;
const IV_HISTORY_MIN = 30;

const IV_TOP_N = 100;
const SURFACE_N = 40;
const FUNDAMENTAL_ENRICH_MAX = 20;

const DTE_LO = 14;
const DTE_HI = 21;
const TARGET_DTE = 17;

// Binary-risk heuristic: a small/micro-cap whose IV clears this clears the bar
// for "event/binary play" and gets dropped.
const BINARY_IV_THRESHOLD = 0.9;

// Covered-call signal: when a name is OVERSOLD (RSI at/below OVERSOLD_RSI) AND
// trading NEAR strong support (within NEAR_SUPPORT_PCT above the support node),
// it's a bounce setup — recommend a buy-write (call above price) instead of a
// CSP. Both thresholds are adjustable here.
const OVERSOLD_RSI = 35;
const NEAR_SUPPORT_PCT = 0.05;

const MKT_OPEN_MIN = 9 * 60 + 30;
const MKT_CLOSE_MIN = 16 * 60;
const SLOT_STEP_MIN = 30;

// The heavy full-universe scan runs at these ET times during the session (once
// or twice a day). msToNextSlot wakes on every :00/:30, so these line up.
const SCAN_SLOTS_ET = [10 * 60, 14 * 60];

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

function etWall(now: Date): Date {
  const parts = ET_PARTS.formatToParts(now);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  let hour = get('hour');
  if (hour === 24) hour = 0;
  return new Date(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'), 0);
}

function atMinute(base: Date, dayOffset: number, minute: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return d;
}

function nextSessionOpen(et: Date): Date {
  const d = atMinute(et, 1, MKT_OPEN_MIN);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * ms from now to the next 30-min slot within the regular session (09:30-16:00
 * ET), aligned to market open; outside the session, to the next session open.
 */
function msToNextSlot(now: Date): number {
  const et = etWall(now);
  const dow = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  const weekday = dow >= 1 && dow <= 5;
  let target: Date;
  if (weekday && mins < MKT_CLOSE_MIN) {
    if (mins < MKT_OPEN_MIN) {
      target = atMinute(et, 0, MKT_OPEN_MIN);
    } else {
      let slot = MKT_OPEN_MIN;
      while (slot <= mins) slot += SLOT_STEP_MIN;
      target = slot <= MKT_CLOSE_MIN ? atMinute(et, 0, slot) : nextSessionOpen(et);
    }
  } else {
    target = nextSessionOpen(et);
  }
  return Math.max(1000, target.getTime() - et.getTime());
}

interface TechCacheEntry {
  date: string; // YYYY-MM-DD the bars were fetched
  tech: DailyTechnicals;
}
type TechCache = Record<string, TechCacheEntry>;

interface IvReading {
  date: string;
  iv: number;
}
type IvHistory = Record<string, IvReading[]>;

interface OverviewCacheEntry {
  date: string;
  overview: CompanyOverview | null;
}
type OverviewCache = Record<string, OverviewCacheEntry>;

/** Persisted daily scan: which finalists were chosen and when. */
interface ScanState {
  date: string;
  scannedAt: number;
  universeScanned: number;
  finalists: string[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    /* corrupt cache — start fresh */
  }
  return fallback;
}

function saveJson(path: string, data: unknown): void {
  try {
    writeFileSync(path, JSON.stringify(data), 'utf8');
  } catch {
    /* best effort */
  }
}

export class WheelEngine {
  private alpaca: AlpacaClient;
  private av: AlphaVantageClient;
  private timer: NodeJS.Timeout | null = null;
  private selfTest = { credsOk: false, greeksOk: false, ts: 0 };
  // Daily-bars refresh health: counts technicals that had to refetch and how many
  // failed, so the watchdog can flag a stale-price condition (bars feed down).
  private barsHealth = { tried: 0, failed: 0 };
  private recoveryPending = false;
  private recoveryAttempts = 0;
  private last: WheelList;
  private refreshing: Promise<WheelList> | null = null;
  private listeners = new Set<(list: WheelList) => void>();
  private techCachePath: string;
  private ivHistoryPath: string;
  private overviewCachePath: string;
  private scanStatePath: string;

  constructor(alpaca: AlpacaClient, av: AlphaVantageClient) {
    this.alpaca = alpaca;
    this.av = av;
    const dir = app.getPath('userData');
    this.techCachePath = join(dir, 'wheel-cache.json');
    this.ivHistoryPath = join(dir, 'wheel-iv-history.json');
    this.overviewCachePath = join(dir, 'wheel-overview.json');
    this.scanStatePath = join(dir, 'wheel-scan.json');
    this.last = {
      rows: [],
      watchlist: [],
      feedState: 'synthetic',
      lastUpdated: 0,
      nextRefresh: 0,
      universeScanned: 0,
      lastDailyScan: 0,
      health: EMPTY_HEALTH
    };
  }

  start(): void {
    if (this.timer) return;
    void this.refresh(true); // force a fresh scan on launch
    this.scheduleNext(); // then snap to the wall-clock :00/:30 slots
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** True during the NY stock session (Mon-Fri 09:30-16:00 ET). */
  private inSession(now = new Date()): boolean {
    const et = etWall(now);
    const dow = et.getDay();
    const mins = et.getHours() * 60 + et.getMinutes();
    return dow >= 1 && dow <= 5 && mins >= MKT_OPEN_MIN && mins < MKT_CLOSE_MIN;
  }

  /** Self-test the feed (creds + greeks). Runs as part of each refresh pulse. */
  private async runSelfTest(): Promise<void> {
    try {
      const r = await this.alpaca.feedSelfTest();
      this.selfTest = { credsOk: r.credsOk, greeksOk: r.greeksOk, ts: Date.now() };
      if (this.alpaca.hasCreds() && (!r.credsOk || !r.greeksOk)) {
        console.warn(
          `[wheel] feed self-test: creds=${r.credsOk} greeks=${r.greeksOk} — feed degraded`
        );
      }
    } catch (e) {
      console.warn('[wheel] feed self-test threw', e);
    }
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.scheduleNext());
    }, msToNextSlot(new Date()));
  }

  onUpdate(cb: (list: WheelList) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getList(): WheelList {
    return this.last;
  }

  /** Manual refresh from the UI — forces a fresh daily scan. */
  setWatchlist(_symbols: string[]): WheelList {
    void this.refresh(true);
    return this.last;
  }

  /**
   * Refresh entrypoint. The heavy full-universe scan runs only at the NY-session
   * scan slots (SCAN_SLOTS_ET, once or twice a day), on first-ever run, or when
   * `force` is set. Every other 30-min wake just refreshes IV + premium for the
   * already-surfaced finalists. Off-session it never runs the heavy scan.
   */
  async refresh(force = false): Promise<WheelList> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.runRefresh(force).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(force: boolean): Promise<WheelList> {
    if (!this.alpaca.hasCreds()) {
      return this.refreshSynthetic();
    }

    // Pulse the feed self-test with every data refresh so the watchdog assesses
    // health against a fresh creds/greeks probe. Off-session the feed is closed
    // and there's nothing to watch, so the watchdog stays idle (no probe).
    if (this.inSession()) await this.runSelfTest();

    const scan = loadJson<ScanState | null>(this.scanStatePath, null);
    const now = new Date();
    const et = etWall(now);
    const weekday = et.getDay() >= 1 && et.getDay() <= 5;
    const mins = et.getHours() * 60 + et.getMinutes();
    const inSession = weekday && mins >= MKT_OPEN_MIN && mins < MKT_CLOSE_MIN;

    let dueScan = false;
    if (inSession) {
      const passed = SCAN_SLOTS_ET.filter((s) => s <= mins);
      if (passed.length) {
        const lastSlot = Math.max(...passed);
        const slotEpoch = atMinute(et, 0, lastSlot).getTime() - et.getTime() + now.getTime();
        dueScan = !scan || scan.date !== today() || scan.scannedAt < slotEpoch;
      }
    }

    const needDailyScan = force || !scan || scan.finalists.length === 0 || dueScan;

    if (needDailyScan) {
      return this.runDailyScan();
    }
    return this.refreshFinalists(scan);
  }

  // --- Synthetic path ------------------------------------------------------

  private refreshSynthetic(): WheelList {
    const finalists = UNIVERSE.filter((u) => !BINARY_EXCLUSIONS.has(u.symbol))
      .map((u) => syntheticRow(u.symbol))
      .sort((a, b) => b.score - a.score)
      .slice(0, SURFACE_N);
    const now = Date.now();
    this.last = {
      rows: finalists,
      watchlist: finalists.map((r) => r.symbol),
      feedState: 'synthetic',
      lastUpdated: now,
      nextRefresh: now + msToNextSlot(new Date(now)),
      universeScanned: UNIVERSE_SYMBOLS.length,
      lastDailyScan: now,
      health: { ...EMPTY_HEALTH, note: 'synthetic — no Alpaca credentials' }
    };
    this.emit();
    return this.last;
  }

  // --- Daily full-universe scan -------------------------------------------

  private async runDailyScan(): Promise<WheelList> {
    const techCache = loadJson<TechCache>(this.techCachePath, {});
    const ivHistory = loadJson<IvHistory>(this.ivHistoryPath, {});
    const overviewCache = loadJson<OverviewCache>(this.overviewCachePath, {});

    // Stage 2: fetch IV for every universe name, keep the ones we got IV for.
    interface Scanned {
      meta: UniverseName;
      iv: number;
      last: number;
    }
    const scanned: Scanned[] = [];
    for (const meta of UNIVERSE) {
      try {
        const snap = await this.alpaca.getSnapshot(meta.symbol);
        if (!snap || snap.last <= 0) continue;
        const spot = snap.last;
        const opt = await this.alpaca.getOptionIv(meta.symbol, spot, DTE_LO, DTE_HI);
        if (!opt || opt.iv <= 0) continue;
        scanned.push({ meta, iv: opt.iv, last: spot });
        this.recordIv(meta.symbol, opt.iv, ivHistory);
      } catch {
        /* skip names we can't price */
      }
    }

    // Stage 2 cont.: rank by IV desc, take the top 100 of the SCANNED universe.
    scanned.sort((a, b) => b.iv - a.iv);
    const topIv = scanned.slice(0, IV_TOP_N);

    // Stage 3: exclude binary/event plays only (large-cap healthcare is kept).
    const afterExclusion = topIv.filter((s) => {
      if (BINARY_EXCLUSIONS.has(s.meta.symbol)) return false;
      const smallCap = s.meta.capTier === 'small' || s.meta.capTier === 'micro';
      if (smallCap && s.iv >= BINARY_IV_THRESHOLD) return false;
      return true;
    });

    // Stage 4: technicals — daily bars (cached once/day), drop the weak ones.
    interface Survivor extends Scanned {
      tech: DailyTechnicals;
      support: number;
      resistance: number;
    }
    const survivors: Survivor[] = [];
    this.barsHealth = { tried: 0, failed: 0 };
    for (const s of afterExclusion) {
      const tech = await this.technicalsFor(s.meta.symbol, techCache);
      if (!tech) continue;
      // Drop confirmed downtrends and overbought names.
      if (tech.score <= 0.25) continue;
      if (tech.rsi >= 75) continue;
      let support = tech.support;
      let resistance = 0;
      try {
        const intraday = await this.alpaca.getBars(s.meta.symbol, '15Min', 300);
        if (intraday.length) {
          const vp = computeVolumeProfile(intraday, s.last);
          if (vp) {
            support = vp.support;
            resistance = vp.resistance;
          }
        }
      } catch {
        /* keep technical-derived support */
      }
      survivors.push({ ...s, tech, support, resistance });
    }

    // Stage 6 (pre-rank): composite score with no contract yet, take the top N.
    // Resolving real options is the expensive part, so we score+cut FIRST, then
    // fetch REAL contracts only for the ~SURFACE_N finalists (rate-limit budget).
    const preRanked = survivors
      .map((s) => ({
        s,
        row: this.buildRow(s.meta, s.last, s.iv, s.tech, s.support, s.resistance, ivHistory, null)
      }))
      .sort((a, b) => b.row.score - a.row.score)
      .slice(0, SURFACE_N);

    const ranked: WheelRow[] = [];
    for (const { s } of preRanked) {
      const strategy = this.strategyFor(s.tech.rsi, s.last, s.support);
      const contract = await this.resolveContract(
        s.meta.symbol,
        s.last,
        s.iv,
        strategy,
        s.support,
        s.resistance
      );
      const realIv = contract && contract.iv > 0 ? contract.iv : s.iv;
      if (contract && contract.iv > 0) this.recordIv(s.meta.symbol, contract.iv, ivHistory);
      ranked.push(
        this.buildRow(s.meta, s.last, realIv, s.tech, s.support, s.resistance, ivHistory, contract)
      );
    }
    ranked.sort((a, b) => b.score - a.score);

    // Stage 5: OPTIONAL fundamentals enrichment on the FINALISTS only. Skipped
    // unless an AV key is present and we're inside the daily call budget.
    if (this.av.hasKey()) {
      await this.enrichFundamentals(ranked, overviewCache);
    }

    saveJson(this.techCachePath, techCache);
    saveJson(this.ivHistoryPath, ivHistory);
    saveJson(this.overviewCachePath, overviewCache);

    const finalists = ranked.map((r) => r.symbol);
    void prefetchInsiders(finalists);
    const now = Date.now();
    const scanState: ScanState = {
      date: today(),
      scannedAt: now,
      universeScanned: scanned.length,
      finalists
    };
    saveJson(this.scanStatePath, scanState);

    this.publish(ranked, scanned.length, now);
    return this.last;
  }

  // --- 30-min finalist refresh --------------------------------------------

  private async refreshFinalists(scan: ScanState): Promise<WheelList> {
    const techCache = loadJson<TechCache>(this.techCachePath, {});
    const ivHistory = loadJson<IvHistory>(this.ivHistoryPath, {});

    const rows: WheelRow[] = [];
    for (const symbol of scan.finalists) {
      const meta = universeMeta(symbol) ?? { symbol, sector: 'Unknown', theme: 'Unknown', capTier: 'mid' as const };
      try {
        const snap = await this.alpaca.getSnapshot(symbol);
        if (!snap || snap.last <= 0) continue;
        const last = snap.last;
        let support = 0;
        let resistance = 0;
        try {
          const intraday = await this.alpaca.getBars(symbol, '15Min', 300);
          if (intraday.length) {
            const vp = computeVolumeProfile(intraday, last);
            if (vp) {
              support = vp.support;
              resistance = vp.resistance;
            }
          }
        } catch {
          /* fall through */
        }
        const tech = await this.technicalsFor(symbol, techCache);
        if (support <= 0) support = tech?.support ?? 0;
        if (resistance <= 0) resistance = tech?.resistance ?? 0;
        const strategy = this.strategyFor(tech?.rsi, last, support);
        const contract = await this.resolveContract(
          symbol,
          last,
          0,
          strategy,
          support,
          resistance
        );
        let iv = contract && contract.iv > 0 ? contract.iv : 0;
        if (iv <= 0) {
          try {
            const opt = await this.alpaca.getOptionIv(symbol, last, DTE_LO, DTE_HI);
            if (opt && opt.iv > 0) iv = opt.iv;
          } catch {
            /* fall through to history */
          }
        }
        if (iv > 0) this.recordIv(symbol, iv, ivHistory);
        if (iv <= 0) {
          const hist = ivHistory[symbol];
          if (hist && hist.length) iv = hist[hist.length - 1].iv;
        }
        rows.push(this.buildRow(meta, last, iv, tech, support, resistance, ivHistory, contract));
      } catch {
        /* can't price this real name from Alpaca — exclude it, never fake it */
      }
    }

    saveJson(this.techCachePath, techCache);
    saveJson(this.ivHistoryPath, ivHistory);

    rows.sort((a, b) => b.score - a.score);
    this.publish(rows, scan.universeScanned, scan.scannedAt);
    return this.last;
  }

  // --- Row construction ----------------------------------------------------

  private buildRow(
    meta: UniverseName | { symbol: string; sector: string; theme: string; capTier: string },
    last: number,
    iv: number,
    tech: DailyTechnicals | null,
    support: number,
    resistance: number,
    ivHistory: IvHistory,
    contract: OptionContract | null
  ): WheelRow {
    const symbol = meta.symbol;
    if (last <= 0) return syntheticRow(symbol);

    // Strategy is chosen on technicals; the strike target follows from it, and
    // the REAL contract (expiry/strike/premium/IV) is resolved upstream against
    // that target. No synthetic premium for a real candidate.
    const fallback = syntheticRow(symbol);
    const technicalScore = tech?.score ?? fallback.technicalScore;
    const technicalLabel = tech?.label ?? fallback.technicalLabel;
    const rsi = tech?.rsi;

    // Covered-call signal: oversold AND near/just above strong support.
    const nearSupport = support > 0 && (last - support) / last <= NEAR_SUPPORT_PCT;
    const strategy: WheelRow['strategy'] =
      rsi !== undefined && rsi <= OVERSOLD_RSI && nearSupport ? 'CC' : 'CSP';

    // Real contract IV takes priority over the scan-stage near-the-money IV.
    const effectiveIv = contract && contract.iv > 0 ? contract.iv : iv;
    const { ivRank, building } = this.ivRankFor(symbol, effectiveIv, ivHistory);

    const anchor = strategy === 'CC' ? resistance : support;

    const optionsAvailable = !!(contract && contract.price !== null && contract.price > 0);

    let recStrike: number;
    let expiry: string;
    let dte: number;
    let premium: number;
    let premiumPct: number;
    let annualizedYield: number;
    let premiumSource: WheelRow['premiumSource'];

    if (optionsAvailable) {
      recStrike = contract!.strike;
      expiry = contract!.expiry;
      dte = contract!.dte;
      premium = contract!.price!;
      premiumSource = contract!.priceSource === 'trade' ? 'trade' : 'quote';
      const basis = strategy === 'CC' ? last : recStrike;
      premiumPct = Math.round((premium / basis) * 10000) / 100;
      annualizedYield =
        dte > 0 ? Math.round((premium / basis) * (365 / dte) * 10000) / 100 : 0;
    } else {
      recStrike = strategy === 'CC'
        ? recommendCallStrike(last, resistance, iv)
        : recommendStrike(last, support, iv);
      expiry = '';
      dte = 0;
      premium = 0;
      premiumPct = 0;
      annualizedYield = 0;
      premiumSource = 'none';
    }

    const ivRankNorm = ivRank / 100;
    const score = Math.round((0.6 * ivRankNorm + 0.4 * technicalScore) * 1000) / 10;

    const synthetic = !tech && effectiveIv === 0;

    // Delta from the live chain greeks when present (the real number). Alpaca
    // only attaches greeks to contracts with a live two-sided quote, so thin OTM
    // wheel strikes often arrive greekless. When that happens, compute a
    // Black-Scholes estimate but TAG it 'bs' so the UI flags it as approximate
    // (show the value, never pass an estimate off as feed data).
    let delta: number | null = contract?.delta ?? null;
    let deltaSource: WheelRow['deltaSource'] = delta != null ? 'feed' : null;
    if (delta == null && optionsAvailable && effectiveIv > 0 && dte > 0) {
      delta = bsGreeks(strategy === 'CC' ? 'C' : 'P', last, recStrike, effectiveIv, dte).delta;
      deltaSource = 'bs';
    }

    return {
      symbol,
      sector: meta.theme,
      last: Math.round(last * 100) / 100,
      iv: Math.round(effectiveIv * 1000) / 1000,
      ivRank,
      ivRankBuilding: building,
      technicalLabel,
      rsi,
      technicalScore,
      strategy,
      supportLevel: Math.round(anchor * 100) / 100,
      putStrike: recStrike,
      expiry,
      dte,
      premium,
      premiumPct,
      annualizedYield,
      score,
      synthetic,
      premiumSource,
      optionsAvailable,
      delta,
      deltaSource
    };
  }

  /**
   * Resolve the REAL contract for a candidate against the strategy's target
   * strike: a put ~10-15% OTM below support for a CSP, a call ~5-12% OTM above
   * resistance for a CC. Returns null when no quotable contract exists in the
   * 14-28 DTE window, so the row is marked unavailable rather than fabricated.
   */
  private async resolveContract(
    symbol: string,
    last: number,
    iv: number,
    strategy: WheelRow['strategy'],
    support: number,
    resistance: number
  ): Promise<OptionContract | null> {
    const target =
      strategy === 'CC'
        ? recommendCallStrike(last, resistance, iv)
        : recommendStrike(last, support, iv);
    const right: 'P' | 'C' = strategy === 'CC' ? 'C' : 'P';
    try {
      return await this.alpaca.getOptionContract(symbol, right, target, DTE_LO, DTE_HI);
    } catch {
      return null;
    }
  }

  /** Strategy decision shared by the scan + refresh paths (technicals only). */
  private strategyFor(rsi: number | undefined, last: number, support: number): WheelRow['strategy'] {
    const nearSupport = support > 0 && (last - support) / last <= NEAR_SUPPORT_PCT;
    return rsi !== undefined && rsi <= OVERSOLD_RSI && nearSupport ? 'CC' : 'CSP';
  }

  // --- Helpers -------------------------------------------------------------

  private async technicalsFor(
    symbol: string,
    techCache: TechCache
  ): Promise<DailyTechnicals | null> {
    const cached = techCache[symbol];
    if (cached && cached.date === today()) return cached.tech;
    this.barsHealth.tried += 1;
    try {
      const bars = await this.alpaca.getBars(symbol, '1Day', 120);
      if (!bars.length) {
        this.barsHealth.failed += 1;
        return null;
      }
      const tech = computeTechnicals(bars);
      techCache[symbol] = { date: today(), tech };
      return tech;
    } catch {
      this.barsHealth.failed += 1;
      return null;
    }
  }

  /**
   * Optional fundamentals quality gate on the finalists only. Each call is one
   * AV request; we cap at FUNDAMENTAL_ENRICH_MAX names and cache by date to stay
   * within the 25/day free budget. A non-positive profit margin demotes a name
   * (score halved) rather than dropping it outright, and the whole step is
   * skipped gracefully on any rate signal.
   */
  private async enrichFundamentals(rows: WheelRow[], cache: OverviewCache): Promise<void> {
    let calls = 0;
    for (const row of rows) {
      if (calls >= FUNDAMENTAL_ENRICH_MAX) break;
      const cached = cache[row.symbol];
      let overview: CompanyOverview | null;
      if (cached && cached.date === today()) {
        overview = cached.overview;
      } else {
        try {
          overview = await this.av.getOverview(row.symbol);
          calls += 1;
        } catch {
          break; // rate signal / transport error — stop enriching this pass
        }
        cache[row.symbol] = { date: today(), overview };
      }
      if (overview && overview.profitMargin <= 0) {
        row.score = Math.round(row.score * 0.5 * 10) / 10;
      }
    }
    rows.sort((a, b) => b.score - a.score);
  }

  private recordIv(symbol: string, iv: number, ivHistory: IvHistory): void {
    const hist = ivHistory[symbol] ?? [];
    const d = today();
    const existing = hist.find((r) => r.date === d);
    if (existing) existing.iv = iv;
    else hist.push({ date: d, iv });
    while (hist.length > IV_HISTORY_WINDOW) hist.shift();
    ivHistory[symbol] = hist;
  }

  /**
   * IV Rank as a percentile of current IV within stored history. No free feed
   * gives trailing 52wk IV, so we build it ourselves. With <10 readings the
   * rank is "building" and we fall back to a scaled-current-IV proxy.
   */
  private ivRankFor(
    symbol: string,
    iv: number,
    ivHistory: IvHistory
  ): { ivRank: number; building: boolean } {
    if (iv <= 0) {
      return { ivRank: syntheticRow(symbol).ivRank, building: true };
    }
    const hist = ivHistory[symbol] ?? [];
    if (hist.length < IV_HISTORY_MIN) {
      const proxy = Math.round(Math.min(100, (iv / 0.8) * 100));
      return { ivRank: proxy, building: true };
    }
    const ivs = hist.map((r) => r.iv);
    const min = Math.min(...ivs);
    const max = Math.max(...ivs);
    const rank = max > min ? Math.round(((iv - min) / (max - min)) * 100) : 50;
    return { ivRank: rank, building: false };
  }

  private publish(rows: WheelRow[], universeScanned: number, lastDailyScan: number): void {
    let anyBuilding = false;
    let anyReal = false;
    let anySynthetic = false;
    for (const r of rows) {
      if (r.synthetic) anySynthetic = true;
      else anyReal = true;
      if (r.ivRankBuilding) anyBuilding = true;
    }

    let feedState: WheelFeedState;
    if (!anyReal && anySynthetic) feedState = 'synthetic';
    else if (anyBuilding || anySynthetic) feedState = 'partial';
    else feedState = 'live';

    const health = this.assessHealth(rows, feedState);

    const now = Date.now();
    this.last = {
      rows,
      watchlist: rows.map((r) => r.symbol),
      feedState,
      lastUpdated: now,
      nextRefresh: now + msToNextSlot(new Date(now)),
      universeScanned,
      lastDailyScan,
      health
    };
    this.emit();
    this.maybeRecover(health);
  }

  /**
   * Watchdog: turn the row set into a data-quality verdict. "Degraded" means the
   * feed handed us contracts but stripped the greeks/IV we depend on — the exact
   * shape of a silent data regression. Logged loudly and surfaced to the UI.
   */
  private assessHealth(rows: WheelRow[], feedState: WheelFeedState): WheelHealth {
    let optionRows = 0;
    let feedDelta = 0;
    let estDelta = 0;
    let noDelta = 0;
    let feedIv = 0;
    for (const r of rows) {
      if (r.iv > 0) feedIv += 1;
      if (!r.optionsAvailable) continue;
      optionRows += 1;
      if (r.deltaSource === 'feed') feedDelta += 1;
      else if (r.deltaSource === 'bs') estDelta += 1;
      else noDelta += 1;
    }

    const live = this.inSession();

    // Off-session the watchdog is intentionally idle: the feed is closed, so a
    // health verdict is meaningless. Report idle, never degraded, no false marks.
    if (!live) {
      return {
        optionRows,
        feedDelta,
        estDelta,
        noDelta,
        feedIv,
        degraded: false,
        idle: true,
        note: 'market closed — watchdog idle',
        credsOk: this.selfTest.credsOk,
        greeksOk: this.selfTest.greeksOk,
        lastSelfTest: this.selfTest.ts
      };
    }

    let degraded = false;
    let note: string | null = null;
    if (this.alpaca.hasCreds() && feedState !== 'synthetic') {
      if (this.selfTest.ts > 0 && !this.selfTest.credsOk) {
        degraded = true;
        note = 'Alpaca feed unreachable or auth failing';
      } else if (this.selfTest.ts > 0 && !this.selfTest.greeksOk) {
        degraded = true;
        note = 'options feed returning no greeks';
      } else if (optionRows >= 5 && feedDelta === 0) {
        degraded = true;
        note = `${optionRows} contracts resolved but 0 carry a feed delta — parse or feed issue`;
      } else if (optionRows >= 8 && feedIv === 0) {
        degraded = true;
        note = `${optionRows} contracts resolved but none have an IV reading`;
      }
    }

    const bh = this.barsHealth;
    if (!degraded && live && bh.tried >= 5 && bh.failed / bh.tried >= 0.5) {
      degraded = true;
      note = `daily-bars feed failing — ${bh.failed}/${bh.tried} technicals could not refresh (prices may be stale)`;
    }

    if (degraded) console.warn(`[wheel] WATCHDOG degraded: ${note}`);

    return {
      optionRows,
      feedDelta,
      estDelta,
      noDelta,
      feedIv,
      degraded,
      idle: false,
      note,
      credsOk: this.selfTest.credsOk,
      greeksOk: this.selfTest.greeksOk,
      lastSelfTest: this.selfTest.ts
    };
  }

  /**
   * Auto-recovery: on a degraded read, re-run the self-test and schedule ONE
   * near-term refresh, up to MAX_RECOVERY consecutive attempts. A healthy publish
   * resets the counter; past the cap we stop hammering and stay flagged loudly.
   */
  private maybeRecover(health: WheelHealth): void {
    if (!health.degraded) {
      this.recoveryAttempts = 0;
      return;
    }
    if (this.recoveryPending || this.recoveryAttempts >= MAX_RECOVERY) return;
    this.recoveryPending = true;
    this.recoveryAttempts += 1;
    console.warn(
      `[wheel] WATCHDOG auto-recovery ${this.recoveryAttempts}/${MAX_RECOVERY} in ${RECOVERY_DELAY_MS / 1000}s`
    );
    setTimeout(() => {
      this.recoveryPending = false;
      void this.refresh(false);
    }, RECOVERY_DELAY_MS);
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this.last);
  }
}
