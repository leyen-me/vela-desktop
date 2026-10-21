# AGENTS.md

## 一、 项目工程与协作规范 (Engineering & Workflow)

- **工程化架构**：建立标准化的项目架构与工程范式，提升扩展性，降低后续重构成本，便于团队协作与 AI Agent 高效维护。
- **单仓/多包架构（Monorepo）**：如涉及多项目协作，统一使用 Turbo/Nx 等工具管理 Packages，清晰划分为 `apps/`（应用）与 `packages/`（共享库）。
- **版本控制初始化**：新项目创建完成后，立即执行 Git 初始化并完成首次提交（Initial Commit）。
- **提交信息规范**：严格遵守 Conventional Commits 规范（如 `feat:`、`fix:`、`refactor:`、`docs:` 等），保持提交历史清晰可追溯。
- **目录与命名规范**：维护清晰合理的目录结构，统一采用语义化命名（如 kebab-case 或 camelCase），严禁中英文混用或拼音命名。
- **增量提交建议**：每完成一项独立功能实现或 Bug 修复，Agent 应主动提示用户是否执行 `git commit`。
- **多语言文档**：维护完整、准确的中英文双语 `README.md`，包含项目介绍、快速启动与配置说明。
- **容器化部署**：提供标准的 `Dockerfile` 与 `docker-compose.yml` 部署方案，确保开发、测试与生产环境一致性。
- **环境变量管理**：同步更新 `.env.example` 与 `.env`，确保配置项完整，严格禁止将敏感密钥提交至代码仓库。
- **Agent 上下文维护**：持续更新维护本 `AGENTS.md`，记录关键设计决议与工程约定，避免跨会话信息遗失与重复检索。
- **自动化测试保障**：前后端均须具备完善的测试覆盖，包含单元测试（Unit Test）、端到端测试（E2E）以及边界值/极值测试。
- **容器健康检查**：在 Dockerfile 和 docker-compose 中配置健康的 `HEALTHCHECK` 机制，确保服务异常时容器能自动重启。
- **破坏性变更防范**：凡涉及删除文件、修改数据库 Schema、删除现有接口或修改公用 API 方法签名时，必须主动询问用户二次确认。
- **自检与测试驱动（Self-Refine）**：Agent 在提示用户代码修改完成前，应主动运行项目中的 Lint 命令或测试用例，确保无语法错误及编译错误后方可交接。
- **防御性编程（Defensive Programming）**：关键节点和边界必须做好空值处理（Optional Chaining `?.` / Nullish Coalescing `??`），避免出现 `Unhandled Rejection` 或 `Cannot read properties of undefined`。
- **极简注释原则（Self-Documenting Code）**：代码本身应具有极强的可读性，做到“代码即文档”。注释只用来解释 **Why（为什么这么做/业务背景/特殊 Hack）**，而不是解释 **What（这段代码在干嘛）**。
- **统一的错误处理策略（Global Error Handling）**：前端统一接入 React Error Boundary 或全局 Vue onerror 捕获组件崩塌，防止“白屏”。后端严禁裸抛（`throw`）原始错误或静默吞掉异常（`catch {}`），统一转换为标准化 Error Response 结构输出。
- **常量与配置收拢**：禁止在业务逻辑中散落硬编码字符串或魔术数字（Magic Numbers），统一收拢至 `constants/` 或 `config/` 文件中集中管理。

---

## 二、 前端开发规范 (Frontend Standards)

- **类型安全**：严格使用 TypeScript 进行类型约束，禁止滥用 `any`，确保 API 与组件 Props 类型定义完整准确。
- **架构设计**：遵循单一职责原则（SRP），解耦业务逻辑与 UI 呈现，明确划分公共组件（Common Components）与业务组件（Business Components）。
- **样式与 UI 规范**：统一样式方案（如 TailwindCSS），禁止随意内联样式与硬编码魔术数字，保持 UI 视觉与交互一致性。
- **状态与性能**：合理规划状态作用域，避免状态无脑全局化；关键交互与高频事件做好防抖/节流及异步组件按需加载。
- **网络与异常容错**：统一封装 API 请求层，针对网络请求提供标准的 Loading（加载中）、Error（异常）、Empty（空状态）等兜底展示。
- **依赖管理标准**：统一锁定包管理器（如 `pnpm` / `npm`），必须提交 Lock 文件（`pnpm-lock.yaml`），禁止混用不同的包管理器。
- **代码格式与 Lint 自动化**：配置标准的 ESLint/Prettier/Ruff 等格式化工具
- **代码无障碍与语义化**：优先使用 HTML5 语义化标签（`header`, `nav`, `main`, `article`），保障基本的无障碍（A11y）可访问性。
- **路由与鉴权隔离**：统一路由守卫与鉴权逻辑，静态路由与动态权限路由分离开，未授权请求统一拦截重定向。
- **服务端渲染/SSG 混合规范**（针对 Next.js/Nuxt 等）：明确区分 Client Component (`"use client"`) 与 Server Component，避免将客户端逻辑无脑暴露给服务端渲染。

