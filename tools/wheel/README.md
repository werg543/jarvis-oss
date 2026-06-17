# Wheel screener

A daily implied-volatility screener for an options **wheel** (cash-secured puts on names you would be fine owning, plus covered calls when a holding is oversold at support). It ranks a curated universe by IV rank and technicals, recommends a strike anchored to volume-profile support, and reports honest data-quality health so a silent feed regression is loud, not hidden.

Extracted from a private Electron trading app. This is the screener engine only. Live position tracking, broker order routing, and the futures depth feed are intentionally left out.

## How it works

```
universe  ->  IV (Alpha Vantage)  ->  technicals (Alpaca daily bars)  ->  score  ->  strike (volume profile)
```

- **Daily scan**, cached by date, over the names in `src/main/wheel/universe.ts`. Surfaced finalists then refresh IV and premium every 30 minutes from market open via a wall-clock scheduler (`msToNextSlot`). No streaming.
- **Score** = `0.6 * ivRankNorm + 0.4 * technicalScore`. No free feed ranks the whole market's IV, so "top IV" means top within the scanned universe.
- **Strike** is anchored to a volume-profile node: support below price for a CSP, resistance above for a CC.
- **Greeks**: real chain greeks when the feed has them, otherwise a Black-Scholes estimate tagged `bs` so the UI flags it as approximate. Estimates are never passed off as feed data.
- **Watchdog** (`WheelHealth`): every refresh computes coverage (rows with real delta vs BS estimate vs none, real IV count) and flags the feed as degraded when it returns contracts stripped of greeks/IV.

## Layout

```
src/
  shared/        types, Black-Scholes greeks, option helpers, synthetic fallback
  main/
    clients/     Alpaca (bars + options chain), Alpha Vantage (IV + fundamentals)
    wheel/       the engine: scan, score, universe, volume profile, insiders, analysis
```

## Setup

```bash
npm i @alpacahq/alpaca-trade-api
```

Set credentials in the environment:

| Var | Purpose |
|---|---|
| `ALPACA_KEY_ID`, `ALPACA_SECRET` | bars and options chain |
| `ALPACA_PAPER` | `"true"` for paper, `"false"` for live data |
| `ALPHAVANTAGE_KEY` | IV history and fundamentals (free key is 25 req/day, 5/min) |

Without creds the screener falls back to deterministic synthetic rows, tagged `synthetic`, so the UI never shows a fake number as real.

## Notes for reuse outside the source app

- **Electron paths.** `insiders.ts` and `analysis.ts` cache under Electron's `app.getPath('userData')`. Swap that for a directory of your choosing if you run this outside Electron.
- **Optional analysis feature.** `analysis.ts` shells out to the `claude` CLI for an on-demand fundamental write-up. Set `CLAUDE_BIN` (defaults to `claude` on PATH) and `WHEEL_CWD` (defaults to the process cwd, which must contain `mcp-none.json`, included here). The screener itself does not need this; it only powers the per-name analysis panel.

## License

MIT, same as the rest of this repo.
