/**
 * Bundled scan universe for the daily IV screener.
 *
 * A curated watchlist of liquid, optionable names, tagged with a broad
 * `sector` (kept for internal logic / Alpha Vantage matching) AND a granular
 * `theme` (chips, memory, quantum, nuclear, space, robotics...) which is what the
 * scanner actually displays. This is the SCAN BASE: the screener fetches IV for
 * each name, ranks, and filters. No free feed ranks the entire market's IV, so
 * "top 100 IV" always means "top 100 within this scanned universe" — the code and
 * UI say so honestly. The IV_TOP_N=100 step keeps the whole list; it stays a cap.
 *
 * Cap tiers are approximate, hand-tagged buckets (mega >$200B, large $10-200B,
 * mid $2-10B, small $300M-2B, micro <$300M) used as a free fundamentals
 * baseline. Sector strings match Alpha Vantage OVERVIEW "Sector" values closely
 * enough for our Healthcare exclusion; `theme` is purely a display/grouping tag.
 */

export type CapTier = 'mega' | 'large' | 'mid' | 'small' | 'micro';

export interface UniverseName {
  symbol: string;
  sector: string;
  theme: string;
  capTier: CapTier;
}

/**
 * Known binary / event-driven names to exclude outright (clinical-trial
 * single-product biotechs, perennial squeeze/meme tickers whose IV is driven by
 * event risk rather than a sellable vol premium). Additive static list; the
 * heuristic in the engine catches the rest.
 */
export const BINARY_EXCLUSIONS = new Set<string>([
  'GME',
  'AMC',
  'SAVA',
  'MNMD',
  'BBBY',
  'CLOV',
  'NKLA',
  'SDC',
  'WISH',
  'PHUN',
  'DWAC',
  'CYTK'
]);

