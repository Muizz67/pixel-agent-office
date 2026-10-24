# Pixel Agent Office

A runnable, local-first multi-agent AI workspace: a CEO agent plans a mission, delegates to four specialists, and the whole team works inside an animated pixel-art office. Every task, tool call, approval, event, and deliverable is persisted in SQLite and streamed live to the browser.

The default **mock provider** makes the full product work offline, with no API key and no network. Set `OPENAI_API_KEY` to swap in a live model without changing any other code.

---

## Highlights

- **CEO orchestration** — a planner turns a goal into a validated 1–12 task dependency graph, assigns specialists, and reports the outcome.
- **Four worker agents** — research, design, engineering, and review, each with its own system prompt and workspace tools.
- **Live pixel office** — agents walk to desks, show speech bubbles, wait for approvals, and celebrate together when the mission lands.
- **Real tool use** — list/read/search/write files, a per-mission sandbox, and optional approval-gated commands and URL fetches.
- **Durable by default** — SQLite (WAL) stores runs, tasks, events, approvals, artifacts, and an audit log. In-flight work is recovered after a restart.
- **Crash-safe streaming** — sequence-numbered events over SSE with replay via `after` / `Last-Event-ID`, plus a pure client reducer.
- **Production hardening** — budgets, wall-clock timeouts, retries with backoff, cancellation, optional bearer token, origin checks, rate limits, CSP, path confinement, and Prometheus metrics.
- **Tested** — unit and integration tests cover planning, workspace escapes, approvals, HTTP lifecycle, recovery, and a full mock mission.

---

## Quick start

### Prerequisites

- **Node.js 24+ recommended.** The server uses the built-in `node:sqlite` module. Node 22.5–23.3 requires `--experimental-sqlite`; Node 24 has it enabled.
- npm 10+.

### Run the demo (offline)

```bash
npm install
npm run dev
```

Open <http://localhost:5173>, enter a mission goal, and watch the office work.

- Vite serves the UI on port `5173` and proxies `/api` to the server.
- Fastify runs on `127.0.0.1:8787`.
- With no `OPENAI_API_KEY`, the mock provider plans and executes a realistic mission locally, including writing artifacts into the sandbox.

### Run the production build

```bash
npm run build
npm start
```

Open <http://localhost:8787>. The server serves `dist/client` and falls back to `index.html` for client routes.

### Use a live model

