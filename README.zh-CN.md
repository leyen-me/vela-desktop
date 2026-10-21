# Vela Desktop

[English](./README.md) | 简体中文

基于 LuxAlgo [Vela](https://velacharts.dev) 构建的本地化交易工作台，包含 Electron 桌面外壳、Vite Web 客户端、基于长桥（Longbridge）的 Node.js 数据/API 服务，以及用于会话感知回测和 AI 日内分析的精简交易核心库。

## 功能特性

- **图表** — Vela 工作区，支持多窗格、绘图工具以及基于 CodeMirror + PineTS 的自定义指标编辑器。
- **行情数据** — 长桥报价、按需加载历史 K 线与实时推送，本地 SQLite 缓存。
- **指标库** — 抓取的 LuxAlgo Pine 指标库（`data/pine/**`）以及用户自定义指标。
- **AI 日内分析** — 兼容 DeepSeek 的大模型面板（API Key 可选）。
- **回测** — 会话感知的单日回测，内置模拟券商与 LLM 工具调用（`packages/trading-core`）。
- **桌面端** — Electron 自动拉起本地 API 服务并加载页面的外壳。

## 仓库结构

```
apps/
  desktop/          Electron 主进程（main.ts → dist/main.js）
  web/              Vite 客户端 + Node 数据/API 服务（api-server.ts）
packages/
  trading-core/     回测引擎、模拟券商、配额与 LLM Agent
  vela/             内置 Vela 图表库（Apache-2.0）
data/               抓取的 Pine 指标库与本地缓存（cache/ 不纳入版本控制）
tools/              指标抓取脚本与 Playwright 探索脚本
```

## 环境要求

- Node.js >= 22.17（API 服务使用内置 `node:sqlite` 模块）
- pnpm 10（`corepack enable`）

## 快速开始

```bash
pnpm install
cp .env.example .env        # 按需填写凭据，仅看图可不填

# 首次构建共享库
pnpm run build:core
pnpm run build:vela

# 桌面应用（自动启动 API 服务）
pnpm start

# 或分别启动 Web 客户端与 API 服务
pnpm run api                # http://localhost:5174
pnpm run web                # http://localhost:5173（/api 代理到 5174）
```

所有 API 路由统一使用 `/api/v1` 前缀（旧的 `/api` 路径保留为别名）。交互式文档位于 `http://localhost:5174/api/docs`，OpenAPI 文档位于 `/api/v1/openapi.json`。

存在生产构建时，API 服务会直接托管 `apps/web/dist`：

```bash
pnpm run build:web
```

## 配置说明

所有配置均从环境变量读取，参见 [`.env.example`](./.env.example)。本地密钥也可放在已被 Git 忽略的 `data/agent.json` 中。

| 变量 | 用途 |
| --- | --- |
| `API_PORT` | API/Web 服务端口（默认 `5174`） |
| `VELA_NODE` | Electron 启动 API 服务时使用的 Node 路径 |
| `LONGPORT_APP_KEY` / `LONGPORT_APP_SECRET` / `LONGPORT_ACCESS_TOKEN` | 长桥 OpenAPI 凭据 |
| `LONGPORT_HTTP_URL` / `LONGPORT_QUOTE_WS_URL` / `LONGPORT_TRADE_WS_URL` | 长桥接口地址（默认国际网关） |
| `DEEPSEEK_API_KEY` | AI 分析面板的 API Key |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | OpenAI 兼容接口地址与模型 |
| `AGENT_REASONING_EFFORT` | LLM 推理强度（默认 `low`） |

切勿提交 `.env` 或 `data/agent.json`，二者均已加入 `.gitignore`。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm start` / `pnpm dev` | 运行 Electron 应用（dev 模式开启 `9222` 远程调试） |
| `pnpm run api` | 启动 API 服务 |
| `pnpm run web` | 启动 Vite 开发服务器 |
| `pnpm run demo` | 同时启动 API 服务与 Vite |
| `pnpm run build` | 构建 core、Vela 与 Web 客户端 |
| `pnpm run build:core` / `build:vela` / `build:web` | 单独构建某个目标 |
| `pnpm test` | 运行全部测试（core、Vela、web 冒烟） |
| `pnpm test:core` | 运行 trading-core 测试 |
| `pnpm run test:vela` | 运行 Vela 测试 |
| `pnpm run test:web` | 运行 Web API 冒烟测试 |
| `pnpm run typecheck` | 检查 core、Vela、web 与 server 类型 |
| `pnpm run lint` / `pnpm run format` | Lint 或格式化应用代码 |
| `pnpm run scrape:indicators` | 刷新 Pine 指标库 |

## Docker

Web 客户端与 API 服务支持容器化运行：

```bash
docker compose up --build
```

详见 [`Dockerfile`](./Dockerfile) 与 [`docker-compose.yml`](./docker-compose.yml)。

## 许可证

应用代码采用 MIT 协议。`packages/vela` 以 Apache-2.0 协议分发，详见其 `LICENSE` 与 `NOTICE` 文件。
