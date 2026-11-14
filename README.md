# LocalCloud Studio

Design AWS infrastructure on a 2D canvas, compile it to Terraform for four environments at once, and deploy it to [AWS Emulator](https://github.com/aws/aws-emulator) running locally. When it works locally, export Terraform for your real AWS accounts and deploy it with your usual pipeline. LocalCloud itself only ever runs against the emulator.

Designs, version history, runs and an audit trail live in a **PostgreSQL** database behind the local backend; every project also keeps its `localcloud.json`, `terraform-out/` and Lambda code folders on disk. Agents can drive the whole thing through the built-in **MCP server**.

## Quick start

### The whole stack in Docker

```bash
git clone https://github.com/joesabbagh1/local-aws-tf && cd local-aws-tf
docker compose up --build -d     # Postgres + backend + UI on http://127.0.0.1:5173
```

That's everything: the backend runs inside the container (with terraform, `zip` and the docker CLI baked in), stores designs in the compose Postgres, and drives your host's Docker daemon through the mounted socket to start/stop the emulator containers. Project working dirs live in `./projects` on the host (mounted at `/projects`; that's also the folder path you use for new projects in the UI). The emulator's credentials and CA in `~/.aws/emulator` are shared with the host, and the entrypoint forwards the emulator ports so everything keeps talking to `https://127.0.0.1:9297-9300`. `docker compose logs -f app` to watch it.

### On the host

```bash
npm i -g localcloud-studio          # or use this repo: npm install && npm run build
docker compose up -d postgres       # or your own Postgres
export DATABASE_URL=postgres://localcloud:localcloud@127.0.0.1:5434/localcloud
localcloud-studio ./infra --open    # http://127.0.0.1:5173
```

The folder you pass becomes the project's working dir: `localcloud.json` (the materialized, git-committable design), `terraform-out/` (emulator Terraform) and `terraform-aws/` (**Export for AWS**) all live there. Host-run needs Node 18+, and the live features (emulators, plan, apply) also need Docker, Terraform 1.10+ and `zip`.

### From a clone (development)

```bash
npm install
docker compose up -d postgres
DATABASE_URL=postgres://localcloud:localcloud@127.0.0.1:5434/localcloud npm run dev   # http://127.0.0.1:5173
```

## What you can do

- **Canvas**: drag services from the catalog, wire them together, and configure every field in the inspector. Drop resources into **VPC** and **Subnet** containers to place them in that network. The compiler fills in `vpc_id` / `subnet_ids` from the nesting.
- **Environments**: `dev`, `testing`, `staging` and `prod` share one canvas. Any field can be overridden per environment, and any resource can be switched off for one environment.
- **Lambda code**: inline (one file, no dependencies) or a **folder** in the project, zipped as-is with its `node_modules` or vendored packages. Build or install first; the handler is a path inside the folder.
- **Extra HCL**: every resource has an **Extra HCL** field for arguments the form doesn't cover. It is written inside the resource block as typed and can be overridden per environment like any other field.
- **Terraform**: **Sync** writes `terraform-out/environments/<env>/` (main, provider, variables, tfvars, outputs) and zips Lambda handler code into `artifacts/`. `terraform-out/` is generated and git-ignored.
- **Run**: start or stop an emulator container per environment (ports 9297–9300), then run `init / validate / plan / apply / destroy` with live output. Everything the app runs goes to the local emulator.
- **Status**: whether a resource is applied comes from each environment's Terraform state (`terraform-out/environments/<env>/terraform.tfstate`), read on load and after every apply or destroy, along with its outputs.
- **Emulator support**: each service shows whether it applied and destroyed cleanly in the last `npm run test:emulator`, failed, or was never tested. Failures also appear in the Audit tab.
- **Export for AWS**: writes `terraform-aws/environments/<env>/` for real accounts: no emulator endpoints or credentials, S3 remote state (`backend.tf`, with settings in `backend.tfbackend`), the latest Amazon Linux 2023 image instead of a placeholder AMI, and `vpc_id` / `subnet_ids` inputs for resources that have no VPC or Subnet on the canvas. The export lists anything to fix first, such as a subnet whose availability zone is in another region. `backend.tfbackend` is written once and never overwritten, so fill it in and commit the folder. The Terraform tab can preview either output.
- **Plan before apply**: **Apply** first runs `terraform plan`. The canvas marks each resource as create, change, replace or destroy, and a bar shows the totals. Nothing is applied until you press **Apply** on that bar, which applies exactly the saved plan. Editing the design discards the plan, and so does changing a Lambda's code folder: the server refuses a saved plan whose Terraform files or Lambda zips changed since it was made.
- **Destroy preview**: **destroy** in the Run tab shows a destroy plan the same way, with its own red confirm button. The top bar's Apply never applies a pending destroy plan.
- **Connections**: the canvas only accepts connections that mean something (a queue triggering a Lambda, a Lambda reading a table, a load balancer in front of a service). Anything else, like a database "calling" a Lambda or an edge into a VPC, is refused with a short reason.
- **Data**: browse and poke the deployed resources (S3 objects, DynamoDB items, SQS messages, Lambda invokes).
- **Audit**: architecture checks per environment and an estimated monthly AWS cost per environment.
- **Projects and history**: every save is a numbered version in Postgres (`who`, `when`, optional summary), with restore and diff. A second writer — another tab or an agent — makes your save return a conflict instead of overwriting: the page offers a reload. `./localcloud.json` stays the committed, diffable artifact; edit or pull it and the backend folds the change in as a new `import` version on next open.
- **Import**: import existing `.tf` files onto the canvas, or download / load a project file by hand. Arguments the form models become fields; the rest are kept as each resource's Extra HCL. Anything that can't be kept (arguments LocalCloud generates itself, `count` / `for_each`, resource types with no canvas service) is listed after the import.
- **Agents (MCP)**: the same backend drives agents through a built-in MCP server — see below.

## The backend

One local process serves the UI, the HTTP API, and everything that executes: it alone compiles Terraform, runs `terraform`, and controls Docker. Postgres is the system of record.

```
Browser UI ──HTTP──▶ backend (server/api.ts + services) ──▶ Postgres (projects, versions, runs, events)
MCP server ──HTTP──▶        │                              ──▶ Docker (aws-emulator, one container per env)
(stdio → agent)             └── per project working dir: localcloud.json, terraform-out/, lambda code
```

- **Versioned saves** with optimistic concurrency (`POST /api/projects/:id/doc` carries the base version; a moved head → 409 + the winning document).
- **Serialized runs**: a Postgres advisory lock per project+env means the UI and an agent can never terraform the same environment at once; every run is recorded (`runs` table: command, exit code, plan, log).
- **Design ops as an API**: `POST /api/projects/:id/ops` applies one mutation (`resource.add`, `connection.create`, `env.override`, …) under the canvas rules — an invalid connection or unknown field is refused with the reason — and saves it as one atomic version + audit event.
- **Access**: loopback only. Set `LOCALCLOUD_TOKEN` to require it as a bearer token from programmatic clients (the page itself is exempt).

## MCP server

Agents design, deploy and test environments through the same backend, with the same guardrails (connection rules, version history, saved-plan applies, per-env locking).

```json
{
  "mcpServers": {
    "localcloud": {
      "command": "npx",
      "args": ["localcloud-studio", "mcp", "--url", "http://127.0.0.1:5173", "--project", "/abs/path/to/infra"]
    }
  }
}
```

`--token` / `LOCALCLOUD_TOKEN` when one is set. Against the compose stack, point `--url http://127.0.0.1:5173` and use container paths (`--project /projects/infra`). The 28 tools, grouped:

| Group | Tools |
| --- | --- |
| Read | `projects_list` `project_get` `catalog_list` `project_validate` `versions_list` `version_get` `version_restore` `project_diff` |
| Design | `resource_add` `resource_configure` `resource_move` `resource_remove` `connection_create` `connection_remove` `env_override` `env_enable` `lambda_code_set` `extra_hcl_set` `template_apply` `import_terraform` |
| Run | `sync` `emulator_status` `emulator_start` `emulator_stop` `terraform_run` `apply_plan` `state_get` |
| Data | `explore` (S3 objects, DynamoDB items, SQS messages, Lambda invokes) |

Each design tool is one API call → one transaction → one version recorded with actor `mcp`, so the UI, the history and `project_diff` see exactly what the agent did. A refused `connection_create` returns the same reason the canvas would show.

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘Z / ⌘⇧Z | Undo / redo |
| ⌫ / Delete | Delete selection |
| ⌘D | Duplicate selected resource |
| Esc | Clear selection |

## Layout

- `src/data`: AWS service catalog and blueprints
- `src/utils/terraformCompiler.ts`: canvas → Terraform (pure; `terraformBundle.ts` builds the per-env file set, `nodeFactory.ts` creates catalog-defaulted nodes)
- `src/utils/hclImporter.ts`: Terraform → canvas
- `src/utils/canvasLayout.ts`: container nesting and auto-layout
- `server/api.ts`: the local API (projects, design ops, server-side Terraform compile, streaming runner, emulator control, data explorer). Loopback-only.
- `server/db.ts` + `server/db/migrations.ts`: Postgres pool, migrations, advisory locks
- `server/services/projectStore.ts`: projects, versions, file materialization/reconciliation, diffs
- `server/services/designOps.ts`: headless design mutations under the canvas rules
- `server/mcp.ts`: the MCP server (stdio → HTTP client of the backend)
- `server/cli.ts`: standalone server for the built UI and the API (`npm start`), plus the `mcp` subcommand

## Tests

```bash
npm test                  # compiler golden files, design ops, project store (set DATABASE_URL for the Postgres tests), …
npm run validate:golden   # terraform validate on every golden root (needs terraform)
npm run test:e2e          # browser tests against the built app (run npm run build first; terraform is mocked; needs Postgres)
npm run mcp:smoke         # boots the backend + MCP server and drives an agent loop over stdio (needs Postgres)
npm run test:emulator     # apply + destroy every blueprint on a fresh emulator (needs docker + terraform)
```

`tests/golden/<target>/<blueprint>/<env>/` holds the Terraform each blueprint compiles to, for the emulator and as the AWS export (plus a small fixture that covers the export's network inputs and AMI lookup). After an intended compiler change, refresh it with `npm test -- -u` and review the diff. CI runs the first three.

`test:emulator` applies each blueprint, plus a canvas with every other catalog service, to a fresh emulator on port 9397 (in dev and prod), then destroys it. It records which resource types work in `src/data/emulatorSupport.json`, which the UI reads. It takes a while and needs Docker, so it is run by hand and the results are committed. Pass a filter (`npm run test:emulator -- serverless --env dev`) to rerun part of it.

## License

[MIT](LICENSE)