```bash
cp .env.example .env       # Windows: Copy-Item .env.example .env
# then edit .env
```

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# Optional role overrides:
PLANNER_MODEL=gpt-4o
WORKER_MODEL=gpt-4o-mini
```

`LLM_PROVIDER=auto` (the default) selects OpenAI automatically when `OPENAI_API_KEY` is set, otherwise the mock provider. Any OpenAI-compatible chat-completions endpoint can be used via `OPENAI_BASE_URL`, but it must support **tool/function calling** because both the planner and the workers use tools.

---

## Using the office

1. **Brief the CEO.** Type a goal in the mission panel or pick a suggestion, optionally cap the number of tasks, and start the mission. Only one mission runs at a time in a single office.
2. **Watch the floor.** The CEO plans, then specialists move between their desks, the meeting table, and the whiteboard as their tasks change state. The right-hand roster mirrors live presence.
3. **Unblock work.** If a gated tool is enabled, the agent raises an approval. Approve or deny it with an optional note; ignored approvals expire after `APPROVAL_TIMEOUT_MS`.
4. **Review the output.** Completed tasks show handoffs; files written to the sandbox appear under Deliverables and can be previewed in a modal. Activity records every event, including tool calls and budget warnings.
5. **Steer or recover.** Cancel a running mission, or resume an `interrupted` one after a restart. The run history shows past missions and their final state.

The UI is responsive down to tablet width, respects `prefers-reduced-motion`, and exposes a lightweight boot/auth screen.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server + Vite UI with hot reload |
| `npm run dev:server` | Server only (`tsx watch`) |
| `npm run dev:web` | Vite UI only |
| `npm run build` | Typecheck, then build the client into `dist/client` |
| `npm start` | Run the server (serves the built UI if present) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Watch mode |
| `npm run check` | Typecheck + tests + production build |

---

## Configuration

All values are optional; `.env` is loaded from the working directory. Invalid values fail fast with a readable message.

### Server

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Non-loopback hosts require `OFFICE_API_TOKEN` in production. |
| `PORT` | `8787` | |
| `NODE_ENV` | `development` | `production` enforces the token rule. |
| `LOG_LEVEL` | `info` | pino level, including `silent`. |
| `DATA_DIR` | `./data` | SQLite directory (`office.db`, WAL files). |
| `WORKSPACE_ROOT` | `./workspaces` | Root for per-mission sandboxes. |

### Provider

| Variable | Default | Notes |
| --- | --- | --- |
| `LLM_PROVIDER` | `auto` | `auto`, `mock`, or `openai`. |
| `OPENAI_API_KEY` | empty | Required for `openai`; enables `auto`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Must be http(s). |
| `OPENAI_MODEL` | `gpt-4o-mini` | Base model. |
| `PLANNER_MODEL` | `OPENAI_MODEL` | CEO planning model. |
| `WORKER_MODEL` | `OPENAI_MODEL` | Specialist model. |
| `LLM_TIMEOUT_MS` | `90000` | Per model request. |
| `MOCK_LATENCY_MS` | `350` | Artificial delay for the offline demo; use `0` in tests. |

### Orchestration

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_CONCURRENT_TASKS` | `2` | 1–4. Each agent runs at most one task at a time. |
| `MAX_TASKS_PER_RUN` | `8` | 1–12. Also caps a caller's `maxTasks`. |
| `MAX_AGENT_STEPS` | `8` | Model/tool loop limit per task. |
| `MAX_TASK_ATTEMPTS` | `2` | Retry limit for transient failures. |
| `MAX_RUN_TOKENS` | `60000` | Input + output tokens per mission. |
| `MAX_TOOL_CALLS_PER_RUN` | `80` | Tool invocations per mission. |
| `RUN_TIMEOUT_MS` | `900000` | Wall-clock limit per mission. |
| `APPROVAL_TIMEOUT_MS` | `600000` | Pending approval expiry. |

### Tools and security

| Variable | Default | Notes |
| --- | --- | --- |
| `ENABLE_SHELL_TOOLS` | `false` | Registers the allowlisted `run_command` tool. |
| `ENABLE_FETCH_TOOL` | `false` | Registers the SSRF-hardened `fetch_url` tool. |
| `REQUIRE_APPROVAL_FOR_COMMANDS` | `true` | If `false`, commands run without an approval prompt. |
| `OFFICE_API_TOKEN` | empty | Shared secret for the API and SSE. |
| `ALLOWED_ORIGINS` | empty | Comma-separated extra origins for non-GET requests. |

---

## HTTP API

All routes are JSON. Errors use `{ "error": { "code", "message", "details?" } }`. When `OFFICE_API_TOKEN` is set, send `X-Office-Token`; SSE may instead use `?token=`. `/api/health` and `/api` stay public for liveness.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, database, provider, active runs, uptime |
| `GET` | `/api/config` | Public provider info, limits, feature flags |
| `GET` | `/api/bootstrap` | Agents, active run, recent runs |
| `GET` | `/api/agents` | Current agent presence |
| `GET` | `/api/runs?limit=&offset=` | Run history |
| `POST` | `/api/runs` | Start a mission (`goal`, optional `maxTasks`, optional `Idempotency-Key`) |
| `GET` | `/api/runs/:id` | Full snapshot: run, tasks, events, approvals, artifacts, agents |
| `GET` | `/api/runs/:id/events?after=&limit=` | Event replay |
| `GET` | `/api/runs/:id/stream?after=` | SSE live stream + replay |
| `POST` | `/api/runs/:id/cancel` | Cancel an active mission |
| `POST` | `/api/runs/:id/resume` | Resume an `interrupted` mission |
| `POST` | `/api/runs/:id/approvals/:approvalId` | `{ decision: "approve" \| "deny", note? }` |
| `GET` | `/api/runs/:id/artifacts` | Artifact metadata |
| `GET` | `/api/runs/:id/artifacts/content?path=` | UTF-8 artifact preview (≤ 512 KiB) |
| `GET` | `/api/audit?limit=` | Recent audit entries |
| `GET` | `/api/metrics` | JSON metrics |
| `GET` | `/metrics` | Prometheus text metrics |

