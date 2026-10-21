# Vela Desktop

English | [简体中文](./README.zh-CN.md)

A local-first trading workstation built on [Vela](https://velacharts.dev) by LuxAlgo. It bundles an Electron desktop shell, a Vite web client, a TypeScript data/API service backed by Longbridge, and a small trading-core library for session-aware backtests and LLM-assisted intraday analysis.

## Features

- **Charting** — Vela workspace with multiple panes, drawing tools and a custom indicator editor (CodeMirror + PineTS).
- **Market data** — Longbridge quotes, lazy-loaded history and live candlestick push, cached locally in SQLite.
- **Indicator vault** — scraped LuxAlgo Pine library (`data/pine/**`) plus user-defined indicators.
- **AI intraday analysis** — DeepSeek-compatible LLM panel (optional API key).
- **Backtesting** — session-aware single-day backtests with a simulated broker and LLM tool calls (`packages/trading-core`).
- **Desktop** — Electron wrapper that starts the local API service and points the window at it.

## Repository layout

```
apps/
  desktop/          Electron main process (main.ts → dist/main.js)
  web/              Vite client + Node data/API service (api-server.ts)
packages/
  trading-core/     Backtest engine, simulated broker, quota and LLM agent
  vela/             Vendored Vela charting library (Apache-2.0)
data/               Scraped Pine indicator vault and local caches (cache/ is git-ignored)
tools/              Indicator scraper and Playwright exploration scripts
```

## Requirements

- Node.js >= 22.17 (the API service uses the built-in `node:sqlite` module)
- pnpm 10 (`corepack enable`)

## Quick start

```bash
pnpm install
cp .env.example .env        # fill in credentials (optional for chart-only use)

# Build the shared libraries once
pnpm run build:core
pnpm run build:vela

# Desktop app (starts the API service automatically)
pnpm start

# Or run the web client and API service separately
pnpm run api                # http://localhost:5174
pnpm run web                # http://localhost:5173 (proxies /api to 5174)
```

All API routes are versioned under `/api/v1` (the legacy `/api` paths remain as aliases). Interactive documentation is served at `http://localhost:5174/api/docs`, with the OpenAPI document at `/api/v1/openapi.json`.

The API service serves `apps/web/dist` when a production build exists:

```bash
pnpm run build:web
```

## Configuration

All configuration is read from environment variables; see [`.env.example`](./.env.example). Local secrets may also live in the git-ignored `data/agent.json`.

| Variable | Purpose |
| --- | --- |
| `API_PORT` | API/web server port (default `5174`) |
| `VELA_NODE` | Node binary used by the Electron shell to spawn the API service |
| `LONGPORT_APP_KEY` / `LONGPORT_APP_SECRET` / `LONGPORT_ACCESS_TOKEN` | Longbridge OpenAPI credentials |
| `LONGPORT_HTTP_URL` / `LONGPORT_QUOTE_WS_URL` / `LONGPORT_TRADE_WS_URL` | Longbridge endpoints (international gateway by default) |
| `DEEPSEEK_API_KEY` | API key for the AI analysis panel |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | OpenAI-compatible endpoint and model |
| `AGENT_REASONING_EFFORT` | LLM reasoning effort (`low` by default) |

Never commit `.env` or `data/agent.json`; both are git-ignored.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm start` / `pnpm dev` | Run the Electron app (dev enables remote debugging on `9222`) |
| `pnpm run api` | Start the API service |
| `pnpm run web` | Start the Vite dev server |
| `pnpm run demo` | Start API service and Vite together |
| `pnpm run build` | Build core, Vela and the web client |
| `pnpm run build:core` / `build:vela` / `build:web` | Build a single target |
| `pnpm test` | Run all tests (core, Vela, web smoke) |
| `pnpm test:core` | Run trading-core tests |
| `pnpm run test:vela` | Run Vela tests |
| `pnpm run test:web` | Run web API smoke tests |
| `pnpm run typecheck` | Type-check core, Vela, web and server |
| `pnpm run lint` / `pnpm run format` | Lint or format the app code |
| `pnpm run scrape:indicators` | Refresh the Pine indicator vault |

## Docker

The web client and API service can run in a container:

```bash
docker compose up --build
```

See [`Dockerfile`](./Dockerfile) and [`docker-compose.yml`](./docker-compose.yml).

## License

The application code is MIT. `packages/vela` is distributed under the Apache-2.0 license; see its `LICENSE` and `NOTICE` files.
