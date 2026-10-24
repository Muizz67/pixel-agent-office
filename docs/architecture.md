# Architecture

This document explains how Pixel Agent Office is put together, why the pieces are separated the way they are, and how the reliability and security guarantees are enforced. It is aimed at someone extending or reviewing the code, not at end users.

---

## Design goals

1. **Runnable offline** — the complete product must work without an API key or network so it can be demoed and tested deterministically.
2. **Visible multi-agent work** — the pixel office must reflect real orchestration state, not a separate animation script.
3. **Real boundaries** — agents may only use tools through a policy layer; tools may only touch a per-mission sandbox.
4. **Durable and recoverable** — a crash must not lose the mission record, and the next boot must explain what happened and allow resume.
5. **Incremental delivery** — four phases with a working product at the end of each.

Non-goals: multi-tenant identity, horizontal scaling, a general-purpose agent framework, and arbitrary shell access.

---

## System context

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser                                                             │
│  React 19 + Vite                                                    │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────────────┐ │
│  │ App.tsx      │  │ officeState    │  │ OfficeCanvas             │ │
│  │ actions/boot │◄─┤ pure reducer   │  │ procedural sprites       │ │
│  └──────┬───────┘  └───────▲────────┘  └──────────────────────────┘ │
│         │ fetch JSON       │ AnyRunEvent                             │
│         │                  │                                         │
│  ┌──────▼───────┐  ┌───────┴────────┐                               │
│  │ api.ts       │  │ useRunStream   │  fetch-based SSE + recovery   │
│  └──────┬───────┘  └───────▲────────┘                               │
└─────────┼──────────────────┼─────────────────────────────────────────┘
          │ HTTP             │ text/event-stream
┌─────────▼──────────────────┴─────────────────────────────────────────┐
│ Fastify server                                                       │
│  auth · origin · rate limit · Zod · CSP · static UI · metrics        │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ OfficeOrchestrator                                              │ │
│  │  start / resume / cancel / shutdown                             │ │
│  │  Planner ─► validated dependency graph ─► scheduler             │ │
│  │  RunBudget · retries · task lifecycle · completion summary      │ │
│  └───────────────┬──────────────────────────────┬──────────────────┘ │
│                  │                              │                    │
│  ┌───────────────▼──────────────┐  ┌────────────▼─────────────────┐  │
│  │ AgentRuntime (per task)      │  │ AgentPresence                │  │
│  │  model loop · tool policy    │  │  shared office floor state   │  │
│  │  approvals · artifacts       │  └────────────┬─────────────────┘  │
│  └───────────────┬──────────────┘               │                    │
│                  │                              │                    │
│  ┌───────────────▼──────────────┐  ┌────────────▼─────────────────┐  │
│  │ ToolRegistry                 │  │ RunEventService              │  │
│  │  workspace · commands · fetch│  │  persist seq + in-process bus│  │
│  └───────────────┬──────────────┘  └────────────┬─────────────────┘  │
└──────────────────┼──────────────────────────────┼────────────────────┘
                   │                              │
          ┌────────▼────────┐            ┌────────▼────────┐
          │ Mission sandbox │            │ SQLite (WAL)    │
          │ workspaces/...  │            │ data/office.db  │
          └─────────────────┘            └─────────────────┘
```

---

## Runtime composition

`createOffice(config, logger)` in `src/server/office.ts` is the composition root. It constructs, in order:

1. `OfficeDatabase` — opens SQLite, enables foreign keys/WAL/busy timeout, runs migrations.
2. `Stores` — `runs`, `tasks`, `events`, `approvals`, `artifacts`, `audit` repositories.
3. `RunEventService` — assigns per-run sequence numbers and publishes to an in-process bus.
4. `AgentPresence` — mutable view of the five agents; emits `agent.updated` / `agent.message`.
5. `ApprovalBroker` — durable approval rows plus in-memory promises and timers.
6. Provider bundle — mock or OpenAI-compatible planner + worker client.
7. `ToolRegistry` — built from config feature flags.
8. `OfficeOrchestrator` — owns active controls, planning, scheduling, terminal transitions.
9. `recoverFromRestart()` — marks abandoned work and resets presence.

`close()` shuts down the orchestrator (aborting active controls) and closes the database. The Fastify app is built separately in `app.ts` and accepts the runtime; this makes the HTTP surface testable with a real runtime but without a network listener.

The dependency direction is intentionally one-way:

```
app → orchestrator → agent-runtime → tools
                 ↘ events ← presence
                 ↘ stores → database