---

## 三、 后端开发规范 (Backend Standards)

- **基础设施对齐**：统一统一日志格式（Structured Logging）、全局错误码定义（Error Codes）及中间件拦截（Middleware）机制。
- **数据库变更管理**：涉及数据库结构变更时，必须提供版本化的迁移脚本（Migration Up/Down File）。
- **接口契约与校验**：遵循 RESTful API 设计规范，所有输入参数必须进行严格的数据传输对象校验（DTO Validation）。
- **数据库与查询优化**：合理建立索引，避免慢查询与 N+1 查询问题，优化高频读写性能。
- **健壮性与事务**：核心业务逻辑必须包含完善的异常捕获机制，涉及多表更新时严格启用数据库事务机制（Transaction Rollback）。
- **分层架构模式**：严格遵循分层架构（Controller / Service / Repository 或 DDD 领域驱动设计），禁止在 Controller 层直接编写 SQL 或核心业务逻辑。
- **幂等性保障**：对所有写操作（如支付、下单、批量提交）设计幂等机制（如请求唯一 Token、防重提交中间件）。
- **异步任务与队列**：耗时任务（如发送邮件、生成 PDF、AI 异步推理）必须解耦移至后台任务队列（如 Redis/RabbitMQ/Celery），严禁阻塞 HTTP 线程。
- **API 文档自动化**：必须保证 API 变更时同步生成/更新 Open API / Swagger 文档，确保前端与第三方对接有据可查。
- **机密信息零泄漏**：代码库内严禁硬编码任何 API Key、密码、私钥、数据库连接串，必须从环境变量读取。
- **输入清理与防注入**：所有用户输入必须进行 Sanitization（数据清洗），杜绝 SQL 注入、XSS、CSRF 等基础安全漏洞。
- **敏感数据脱敏**：日志与前端页面展示敏感信息（手机号、身份证、邮箱、Token）时，必须进行掩码脱敏处理。
- **日志落盘与轮转**：容器内日志输出到 `stdout/stderr`，并配置 Docker 日志轮转（log-rotation），防止单个日志文件撑爆宿主机磁盘。
- **版本化 API 路由**：所有后端接口路由建议包含版本号前缀（如 `/api/v1/...`），为后续大版本升级和兼容弃用（Deprecation）留出空间。
- **数据结构打平与统一**：API 返回结构必须高度一致，固定包含 `code`, `message`, `data`, `timestamp` 字段，杜绝有些接口返回数组、有些返回对象的混乱现象。
- **大列表分页强制约束**：所有查询列表类 API 必须默认携带分页参数（`page`, `pageSize` / `cursor`），严禁无上限地返回全量数据，防止 DB 爆内存。
- **前后端契约类型导出**：后端如果采用 TypeScript，后端/API 层的 TypeScript 类型定义必须作为 Sources 的单一事实来源（Single Source of Truth），前端直接引用，避免两边重复定义。
- **事务最小化**：数据库事务（Transaction）内只包含必要的 DB 操作，禁止在事务逻辑中调用远程第三方 API 或耗时 HTTP 请求，防止长事务锁表。
- **优雅停机与资源释放**：后端服务必须监听 `SIGTERM` / `SIGINT` 信号，在进程退出前主动关闭数据库连接池、Redis 客户端，并等待未完成的 HTTP 请求处理完毕。
---

## 四、项目关键决议 (Project Decisions)

