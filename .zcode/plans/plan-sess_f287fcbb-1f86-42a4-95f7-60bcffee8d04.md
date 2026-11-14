# LocalCloud backend (Postgres) + MCP server

## Context

Today LocalCloud Studio persists by rewriting `localcloud.json` (last-writer-wins, no history, no concurrency control), compiles Terraform **in the browser**, and can only be driven by the open tab. We're building a real backend with a **PostgreSQL** database: proper project persistence with versions and audit, and an MCP server that lets agents design, deploy and test environments through the same backend API the UI uses. The domain kernel (`src/utils/` + `src/data/`) is pure and headless-proven; the backend is assembly around it.

## Architecture

```
                    ┌──────────────────────────────────────────────┐
  Browser UI ──HTTP▶│  Backend (one process, Node + TS)             │
  MCP server ──HTTP▶│  · HTTP API (evolved server/api.ts)           │──▶ Postgres (projects,
  (stdio → agent)   │  · Services: projectStore · designOps ·       │    versions, runs, events)
                    │    terraformRuns · emulator                    │──▶ Docker (emulator)
                    │  · Compiles TF, runs terraform, builds zips    │──▶ working_dir per project:
                    │    — the ONLY process that executes terraform  │    terraform-out/, lambda code,
                    └──────────────────────────────────────────────┘    materialized localcloud.json
```

Key consequences of "one backend, Postgres store":
- **Multi-project registry**: projects are rows (`/api/projects` CRUD); the UI gets a project switcher; each project keeps a `working_dir` on the backend host for terraform artifacts and lambda code folders, with `localcloud.json` still materialized there as the git-committable export.
- **MCP is a thin HTTP client** of the backend (stateless adapter, stdio to the agent). No second process ever execs terraform — so no races on `terraform-out/`.
- **Concurrency control for real**: versioned saves with optimistic concurrency (409 on stale base version) **plus** Postgres advisory locks (`pg_advisory_xact_lock`) serializing terraform runs and emulator start/stop per project+env.
- **Single-writer file model**: the backend is the only writer of `localcloud.json`; external edits (git pull) are detected by hash and imported as a new version, keeping the documented workflow.

## Stack decisions

| Choice | Pick | Why |
|---|---|---|
| API server | plain `node:http`, evolved route table in `server/api.ts` | Already the pattern; no new framework dep |
| DB driver | `postgres.js` (porsager) | Pure JS (bundles with esbuild, no native dep), first-class TS |
| Schema/migrations | Drizzle ORM + `drizzle-kit` (devDep) for authoring; runner executes SQL on startup | Typed schema, small footprint, matches TS-everywhere style |
| Postgres version | 16 (docker-compose `postgres:16-alpine`) | Stable, `gen_random_uuid()` built in |
| Deployment | `localcloud-studio serve` (binds 127.0.0.1, `--db $DATABASE_URL`); `docker-compose.yml` runs postgres + backend + UI | Dev: compose for PG + `npm run dev`; npx users: compose or their own PG |
| Access control | loopback bind + optional `LOCALCLOUD_TOKEN` (Bearer) for MCP/programmatic clients | No multi-user auth in scope |
| MCP | `@modelcontextprotocol/sdk` (bundled devDep), stdio; `localcloud-studio mcp --url http://127.0.0.1:5173 [--token]` | Agent config: `{"command":"npx","args":["localcloud-studio","mcp","--url","..."]}` |

The npm package gains its first runtime deps (`postgres`, `drizzle-orm`) — both pure JS and esbuild-bundled, so the published tarball story survives. `engines.node` stays `>=18`.