```

Tools never import the orchestrator; the runtime never imports Fastify; the client only imports `shared/`.

---

## Data model

SQLite is the system of record. Events are the append-only activity log; the other tables hold current state for fast snapshots.

| Table | Key | Purpose |
| --- | --- | --- |
| `runs` | `id` | Goal, status, provider/models, workspace, task cap, token/tool usage, timestamps, optional unique idempotency key |
| `tasks` | `id`, ordered by `ordinal` | Brief, agent, status, priority, JSON `depends_on`, result/error, attempts, usage, timestamps |
| `events` | `(run_id, seq)` | Type, JSON payload, agent/task attribution, timestamp |
| `approvals` | `id` | Tool call, JSON arguments, risk, reason, status, expiry, resolution note |
| `artifacts` | `id`, unique `(run_id, path)` | Workspace-relative path, byte count, producing task/agent |
| `audit_log` | `id` | Actor, action, resource, JSON metadata, timestamp |

Indexes cover run recency/status, tasks by run/ordinal, events by run/seq, approvals by run/status, artifacts by run, and audit recency.

`events.seq` is allocated inside a transaction with `SELECT MAX(seq) … ; INSERT`, so concurrent writers cannot produce duplicates. WAL plus a 5 s busy timeout handles overlapping reads/writes in a single-process deployment.

Migrations use `PRAGMA user_version`; the current schema is one idempotent migration block.

### State machines

**Run**

```
planning ──► running ──► completed
   │            │
   │            ├──► failed
   │            ├──► cancelled
   │            └──► interrupted ──► (resume) running
   └──────────────────────────────► failed / cancelled / interrupted
```

**Task**

```
queued ──► running ──► completed
  ▲           │  │
  │           │  └──► waiting_approval ──► running
  │           │                └─────────► failed / cancelled
  │           └──► queued (retry, attempts < maxAttempts)
  └── resume reset (non-completed) / restart recovery
```

Terminal task states other than `completed` (`failed`, `blocked`, `cancelled`) stop the scheduler and fail the mission unless cancellation/shutdown is the cause.

---

## Planning

The CEO is a distinct layer (`planner.ts`), not a worker with a special prompt:

1. A fixed system prompt lists the worker roster and planning rules.
2. The model is given exactly one tool, `submit_plan`, with a strict JSON schema.
3. `planSchema` (Zod) validates shape, keys, lengths, agents, priorities, and dependency arrays.
4. `validatePlan` enforces the task cap, unique keys, known dependencies, no self-dependency, and no cycles (DFS with a visiting set).
5. On schema or graph failure, the planner sends structured feedback and retries once. A non-retryable provider error fails immediately.
6. `normalizePlan` maps stable plan keys to generated task ids, preserves order, and records max attempts.
7. Planning usage is attributed to the run; the plan summary is emitted and persisted.

No model output is trusted directly. The planner cannot assign work to the CEO, cannot invent agents, and cannot exceed the configured task cap.

---

## Scheduling

`OfficeOrchestrator.schedule` is a single event-driven loop per mission:

- Load tasks, stop when all are `completed`.
- Sort candidates by priority, then creation time, then id.
- Start a task only if all of the following hold: it is `queued`, its agent is not already busy, its dependencies are `completed`, its retry backoff has elapsed, and the concurrency cap is not reached.
- Wait on `Promise.race` of active task promises and an abort wake-up.
- If nothing can start:
  - wait for the nearest retry time, or
  - fail fast when a queued task has unsatisfiable dependencies, or
  - fail when an unfinished task is stranded (`running`/`waiting_approval`/`blocked`/`failed`/`cancelled`) with no active runtime.

Consequences:

- Independent tasks run in parallel up to `MAX_CONCURRENT_TASKS`.
- A single agent never runs two tasks simultaneously.
- Dependencies are data, not ordering side effects.
- The loop is abortable, so cancellation does not wait for a full polling cycle.

### Failure and retry policy

- **Model call** — `withRetry` retries only `LlmError` marked retryable, up to 3 attempts with jittered exponential backoff.
- **Task** — a retryable outcome requeues the task up to `MAX_TASK_ATTEMPTS` with 750 ms → 8 s backoff; the attempt count is persisted.
- **Permanent / budget** — fails the mission; budget failures are never retried.
- **Dependency failure** — the scheduler aborts the mission with the failing task's error because dependents can never become runnable.
- **Cancellation / shutdown** — aborts the signal, stops launching work, and records terminal state without retrying.

---

## Agent runtime

`AgentRuntime.runTask` executes exactly one task for one specialist.

```
build messages (role + mission + review protocol + task + dependency handoffs)
for step in 1..MAX_AGENT_STEPS:
  assert not aborted
  call model with tool definitions
  persist usage (task + run + budget)
  if no tool calls: final answer
  else: execute each tool call in order, append tool feedback