- **Monorepo 布局**：采用 pnpm workspace。应用位于 `apps/`（`desktop` Electron 主进程、`web` Vite 客户端 + `api-server.ts`），共享库位于 `packages/`（`trading-core` 业务核心、`vela` 内置图表库）。
- **应用入口**：Electron 入口源码为 `apps/desktop/main.ts`，由 tsup 编译为 `apps/desktop/dist/main.js`（CJS）；Web/API 服务入口为 `apps/web/api-server.ts`，通过 `node --experimental-strip-types` 运行。所有应用代码均为 TypeScript。
- **端口约定**：API 与生产静态托管默认 `5174`（`API_PORT`）；Vite 开发服务器 `5173`，`/api` 代理至 `5174`。
- **配置加载**：`apps/desktop/main.ts` 与 `apps/web/api-server.ts` 启动时用 `process.loadEnvFile()` 读取根目录 `.env`（缺失时忽略）；模板见 `.env.example`。`data/agent.json` 为 git-ignored 的本地密钥兜底。
- **健康检查**：`GET /api/health` 返回 `{ status, uptime }`，供 Docker `HEALTHCHECK` 与冒烟测试使用。
- **监听与 CORS**：API 默认只绑定 `127.0.0.1`（`HOST` 可覆盖），Docker 中设为 `0.0.0.0`；不发送通配 CORS 头，浏览器请求统一走同源或 Vite 代理。
- **容器化**：`Dockerfile` 单阶段构建 core/vela/web/desktop，并以 `node --experimental-strip-types apps/web/api-server.ts` 运行；`docker-compose.yml` 暴露 `5174` 并持久化 `data/cache`。
- **测试入口**：`pnpm test` 聚合 `trading-core`、`vela` 与 `apps/web` 的冒烟测试（`apps/web/test`）。
- **API 契约**：JSON 响应统一为 `{ code, message, data, timestamp }`（0 表示成功）；路由统一 `/api/v1` 前缀，旧 `/api` 保留为别名；文档见 `/api/docs` 与 `/api/v1/openapi.json`。
- **服务端分层**：`apps/web/server/` 已拆出 config/errors/logger/http/validate/db/indicators/longbridge/agent/openapi；`api-server.ts` 仅保留路由编排与请求/响应处理。SQL 仅允许出现在 `server/db.ts`。
- **类型覆盖**：`apps/web/src`、`apps/web/server` 与 `apps/desktop` 均为 TypeScript（`strict: true`）；前后端共享契约位于 `apps/web/shared/contracts.ts`（单一事实来源），全局错误由 `error-boundary.ts` 兜底，网络请求统一走 `api.ts`。
- **前端模块化**：`main.ts` 仅负责装配，拆分为 `provider/storage/sliding/topbar/agent-panel/backtest-panel/indicator-editor` 等单一职责模块；动态文本进入 `innerHTML` 前必须经 `html.ts` 的 `escapeHtml`。
- **AI 运行时（dsh）**：AI 分析与 AI 回测统一由 `@deepseek-ai/dsh` + `@deepseek-ai/dsh-sdk-client` 驱动，不再自研 tool-call 循环；Node 必须 `^22.19 || >=24`（当前要求 `>=24`），Docker 基础镜像为 `node:24-bookworm-slim`。
- **dsh 隔离**：`apps/web/server/dsh/patch.ts` 生成 cordis patch，禁用 shell/文件/子 Agent/技能等宿主工具，只保留 MCP 工具；运行时 home、会话与生成 patch 均落在 git-ignored 的 `data/dsh/`。
- **MCP 交易工具**：`apps/web/server/mcp/trading-mcp.ts` 提供行情工具；`apps/web/server/mcp/backtest-mcp.ts` 是每轮回测的 stdio 桥，经 `/api/v1/internal/backtest/:runId/tool` 回写到进程内 `BacktestToolHost`（loopback + 一次性 token）。
- **已知技术债（待后续迭代）**：`api-server.ts` 的路由编排仍较集中，可继续按领域拆分 route 模块；写接口目前依赖文件/DB 的 upsert 语义，尚未接入 `Idempotency-Key`；AI 与回测采用 SSE 长连接（Node 异步 I/O，不阻塞事件循环），尚未接入独立任务队列；dsh SDK 只推送 durable step 事件，因此 UI 的 reasoning/content 按 step 而非 token 流式呈现。

---

## 五、本地开发重启约定 (Local Dev Restart)

- **改完代码必须主动重启**：不要只交付源码，确保用户窗口加载的是最新产物。
- **前端改动**：先 `pnpm run build:web`（Electron/API 托管的是 `apps/web/dist`）。
- **桌面主进程改动**：`pnpm run build:desktop`。
- **统一重启**：结束旧的 Electron 与 API 进程后，在后台重新执行 `pnpm run dev`（会重新构建 desktop、拉起 Electron，并由 Electron spawn 新版 API）。
- **仅后端改动**：至少重启 API 进程；`pnpm run dev` 也可。
- **重启后自检**：`curl http://127.0.0.1:5174/api/health` 返回 `code: 0`，并确认 Electron 进程已起来。