## Schema (first migration)

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  working_dir TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_versions (        -- append-only design history
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version BIGINT NOT NULL,
  doc JSONB NOT NULL,                  -- full ProjectFile v2.0.0 (kept as a document, not normalized)
  doc_hash TEXT NOT NULL,              -- sha256; no-op saves deduped
  summary TEXT,                        -- "connection.create: api → handler"
  actor TEXT NOT NULL,                 -- 'ui' | 'mcp:<client>' | 'import' | 'restore'
  parent_version BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TABLE runs (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env TEXT NOT NULL, command TEXT NOT NULL, target TEXT NOT NULL DEFAULT 'emulator',
  status TEXT NOT NULL,                -- running|succeeded|failed|aborted|stale-plan
  exit_code INTEGER, plan_json JSONB, plan_inputs_hash TEXT,
  doc_version BIGINT,                  -- design version it ran against
  log TEXT,                            -- full output, capped 512KB tail
  actor TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
);

CREATE TABLE events (                  -- audit trail
  id BIGSERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  actor TEXT NOT NULL, action TEXT NOT NULL,
  payload JSONB, doc_version BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Implementation

### 1. Kernel extraction (no behavior change)
Lift from `src/store/useCloudStore.ts` into pure modules the backend also imports: `buildTerraformFiles` (lines 228–274) + `planFingerprint` (207–216) → `src/utils/terraformBundle.ts`; the `addServiceNode` construction core (510–570: id, label numbering, catalog defaults, container sizing, lambda inline seed, optional `findDropContainer`+`reparentNode`) → `src/utils/nodeFactory.ts`. Store imports them back. (Precedent: `scripts/apply-blueprints.ts` already imports src+server under `tsconfig.node.json`.)

### 2. Postgres layer + project service
- `docker-compose.yml` (postgres + backend), `server/db/schema.ts` (Drizzle), `server/db/migrations/*.sql` + runner (applied on serve start; `schema_migrations` table), `server/db.ts` (pool, advisory-lock helper).
- `server/services/projectStore.ts`: `save(doc, {baseVersion, actor, summary})` → transaction (head check → insert version → materialize `localcloud.json` via existing tmp+rename → update project row), 409-style conflict result; `getHead`, `versions`, `version(n)`, `restore(n)` (append-only), `reconcileFile()` (hash mismatch → import as new version), `diff(from,to)`.
- New routes: `GET/POST /api/projects`, `GET /api/projects/:id`, `PATCH` (rename), `DELETE`. The CLI's positional folder arg maps to the project whose `working_dir` matches (create-on-open), preserving today's UX.
- UI: project switcher in TopNavBar (dropdown + open-by-folder), `baseVersion` tracking on autosave, 409 → "Project changed externally — reload" toast.

### 3. Server-side compile + sync
`POST /api/projects/:id/terraform/sync {target}` — loads head doc, runs `buildTerraformFiles` server-side, writes `terraform-out/`/`terraform-aws/` + lambda zips (existing `writeFiles`/`buildLambdaArtifact`). UI's `syncTerraformToDisk` switches to it; in-store compile call sites and `/api/terraform/export` are **deleted**. One compile path.

### 4. Runs service + advisory locks
- Lift execution out of the `/api/terraform/run` handler (spawn, streaming, plan save + `planInputsHash` staleness guard, SG-egress untaint workaround) → `executeTerraform(opts, {onOutput, signal})`; records `runs` rows.
- `pg_advisory_xact_lock(hashtext(project || ':' || env))` around runs and emulator start/stop — UI and MCP can never terraform the same env concurrently.
- Wire format unchanged (streamed text + `__LC_EXIT__`/`__LC_PLAN__`/`__LC_PLAN_STALE__` sentinels); RunnerConsole untouched.

### 5. MCP server (HTTP client of the backend)
`server/mcp.ts` + `mcp` subcommand. Every tool is one API call or a few; ~24 tools:

*Read:* `projects_list` · `project_get` (doc + version) · `catalog_list` (34 services, field schemas, emulator-support level) · `project_validate` (linter per env) · `versions_list` / `version_get` / `version_restore` / `project_diff`
*Design (each = one version + event):* `resource_add {type, name?, fields?, parent?}` · `resource_configure {id, fields, env?}` (unknown keys rejected with valid list) · `resource_move {id, parent?}` · `resource_remove {id}` · `connection_create {from,to}` (`checkConnection` refusal = tool error) · `connection_remove {id}` · `env_override {id,env,field,value}` · `env_enable {id,env,enabled}` · `lambda_code_set {id, inline?|sourceDir?, handler?, runtime?}` · `extra_hcl_set {id,hcl,env?}` · `template_apply {id}` · `import_terraform {hcl}`
*Run:* `sync {target?}` · `emulator_status` · `emulator_start/stop {env}` · `terraform_run {command, env}` (buffered log + `summarizePlan`; lock waits surface as "busy") · `apply_plan {env}` (saved-plan + staleness guard) · `state_get {env}`
*Data:* `explore {service, operation, target?, input?, env}` (S3 list/put/get, DynamoDB list/scan/put, SQS list/send/receive, Lambda list/invoke)

### 6. CI, packaging, docs
- `.github/workflows/ci.yml`: `postgres:16` service container for the `test` job; e2e job boots backend with `DATABASE_URL` pointed at a service PG.
- `package.json`: runtime deps `postgres` + `drizzle-orm`; devDeps `drizzle-kit`, `@modelcontextprotocol/sdk`; `.gitignore` unchanged (nothing per-folder anymore — terraform-out already ignored).
- README: "Run with Postgres" (compose + DATABASE_URL paths), history/versioning model, MCP section with agent config snippet and tool table.

## Order (each phase lands green)

1. Kernel extraction → `npm test`, `tsc -b` unchanged.
2. Compose + DB layer + projectStore + projects routes + UI switcher/versioned saves → `tests/projectStore.test.ts` against a real PG (CI service; locally compose), e2e updated.
3. Server-side sync → e2e sync/run flows; `validate:golden` untouched.
4. Runs service + locks + registry → e2e wire-format identical; `tests/runs.test.ts` (terraform mocked).
5. MCP server + `mcp` subcommand → `tests/mcpTools.test.ts` (tool handlers in-process against the API), `scripts/mcp-smoke.ts` (initialize → tools/list → design chain → sync → run).
6. Docs + dogfood: register in ZCode, drive a blueprint design→sync→emulator→plan/apply→explore→restore headlessly.

## Verification

- Per phase: `npm test`, `tsc -b`, `npm run build`; `npm run test:e2e` after 2–4 (CI adds the PG service).
- Full loop via MCP against a compose stack: create project → `template_apply` → `project_validate` → `sync` → `emulator_start dev` → `terraform_run plan` → `apply_plan` → `explore lambda:invoke` → `version_restore`; assert versions/runs/events rows and that `working_dir/localcloud.json` matches head.
- Concurrency: UI save then MCP mutate → 409 path in e2e; two concurrent `terraform_run` on same env → second reports busy (advisory lock).
- `npm run test:emulator` untouched and passing.

## Out of scope

Multi-user auth/roles, remote (non-loopback) exposure beyond token, normalized relational schema for nodes/edges, UI history browser panel (API/MCP first), merge/OT (409 + reload), Kubernetes/hosted deploy.