```

Guards:

- Empty final responses and hitting the step limit without a final answer are failures.
- Final results are clipped (20k chars), tool feedback is clipped (30k), dependency handoffs are clipped (16k) to bound context growth.
- Every tool call re-checks the abort signal.
- Usage is recorded through orchestrator hooks so the run row, task row, and budget stay consistent.

### Tool call pipeline

```
model tool call
  → registry.policy(name, input)
      unknown tool            → denied
      command/fetch (gated)   → approval required
      otherwise               → allowed
  → presence: waiting / tool activity
  → approval.requested → human decision or timeout/abort
      denied/expired/cancelled → tool.failed, no execution
  → registry.execute
      workspace guard / command validation / SSRF checks
  → tool.completed | tool.failed
  → tool result appended as model feedback
```

Every request and resolution is a persisted event, and approvals are also rows, so a pending approval can be shown after a refresh. The broker resolves exactly once: approve/deny, timeout, or run abort; later attempts raise a conflict.

Tool inventory:

| Tool | Risk | Approval | Confinement |
| --- | --- | --- | --- |
| `list_files` | low | never | workspace, symlinks skipped |
| `read_file` | low | never | workspace, 64 KiB, binary detection |
| `search_files` | low | never | workspace, 600 files / 256 KiB each, max results |
| `write_file` | medium | never | workspace, 256 KiB, atomic temp+rename |
| `run_command` | high | always (unless disabled) | allowlist, no shell, sanitized env, bounded output |
| `fetch_url` | high | always | public http(s), DNS/IP checks, redirect re-validation |

`run_command` and `fetch_url` are not even registered unless their feature flags are on, which shrinks the model's visible tool list as well as the attack surface.

---

## Events and streaming

`RunEventService` is the single write path for run events:

- `emit(runId, type, payload, { agentId, taskId })`
- `append` assigns the next sequence inside SQLite
- the persisted event is published to subscribers for that run
- `replay(runId, after, limit)` reads the ordered log

SSE delivery (`app.ts`) follows a replay-then-live pattern:

1. Parse `after` from the query or `Last-Event-ID`.
2. Subscribe first and buffer live events while replay is in progress (closes the race between snapshot and subscription).
3. Replay persisted events, sending only `seq > lastSent`.
4. Flush the buffer, deduplicating by sequence.
5. Heartbeat every 15 s.
6. On a terminal event, schedule a close after 300 ms so the client receives it cleanly. Terminal lifecycle events are emitted last by the orchestrator, after final task and presence updates, so a client that stops at the terminal frame still has the final state.

The client (`useRunStream.ts`) does not use `EventSource` because it cannot attach the auth header, and its automatic reconnect would replay from the original URL. Instead it:

- sends the auth header and `after=<last seq>`,
- parses SSE frames manually,
- advances `lastSeq` only on accepted events,
- reconnects after 1.2 s on a clean EOF or 2.5 s on an error,
- stops on a terminal event or on `401` (which raises the token gate).

The snapshot endpoint replays up to 2,000 events; the stream replays up to 5,000 per connection. The log remains complete in SQLite regardless.

---

## Frontend architecture

The UI is a thin, deterministic projection of server state.

- **`api.ts`** — typed fetch wrapper, shared token capture (`?token=` → `sessionStorage`), normalized `ApiError`.
- **`App.tsx`** — boot/hydrate/select-run orchestration, mission actions (start/cancel/resume), approval actions, artifact preview, toasts, auth gate, responsive layout. A selection token prevents stale snapshot responses from overwriting a newer selection.
- **`officeState.ts`** — a pure reducer. `applySnapshot` replaces run/tasks/approvals/artifacts/agents/events; `applyRunEvent` handles each event type, deduplicates by sequence, keeps agent views current, and caps the activity list. No React or network dependencies, so it is easy to reason about and test.
- **`useRunStream.ts`** — resilient SSE transport (above).
- **`useNow.ts`** — a coarse timer for elapsed labels, so stream events do not force a render every frame.
- **`OfficeCanvas` + `sprites.ts`** — a fixed 960×540 procedural scene. Agent feet positions come from their `home` profile plus a deterministic desk/meeting/whiteboard layout. Sprites are drawn in code (no image assets), and animation is CSS/canvas driven.
- **Panels** — mission brief, run history, task board, approvals, activity feed, deliverables, agent roster, artifact modal. Each is presentational and receives state/handlers from `App`.

Streaming is enabled only when the selected run is active and its snapshot is not loading. `streamAfter` is frozen at the snapshot's maximum sequence; the hook then tracks later sequences internally. This prevents a re-render loop from reopening the stream on every event.

The app intentionally does not use React `StrictMode`: its development double-mount would bootstrap twice and churn the SSE connection.

---

## Security layers

| Layer | Implementation |
| --- | --- |
| Network binding | Loopback default; production refuses non-loopback without a token |
| API authentication | `X-Office-Token` or SSE `?token=`; `timingSafeEqual`; health/root exempt |
| CSRF/origin | Non-GET requests with an `Origin` must be loopback, same-host, or explicitly allowed |
| Input validation | Zod `.strict()` schemas for start, approval, ids, and artifact paths; 128 KiB body cap |
| Rate limiting | Fixed-window in-memory limiter per IP: 8 mission starts/min, 300 API calls/min |
| Idempotency | Optional `Idempotency-Key` with a unique partial index; duplicate start returns the original run |
| Headers | CSP, frame denial, nosniff, no-referrer, permissions policy; separate SSE CSP |
| Path safety | Workspace guard: relative paths only, no traversal/null bytes, realpath check of nearest existing ancestor, symlink escape rejection |
| Command safety | `spawn` with `shell: false`, allowlist + argument rules, sanitized env, timeout, output cap, process-tree kill |
| Network fetch safety | Protocol/credential checks, DNS resolution against private ranges, redirect re-validation, size/time caps |
| Human approval | Durable high-risk tool gate with timeout, cancel-on-abort, and single resolution |
| Resource limits | Model/task steps, tokens, tool calls, concurrency, task count, run wall clock, request timeout |
| Audit | Mission, plan, approval, recovery, and completion records |

The artifact preview route is deliberately constrained: the path must match an artifact row for that run, the file must still exist, be a regular file, and be at most 512 KiB; reads go through the same workspace guard.

### Threat model notes

- The token is a **shared secret**, not per-user authorization. Anyone with it has full operator powers.
- The mock provider is deterministic but not a security boundary; live model output is untrusted input to the tool layer.
- HTML fetched by `fetch_url` is text for the model. The UI never renders fetched HTML or artifact content as HTML; previews are text.
- A determined operator with shell tools enabled and approval rights can run the allowlisted commands on the host. That is the intended trust boundary.
- Rate limiting and the event bus are in-process; horizontal scaling would need a shared limiter and pub/sub.

---

## Budgets, timeouts, cancellation

- **Token accounting** — every model response reports input/output tokens. Planner usage is added to the run before scheduling; worker usage is added to the task and the run through the runtime hooks. The mock provider estimates tokens from text length, while live providers use the API's `usage` fields. `/api/metrics` and `/metrics` expose persisted totals, and the mission panel shows the run's tokens.
- `RunBudget` tracks input+output tokens and tool calls, emits a one-time warning at 80%, and throws `BudgetExceededError` at the limit.
- The wall-clock timer aborts the mission at `RUN_TIMEOUT_MS` and reports the limit in the error.
- `MAX_AGENT_STEPS` bounds each task loop; `MAX_CONCURRENT_TASKS` bounds parallel work.
- Cancellation sets `cancelRequested`, aborts the shared signal, lets active promises settle (up to 5 s), then marks queued/running/waiting tasks `cancelled`, cancels approvals, and writes `run.cancelled`.
- Shutdown is the same path with a different terminal reason: `run.interrupted`, so it is resumable.

---

## Restart recovery

`recoverFromRestart()` runs during composition, before the HTTP server listens:

1. Any `planning`/`running` run becomes `interrupted` with an explanatory error and completion timestamp.
2. Its `running`/`waiting_approval` tasks become `queued` with a restart note.
3. Its `pending` approvals become `expired`.
4. Presence resets to idle.
5. Each recovered run is audited and logged.

`resume(runId)` accepts only an `interrupted` run with no other active mission:

1. Reset unfinished tasks to `queued`, clear attempts/results/timestamps; cancel any remaining pending approvals.
2. Mark the run `running` (or `planning` if it never produced tasks), clear the error, and emit `run.resumed`.
3. Start a fresh control and run the normal scheduler; completed tasks are skipped, dependencies still apply.
4. Resume with zero tasks re-enters planning.

A produced-but-not-persisted plan cannot exist because planning and task insertion complete before scheduling. A task that was mid-tool-call is re-executed from scratch, which is safe because each mission has an isolated workspace and tools are replayed rather than resumed.

---

## Observability

- Structured pino logs with request-level errors and mission lifecycle warnings.
- `/api/metrics` — JSON status counts, usage totals, pending approvals, artifacts, events, active runs, uptime, provider.
- `/metrics` — Prometheus text: runs/tasks by status, tokens by kind, tool calls, approvals, artifacts, events, active runs, uptime, build/provider info.
- `/api/audit` and the durable `audit_log` for operator actions.
- The UI activity feed is the human-readable projection of the event log.

---

## Testing strategy

Tests use temporary data directories and workspaces, the mock provider with zero latency, and silent logging.

| File | Coverage |
| --- | --- |
| `plan.test.ts` | schema limits, unknown/duplicate/self dependencies, cycles, normalization |
| `workspace.test.ts` | relative path rules, traversal, null bytes, symlink escape, new-file ancestor checks |
| `approvals.test.ts` | persistence, approve/deny, single resolution, abort cancellation, timeout expiry |
| `api.test.ts` | health/config/bootstrap, auth rejection, idempotent start, concurrent-run conflict, snapshot/SSE/artifact content |
| `recovery.test.ts` | restart transition of run/task/approval, audit entry, successful resume |
| `office.integration.test.ts` | full mock mission: planning, parallel work, artifacts, terminal state, audit |

The deterministic mock provider makes these tests fast and non-flaky; live-provider behavior is exercised through the same interfaces by swapping `ProviderBundle`.

---

## Phase mapping

### Phase 1 — Foundation

- Vite + React 19 client, Fastify 5 server, TypeScript strict mode, Vitest.
- Dependency-free shared contracts (`src/shared`).
- Zod configuration, pino logging, error envelope, `node:sqlite` schema and repositories.
- Idempotent migrations; WAL; indexes.
- API shell (health/config/bootstrap/runs) and UI shell with boot/error states.
- Design system, responsive layout, pixel-themed CSS.

### Phase 2 — Agent runtime and tools

- `LlmProvider` abstraction with mock and OpenAI-compatible implementations.
- Planner with `submit_plan`, schema/graph validation, repair retry.
- Per-task agent loop with step limits, usage accounting, dependency handoffs.
- Built-in workspace tools, workspace guard, atomic writes.
- Optional allowlisted command runner and SSRF-hardened fetch.
- Durable approval broker with timeout, abort, and audit.
- Presence updates and the activity/task UI.

### Phase 3 — CEO orchestration

- Mission lifecycle (`planning` → `running` → terminal), single-active-mission rule.
- Priority/dependency/concurrency scheduler with busy-agent tracking.
- Cancellation and completion summaries; office-wide celebration state.
- Sequenced event service and SSE replay.
- Pixel office canvas, procedural agents, live roster, mission/run history panels.
- End-to-end mock mission test.

### Phase 4 — Reliability and security

- Token budget, tool-call budget, wall-clock timeout, 80% warnings.
- Model retries and task retries with persisted attempts/backoff.
- Restart recovery, resume, graceful shutdown.
- API token, origin checks, rate limits, idempotency, CSP/security headers.
- JSON and Prometheus metrics, audit log.
- Reconnect-safe client stream and pure reducer.
- Test suite expansion, README, architecture documentation.

---

## Extension points

**Add a tool** — implement `AgentTool` in `src/server/tools/`, validate its input with Zod, define a policy, register it in `ToolRegistry` behind a config flag, and add path/network guards as appropriate. The runtime will advertise it automatically.

**Add an agent** — add a profile to `AGENT_PROFILES`, include it in `WORKER_AGENT_IDS`, give it a sprite in `sprites.ts` and a home position in the scene. Planner validation and presence pick it up from the shared constants.

**Add a provider** — implement `LlmProvider.complete()` returning content, tool calls, and usage; map errors to `LlmError` with a `retryable` flag; add it to `createProviderBundle()`. The planner and runtime need no changes.

**Change persistence** — repositories are small classes behind `Stores`; swapping SQLite would require reimplementing them plus the migration and recovery SQL, but not the orchestrator.

**Add UI** — consume `OfficeViewState` and dispatch actions in `App.tsx`; keep derivations pure and avoid side effects in render.

---

## Known limitations

- One mission at a time per process; no queueing of pending missions.
- The event bus, rate limiter, approvals, and active controls are in-memory; a multi-instance deployment needs shared infrastructure.
- SSE replays at most 5,000 events per connection; very large runs rely on snapshot + later sequences.
- Resume re-executes an interrupted task from the beginning rather than resuming mid-tool-call.
- The shared token has no roles or per-user audit identity.
- The mock provider is intentionally simple; it demonstrates orchestration, not model quality.
- Workspace artifacts are plaintext on disk; there is no encryption at rest.