export const UNIVERSE: UniverseName[] = [
  // --- Chips / semis ----------------------------------------------------
  { symbol: 'NVDA', sector: 'Technology', theme: 'AI Chips', capTier: 'mega' },
  { symbol: 'AMD', sector: 'Technology', theme: 'AI Chips', capTier: 'mega' },
  { symbol: 'CRDO', sector: 'Technology', theme: 'AI Connectivity', capTier: 'mid' },
  { symbol: 'VICR', sector: 'Technology', theme: 'Power Chips', capTier: 'small' },

  // --- Memory / storage -------------------------------------------------
  { symbol: 'MU', sector: 'Technology', theme: 'Memory', capTier: 'large' },
  { symbol: 'WDC', sector: 'Technology', theme: 'Memory', capTier: 'mid' },
  { symbol: 'STX', sector: 'Technology', theme: 'Memory', capTier: 'large' },
  { symbol: 'SIMO', sector: 'Technology', theme: 'Memory', capTier: 'small' }, // NAND/DRAM controllers

  // --- Optical / photonics ----------------------------------------------
  { symbol: 'GLW', sector: 'Technology', theme: 'Optical', capTier: 'large' },
  { symbol: 'LITE', sector: 'Technology', theme: 'Optical', capTier: 'mid' },
  { symbol: 'AAOI', sector: 'Technology', theme: 'Optical', capTier: 'small' },
  { symbol: 'POET', sector: 'Technology', theme: 'Photonics', capTier: 'micro' },

  // --- AI servers / hardware --------------------------------------------
  { symbol: 'AAPL', sector: 'Technology', theme: 'Hardware', capTier: 'mega' },
  { symbol: 'SONY', sector: 'Technology', theme: 'Hardware', capTier: 'large' },
  { symbol: 'CLS', sector: 'Technology', theme: 'AI Servers', capTier: 'mid' },
  { symbol: 'SMCI', sector: 'Technology', theme: 'AI Servers', capTier: 'large' },

  // --- AI cloud / datacenter --------------------------------------------
  { symbol: 'NBIS', sector: 'Technology', theme: 'AI Cloud', capTier: 'mid' },
  { symbol: 'CRWV', sector: 'Technology', theme: 'AI Cloud', capTier: 'large' },
  { symbol: 'APLD', sector: 'Technology', theme: 'AI Datacenter', capTier: 'small' },

  // --- AI / enterprise software -----------------------------------------
  { symbol: 'PLTR', sector: 'Technology', theme: 'AI Software', capTier: 'large' },
  { symbol: 'AI', sector: 'Technology', theme: 'AI Software', capTier: 'small' },
  { symbol: 'PATH', sector: 'Technology', theme: 'AI Automation', capTier: 'mid' },
  { symbol: 'ORCL', sector: 'Technology', theme: 'Cloud Software', capTier: 'mega' },
  { symbol: 'NTNX', sector: 'Technology', theme: 'Cloud Software', capTier: 'mid' },
  { symbol: 'ADBE', sector: 'Technology', theme: 'Software', capTier: 'large' },
  { symbol: 'ADSK', sector: 'Technology', theme: 'Software', capTier: 'large' },
  { symbol: 'WDAY', sector: 'Technology', theme: 'Software', capTier: 'large' },
  { symbol: 'TEAM', sector: 'Technology', theme: 'Software', capTier: 'large' },
  { symbol: 'DOCU', sector: 'Technology', theme: 'Software', capTier: 'mid' },
  { symbol: 'SABR', sector: 'Technology', theme: 'Travel Tech', capTier: 'small' },

  // --- AdTech -----------------------------------------------------------
  { symbol: 'APP', sector: 'Technology', theme: 'AdTech', capTier: 'large' },
  { symbol: 'TTD', sector: 'Technology', theme: 'AdTech', capTier: 'large' },
  { symbol: 'CRTO', sector: 'Industrials', theme: 'AdTech', capTier: 'small' },

  // --- Quantum ----------------------------------------------------------
  { symbol: 'IONQ', sector: 'Technology', theme: 'Quantum', capTier: 'mid' },
  { symbol: 'RGTI', sector: 'Technology', theme: 'Quantum', capTier: 'small' },

  // --- Robotics / automation --------------------------------------------
  { symbol: 'TER', sector: 'Technology', theme: 'Robotics', capTier: 'large' },
  { symbol: 'OUST', sector: 'Technology', theme: 'Robotics', capTier: 'small' }, // lidar sensing
  { symbol: 'SERV', sector: 'Technology', theme: 'Robotics', capTier: 'small' }, // delivery robots
  { symbol: 'SYM', sector: 'Industrials', theme: 'Robotics', capTier: 'mid' }, // warehouse — Symbotic
  { symbol: 'NNDM', sector: 'Technology', theme: '3D Printing', capTier: 'micro' }, // Nano Dimension

  // --- Space ------------------------------------------------------------
  { symbol: 'RKLB', sector: 'Industrials', theme: 'Space', capTier: 'mid' }, // Rocket Lab
  { symbol: 'LUNR', sector: 'Industrials', theme: 'Space', capTier: 'small' }, // Intuitive Machines
  { symbol: 'ASTS', sector: 'Communication Services', theme: 'Space', capTier: 'mid' }, // sat-to-phone
  { symbol: 'PL', sector: 'Technology', theme: 'Space', capTier: 'small' }, // Planet Labs imaging
  { symbol: 'BKSY', sector: 'Industrials', theme: 'Space', capTier: 'small' }, // BlackSky imaging

  // --- Social / streaming / media ---------------------------------------
  { symbol: 'META', sector: 'Communication Services', theme: 'Social/AI', capTier: 'mega' },
  { symbol: 'PINS', sector: 'Communication Services', theme: 'Social', capTier: 'mid' },
  { symbol: 'ROKU', sector: 'Communication Services', theme: 'Streaming', capTier: 'mid' },
  { symbol: 'CHTR', sector: 'Communication Services', theme: 'Telecom', capTier: 'large' },
  { symbol: 'RNG', sector: 'Communication Services', theme: 'Cloud Comms', capTier: 'small' },

  // --- EV / auto --------------------------------------------------------
  { symbol: 'TSLA', sector: 'Consumer Discretionary', theme: 'EV/Auto', capTier: 'mega' },

  // --- Consumer / retail / leisure --------------------------------------
  { symbol: 'LULU', sector: 'Consumer Discretionary', theme: 'Apparel', capTier: 'large' },
  { symbol: 'ETSY', sector: 'Consumer Discretionary', theme: 'E-commerce', capTier: 'mid' },
  { symbol: 'JD', sector: 'Consumer Discretionary', theme: 'China Tech', capTier: 'large' },
  { symbol: 'CR', sector: 'Consumer Discretionary', theme: 'Industrial', capTier: 'mid' },
  { symbol: 'PTON', sector: 'Consumer Discretionary', theme: 'Fitness', capTier: 'small' },
  { symbol: 'CZR', sector: 'Consumer Discretionary', theme: 'Casinos', capTier: 'mid' },
  { symbol: 'MLCO', sector: 'Consumer Discretionary', theme: 'Casinos', capTier: 'mid' },
  { symbol: 'MTN', sector: 'Consumer Discretionary', theme: 'Leisure', capTier: 'mid' },
  { symbol: 'MBUU', sector: 'Consumer Discretionary', theme: 'Leisure', capTier: 'small' },
  { symbol: 'TLRY', sector: 'Consumer Discretionary', theme: 'Cannabis', capTier: 'small' },
  { symbol: 'BYND', sector: 'Consumer Discretionary', theme: 'Food', capTier: 'micro' },
  { symbol: 'KR', sector: 'Consumer Staples', theme: 'Grocery', capTier: 'large' },
  { symbol: 'ACI', sector: 'Consumer Staples', theme: 'Grocery', capTier: 'mid' },

  // --- Fintech ----------------------------------------------------------
  { symbol: 'HOOD', sector: 'Financials', theme: 'Fintech', capTier: 'mid' },
  { symbol: 'SOFI', sector: 'Financials', theme: 'Fintech', capTier: 'mid' },
  { symbol: 'PYPL', sector: 'Financials', theme: 'Fintech', capTier: 'large' },
  { symbol: 'LMND', sector: 'Financials', theme: 'Insurtech', capTier: 'small' },
  { symbol: 'HRB', sector: 'Financials', theme: 'Consumer Finance', capTier: 'mid' },

  // --- Crypto / digital-asset names -------------------------------------
  { symbol: 'RIOT', sector: 'Financials', theme: 'Crypto Mining', capTier: 'mid' },
  { symbol: 'CLSK', sector: 'Financials', theme: 'Crypto Mining', capTier: 'mid' },
  { symbol: 'HIVE', sector: 'Technology', theme: 'Crypto Mining', capTier: 'small' },
  { symbol: 'WULF', sector: 'Financials', theme: 'Crypto Mining', capTier: 'mid' }, // TeraWulf
  { symbol: 'IREN', sector: 'Technology', theme: 'Crypto/AI Cloud', capTier: 'mid' },
  { symbol: 'COIN', sector: 'Financials', theme: 'Crypto Exchange', capTier: 'large' },
  { symbol: 'MSTR', sector: 'Technology', theme: 'Bitcoin Proxy', capTier: 'large' },

  // --- Airlines ---------------------------------------------------------
  { symbol: 'AAL', sector: 'Industrials', theme: 'Airlines', capTier: 'mid' },
  { symbol: 'JBLU', sector: 'Industrials', theme: 'Airlines', capTier: 'small' },
  { symbol: 'LAKE', sector: 'Industrials', theme: 'Industrial', capTier: 'micro' },

  // --- Nuclear / uranium ------------------------------------------------
  { symbol: 'CCJ', sector: 'Energy', theme: 'Uranium', capTier: 'large' },
  { symbol: 'UEC', sector: 'Energy', theme: 'Uranium', capTier: 'small' },
  { symbol: 'LEU', sector: 'Energy', theme: 'Nuclear Fuel', capTier: 'mid' }, // Centrus enrichment
  { symbol: 'OKLO', sector: 'Energy', theme: 'Nuclear', capTier: 'mid' }, // SMR developer
  { symbol: 'SMR', sector: 'Energy', theme: 'Nuclear', capTier: 'mid' }, // NuScale SMR
  { symbol: 'CEG', sector: 'Energy', theme: 'Nuclear', capTier: 'large' }, // nuclear utility / AI demand

  // --- Solar ------------------------------------------------------------
  { symbol: 'FSLR', sector: 'Energy', theme: 'Solar', capTier: 'large' },
  { symbol: 'ENPH', sector: 'Energy', theme: 'Solar', capTier: 'mid' }, // inverters
  { symbol: 'TE', sector: 'Energy', theme: 'Solar', capTier: 'small' }, // T1 Energy (ex-FREYR)

  // --- Power / utilities ------------------------------------------------
  { symbol: 'VST', sector: 'Energy', theme: 'Power', capTier: 'large' }, // AI-datacenter demand

  // --- Oil & gas --------------------------------------------------------
  { symbol: 'XOM', sector: 'Energy', theme: 'Oil & Gas', capTier: 'mega' },
  { symbol: 'CVX', sector: 'Energy', theme: 'Oil & Gas', capTier: 'mega' },
  { symbol: 'COP', sector: 'Energy', theme: 'Oil & Gas', capTier: 'large' },
  { symbol: 'OXY', sector: 'Energy', theme: 'Oil & Gas', capTier: 'large' },
  { symbol: 'SLB', sector: 'Energy', theme: 'Oil Services', capTier: 'large' },

  // --- Materials --------------------------------------------------------
  { symbol: 'AG', sector: 'Materials', theme: 'Silver Mining', capTier: 'small' },
  { symbol: 'OI', sector: 'Materials', theme: 'Packaging', capTier: 'small' },

  // --- Pharma -----------------------------------------------------------
  { symbol: 'LLY', sector: 'Healthcare', theme: 'GLP-1 / Pharma', capTier: 'mega' },
  { symbol: 'NVO', sector: 'Healthcare', theme: 'GLP-1 / Pharma', capTier: 'mega' },
  { symbol: 'ABBV', sector: 'Healthcare', theme: 'Pharma', capTier: 'mega' },
  { symbol: 'MRK', sector: 'Healthcare', theme: 'Pharma', capTier: 'mega' },
  { symbol: 'JNJ', sector: 'Healthcare', theme: 'Pharma', capTier: 'mega' },
  { symbol: 'AMGN', sector: 'Healthcare', theme: 'Biotech', capTier: 'mega' },
  { symbol: 'TMO', sector: 'Healthcare', theme: 'Life Sciences', capTier: 'mega' },

  // --- Med-tech / health services ---------------------------------------
  { symbol: 'ISRG', sector: 'Healthcare', theme: 'Surgical Robotics', capTier: 'mega' },
  { symbol: 'HIMS', sector: 'Healthcare', theme: 'Telehealth', capTier: 'mid' },
  { symbol: 'TDOC', sector: 'Healthcare', theme: 'Telehealth', capTier: 'small' },
  { symbol: 'UNH', sector: 'Healthcare', theme: 'Health Insurance', capTier: 'mega' },
  { symbol: 'CVS', sector: 'Healthcare', theme: 'Health Insurance', capTier: 'large' },
  { symbol: 'CNC', sector: 'Healthcare', theme: 'Health Insurance', capTier: 'large' },
  { symbol: 'OSCR', sector: 'Healthcare', theme: 'Health Insurance', capTier: 'small' },
  { symbol: 'EVH', sector: 'Financials', theme: 'Health Tech', capTier: 'small' },

  // --- ETFs (optionable, deep liquidity) --------------------------------
  { symbol: 'GLD', sector: 'ETF', theme: 'Gold ETF', capTier: 'large' },
  { symbol: 'EWY', sector: 'ETF', theme: 'Korea / Memory ETF', capTier: 'large' }, // DRAM proxy
  { symbol: 'TQQQ', sector: 'ETF', theme: 'Leveraged ETF', capTier: 'large' }, // 3x Nasdaq-100; fundamentals via QQQ

  // --- Additional names -------------------------------------------------
  { symbol: 'ALB', sector: 'Materials', theme: 'Lithium', capTier: 'large' }, // Albemarle
  { symbol: 'ARM', sector: 'Technology', theme: 'AI Chips', capTier: 'mega' }, // Arm Holdings
  { symbol: 'VIAV', sector: 'Technology', theme: 'Optical', capTier: 'small' }, // Viavi network test
  { symbol: 'CIFR', sector: 'Financials', theme: 'Crypto Mining', capTier: 'small' }, // Cipher Mining
  { symbol: 'AMKR', sector: 'Technology', theme: 'Chip Packaging', capTier: 'mid' }, // Amkor OSAT
  { symbol: 'INTC', sector: 'Technology', theme: 'AI Chips', capTier: 'mega' } // Intel
];

export const UNIVERSE_SYMBOLS: string[] = UNIVERSE.map((u) => u.symbol);

const BY_SYMBOL = new Map<string, UniverseName>(UNIVERSE.map((u) => [u.symbol, u]));

export function universeMeta(symbol: string): UniverseName | undefined {
  return BY_SYMBOL.get(symbol);
}

/** True for sectors we drop wholesale (healthcare / biotech / pharma). */
export function isHealthcare(sector: string): boolean {
  const s = sector.toLowerCase();
  return (
    s.includes('health') ||
    s.includes('biotech') ||
    s.includes('pharma') ||
    s.includes('life science')
  );
}