### SSE contract

Each event frame is:

```
id: <seq>
event: <type>
data: {"id":"evt_…","runId":"run_…","seq":42,"type":"task.updated",…}

```

- `seq` is monotonic per run; clients pass the last seen value as `after` (or `Last-Event-ID`) to replay exactly what they missed.
- The server replays persisted events first, buffers live events during replay, then streams. Duplicate sequences are dropped.
- A `retry: 3000` hint and a 15-second keepalive comment are sent.
- After a terminal event (`run.completed`, `run.failed`, `run.cancelled`, `run.interrupted`), the stream closes shortly after.
- Event types: `run.created`, `run.planning`, `run.started`, `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted`, `run.resumed`, `run.updated`, `plan.created`, `task.created`, `task.updated`, `agent.updated`, `agent.message`, `tool.started`, `tool.completed`, `tool.failed`, `approval.requested`, `approval.resolved`, `artifact.created`, `budget.warning`, `log`.

The browser uses a small `fetch`-based SSE client rather than `EventSource`, because it needs the auth header and explicit sequence recovery.

---

## Security model

This is a **local-first** tool. The defaults are deliberately conservative.

- **Binding** — loopback only by default. Production refuses a non-loopback host without a token.
- **API auth** — optional shared token, compared with `timingSafeEqual`, required for every API route except health. The UI captures `?token=` once, stores it in `sessionStorage`, and strips it from the URL.
- **Request checks** — strict Zod schemas, 128 KiB body limit, 30 s request timeout, origin allowlist for state-changing requests, `Idempotency-Key` support for mission starts, and per-IP rate limits (8 starts/min, 300 API calls/min).
- **Response hardening** — CSP, `X-Frame-Options: DENY`, `nosniff`, no-referrer, restrictive permissions policy; the SSE response uses its own sandbox CSP.
- **Workspace confinement** — every file tool resolves paths inside `workspaces/missions/<runId>`, rejects absolute paths, traversal, null bytes, and symlink escapes, and re-checks the nearest existing ancestor for new files.
- **Tool policy** — read/list/search are always allowed; writes are workspace-only; `run_command` and `fetch_url` are disabled unless enabled and then require human approval (commands can be configured to skip approval). Unknown tools are denied.
- **Commands** — no shell, allowlisted `node` (`--version`, `--check <workspace file>`) and read-only `git` subcommands, sanitized environment, 30 s cap, bounded output, process-tree kill on timeout/cancel.
- **Fetch** — http(s) only, DNS resolution checked against private/loopback/link-local ranges, redirects re-validated, bounded time and size, text/JSON/HTML only.
- **Budgets** — token, tool-call, step, and wall-clock limits stop runaway loops. Budget exhaustion fails the mission instead of silently continuing.
- **Audit** — mission lifecycle, plans, approvals, and security-relevant actions are recorded in `audit_log`.

Do not expose this server to the public internet without putting it behind your own authenticated proxy and reviewing the tool flags. The token is a shared secret, not a user account system.

---

## Reliability and recovery

- **Durable state** — WAL SQLite with foreign keys and idempotent migrations. Runs, tasks, events, approvals, artifacts, and audit survive restarts.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` aborts active work, marks the mission `interrupted`, cancels pending approvals, flushes the database, and forces exit after 15 s.
- **Restart recovery** — on boot, any `planning`/`running` mission becomes `interrupted`; `running`/`waiting_approval` tasks are requeued; pending approvals expire. Resume resets unfinished tasks and cancelled approvals, then continues the dependency graph.
- **Idempotent starts** — a repeated `Idempotency-Key` returns the original run instead of launching a duplicate.
- **Retries** — transient model errors retry with jittered exponential backoff (3 attempts inside a step); transient task failures requeue up to `MAX_TASK_ATTEMPTS` with backoff. Budget failures and permanent model errors do not retry.
- **One mission at a time** — the API returns `409` with the active run id if you try to start or resume concurrently.
- **SSE recovery** — reconnects pass the last sequence so the UI converges to the persisted event log, even across a server restart.

---

## Tests

```bash
npm test
```

The suite runs against temporary SQLite databases and sandboxes:

- `tests/plan.test.ts` — plan validation, duplicate/unknown dependencies, cycles, normalization.
- `tests/workspace.test.ts` — traversal, absolute paths, symlink escapes, relative path helpers.
- `tests/approvals.test.ts` — approve/deny, abort cancellation, expiry.
- `tests/api.test.ts` — health/bootstrap, auth, idempotent starts, concurrency rejection, SSE, artifacts.
- `tests/recovery.test.ts` — restart marks work interrupted, expires approvals, and resume completes the mission.
- `tests/office.integration.test.ts` — a full mock mission from start to artifacts and audit.

---

## Project structure

```
src/
  shared/            dependency-free contracts and formatters
  server/
    app.ts           Fastify API, auth, SSE, static UI, metrics
    orchestrator.ts  mission lifecycle, planning, scheduling, recovery
    agent-runtime.ts worker loop, tool calls, approvals, task persistence
    planner.ts       CEO planning with validation and repair
    plan.ts          plan schema + graph validation + normalization
    db.ts            schema, migrations, repositories, recovery SQL
    events.ts        sequenced persistence + in-process bus
    approvals.ts     durable human-in-the-loop broker
    budget.ts        token/tool/time limits and warnings
    agents.ts        shared presence for the office floor
    tools/           workspace guard, builtin tools, commands, safe fetch
    llm/             provider interface, mock, OpenAI-compatible client
  client/
    App.tsx          app state, mission actions, layout
    officeState.ts   pure event reducer
    useRunStream.ts  resilient fetch-based SSE
    components/      mission, stage, tasks, approvals, feed, artifacts…
    office/          canvas office and procedural pixel sprites
tests/               unit and integration suite
docs/architecture.md deeper design notes and phase mapping
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `node:sqlite` cannot be found | Use Node 24+, or start Node 22.5+ with `--experimental-sqlite`. |
| `EADDRINUSE` on 8787 | Stop the other server or set `PORT`. |
| UI shows a token gate / `401` | Open the URL with `?token=<OFFICE_API_TOKEN>` once; it is kept in `sessionStorage`. |
| Mock mission instead of live model | Set `LLM_PROVIDER=openai` and a valid `OPENAI_API_KEY`, then restart. |
| Provider rejects tools | Use a model/endpoint with OpenAI-style tool calling. |
| Want a clean office | Stop the server, then delete `data/` and `workspaces/`. |

---

## Phase mapping

The implementation was built in four increments; see [docs/architecture.md](docs/architecture.md#phase-mapping) for the exact deliverables.

1. **Foundation** — scaffold, shared contracts, configuration, SQLite persistence, API shell, UI shell.
2. **Agent runtime and tools** — providers, planner, worker loop, sandboxed tools, approvals.
3. **CEO orchestration** — dependency scheduling, delegation, presence, live pixel office.
4. **Reliability and security** — budgets, retries, cancellation, auth, rate limits, SSE recovery, restart recovery, tests, metrics, docs.

## License

Private demo project. No license is granted for redistribution.
