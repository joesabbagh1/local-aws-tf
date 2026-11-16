# LocalCloud Studio

Design AWS infrastructure on a 2D canvas, compile it to Terraform for four environments at once, and deploy it to [AWS Emulator](https://github.com/aws/aws-emulator) running locally. When it works locally, export Terraform for your real AWS accounts and deploy it with your usual pipeline. LocalCloud itself only ever runs against the emulator.

Designs, version history, runs and an audit trail live in a **PostgreSQL** database behind the local backend; every project also keeps its `localcloud.json`, `terraform-out/` and Lambda code folders on disk. Agents can drive the whole thing through the built-in **MCP server**.

## Quick start

### The whole stack in Docker

```bash
git clone https://github.com/joesabbagh1/local-aws-tf && cd local-aws-tf
docker compose up --build -d     # Postgres + backend + UI on http://127.0.0.1:5173
```

That's everything: the backend runs inside the container (with terraform, `zip` and the docker CLI baked in), stores designs in the compose Postgres, and drives your host's Docker daemon through the mounted socket to start/stop the emulator containers. Project working dirs live in `./projects` on the host (mounted at `/projects`; that's also the folder path you use for new projects in the UI). The emulator's credentials and CA in `~/.aws/emulator` are shared with the host, and the entrypoint forwards the emulator ports so everything keeps talking to `https://127.0.0.1:<port>` (9297–9316 by default, enough for 20 environments; set `LOCALCLOUD_EMULATOR_PORTS=first-last` on the app service for more). `docker compose logs -f app` to watch it.

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
- **Environments**: `dev`, `testing`, `staging` and `prod` to start with, all on one canvas. Add your own in the **Envs** tab (`qa`, `perf`, `prod-eu`…), either blank or as a copy of another environment's region, usage and overrides. Each gets its own emulator port, Terraform folder and state. Remove the ones you don't use. Any field can be overridden per environment, and any resource can be switched off for one environment. Mark an environment as production to get the stricter audit checks (`prod` is production by default).
- **Lambda code**: inline (one file, no dependencies) or a **folder** in the project, zipped as-is with its `node_modules` or vendored packages. Build or install first; the handler is a path inside the folder.
- **Lambda watch mode**: switch on **Watch** under **Lambda code** in the Run tab, or use MCP's `lambda_watch`. While it's on, a function whose code changes is pushed to that environment's emulator about a second later, without a plan. That covers a file in its code folder and an edit to its inline code. A new runtime, handler or other setting still needs Apply. Updates wait while Terraform runs for that environment, and the next plan shows the function as changed until you apply.
- **Extra HCL**: every resource has an **Extra HCL** field for arguments the form doesn't cover. It is written inside the resource block as typed and can be overridden per environment like any other field.
- **Terraform**: **Sync** writes `terraform-out/environments/<env>/` (main, provider, variables, tfvars, outputs) and zips Lambda handler code into `artifacts/`. `terraform-out/` is generated and git-ignored.
- **Run**: start or stop an emulator container per environment (ports 9297–9300), then run `init / validate / plan / apply / destroy` with live output. Everything the app runs goes to the local emulator.
- **Status**: whether a resource is applied comes from each environment's Terraform state (`terraform-out/environments/<env>/terraform.tfstate`), read on load and after every apply or destroy, along with its outputs.
- **Emulator support**: each service shows whether it applied and destroyed cleanly in the last `npm run test:emulator`, worked with one of the adjustments below, failed, or was never tested. Failures also appear in the Audit tab.
- **Emulator gaps LocalCloud works around**: where the emulator differs from AWS, the Terraform LocalCloud runs locally differs too, with an `# Emulator only:` comment at each spot. The AWS export always keeps what you designed.
  - Burstable EC2 types (t2, t3, t4g) run as `m6i.large` or `m7g.medium`, because the emulator can't read CPU credit settings ([aws/aws-emulator#422](https://github.com/aws/aws-emulator/issues/422)). Root volume settings, which the emulator ignores, aren't compared.
  - A 24-hour Kinesis retention runs as 25 hours, because the emulator rejects 24 ([#327](https://github.com/aws/aws-emulator/issues/327)).
  - Redis port changes are ignored, because the emulator picks its own port ([#471](https://github.com/aws/aws-emulator/issues/471)).
  - A security group in a VPC fails on its default egress rule ([#46](https://github.com/aws/aws-emulator/issues/46)) though it exists. The runner marks it usable and applies again on its own.
  - The emulator can't delete Redis replication groups ([#355](https://github.com/aws/aws-emulator/issues/355)). Destroy removes them from Terraform state, along with what they still use (their subnet group), and destroys the rest. Applying again takes them back with `terraform import` instead of failing on "already exists", and restarting the emulator clears them.
- **Deprecated services**: Bedrock Agent is no longer in the catalog. AWS has stopped creating agents for new accounts, and the emulator doesn't run them. To call Claude, set a Lambda function's **Claude model** field instead. Existing designs and imported Terraform that use it still compile and export, and the Audit tab flags it.
- **Export for AWS**: writes `terraform-aws/environments/<env>/` for real accounts: no emulator endpoints or credentials, S3 remote state (`backend.tf`, with settings in `backend.tfbackend`), the latest Amazon Linux 2023 image instead of a placeholder AMI, and `vpc_id` / `subnet_ids` inputs for resources that have no VPC or Subnet on the canvas. The export lists anything to fix first, such as a subnet whose availability zone is in another region. `backend.tfbackend` is written once and never overwritten, so fill it in and commit the folder. The Terraform tab can preview either output.
- **Plan before apply**: **Apply** first runs `terraform plan`. The canvas marks each resource as create, change, replace or destroy, and a bar shows the totals. Nothing is applied until you press **Apply** on that bar, which applies exactly the saved plan. Editing the design discards the plan, and so does changing a Lambda's code folder: the server refuses a saved plan whose Terraform files or Lambda zips changed since it was made.
- **Destroy preview**: **destroy** in the Run tab shows a destroy plan the same way, with its own red confirm button. The top bar's Apply never applies a pending destroy plan.
- **Connections**: the canvas only accepts connections that mean something, and every one it accepts generates Terraform:
  - **Triggers**: SQS, Kinesis and DynamoDB streams into Lambda; S3, SNS and EventBridge into Lambda, SQS and SNS, with the queue and topic policies that let them deliver. API Gateway into Lambda, SQS, Step Functions, EventBridge, Kinesis or a load balancer. A state machine gets one step per Lambda, queue, topic or bus it connects to.
  - **Access**: anything that runs code (Lambda, ECS, EC2, Auto Scaling, EKS, Step Functions) gets a least-privilege IAM policy for what it calls. Lambda and ECS also get environment variables saying where each resource is (`ORDERS_TABLE_NAME`, `JOBS_QUEUE_URL`, `DB_HOST`…). EC2 gets a role and instance profile only once it calls something. A connection to DynamoDB, S3, SQS, KMS or EFS can be narrowed to read or write only (for SQS, receive or send) in the connection's inspector. The policy then lists only those actions, in the emulator build and in the AWS export.
  - **Traffic**: load balancers register ECS services, instances, Auto Scaling groups and Lambdas, with path rules when there are several kinds. CloudFront gets one origin per target, and buckets stay private behind origin access control. Route 53 gets alias records, and a Cognito pool puts a JWT authorizer on an API's routes.

  Anything else, like a database "calling" a Lambda or an edge into a VPC, is refused with a short reason. A connection's label sets the API route (`POST /orders`), the S3 key prefix (`uploads/`), the DNS record name or the Cognito trigger. Switch a connection to *depends_on only* to order two resources without wiring them.
- **Data**: use what's deployed. Send HTTP requests to an API, invoke a Lambda and read its logs, send and receive SQS messages, publish to SNS, put EventBridge events and Kinesis records, run a state machine and wait for its result, read and write S3 objects and DynamoDB items. Pick the resource from the canvas; LocalCloud finds its deployed counterpart in the active environment.
- **Scenarios**: save Data tab operations as steps of an end-to-end check, e.g. send a request, then expect the order in the table. Read steps can wait up to two minutes for asynchronous flows to land. Scenarios are part of the project (versioned, in `localcloud.json`). They run from the UI or MCP against any environment's emulator, and from CI with [`localcloud-studio test`](#scenarios-in-ci). Every run is recorded.
- **Audit**: architecture checks per environment and an estimated monthly AWS cost per environment.
- **History**: the **History** page lists every version with what it changed, field by field with before and after. It also lists every Terraform and scenario run with its full output, plan and the design version it ran against, and the audit trail of who did what (the canvas, an agent, a file change). Restore any version.
- **Projects and history**: every save is a numbered version in Postgres (`who`, `when`, a summary of the change), with restore and diff. A second writer — another tab or an agent — makes your save return a conflict instead of overwriting: the page offers a reload. `./localcloud.json` stays the committed, diffable artifact; edit or pull it and the backend folds the change in as a new `import` version on next open.
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

`--token` / `LOCALCLOUD_TOKEN` when one is set. Against the compose stack, point `--url http://127.0.0.1:5173` and use container paths (`--project /projects/infra`). The 40 tools, grouped:

| Group | Tools |
| --- | --- |
| Read | `projects_list` `project_get` `catalog_list` `project_validate` |
| History | `versions_list` `version_get` `version_restore` `project_diff` `runs_list` `run_get` `events_list` |
| Design | `resource_add` `resource_configure` `resource_move` `resource_remove` `connection_create` `connection_configure` `connection_remove` `env_override` `env_enable` `lambda_code_set` `extra_hcl_set` `template_apply` `import_terraform` |
| Environments | `environment_add` `environment_update` `environment_remove` |
| Run | `sync` `emulator_status` `emulator_start` `emulator_stop` `terraform_run` `apply_plan` `state_get` `lambda_watch` |
| Data | `explore` (every Data tab operation; name the resource by canvas id) |
| Scenarios | `scenarios_list` `scenario_save` `scenario_remove` `scenario_run` |

Each design tool is one API call → one transaction → one version recorded with actor `mcp`, so the UI, the history and `project_diff` see exactly what the agent did. A refused `connection_create` returns the same reason the canvas would show.

## Scenarios in CI

`localcloud-studio test` checks a project the way CI needs it:
1. It deploys the design in `localcloud.json` to a fresh emulator.
2. It runs every saved scenario.
3. It destroys everything again.

It needs Docker and Terraform, but no database: it reads the committed `localcloud.json`. It also handles the emulator gaps the way the app's runner does.

```sh
npx localcloud-studio test ./infra                       # dev, every scenario
npx localcloud-studio test ./infra --env dev,staging     # several environments, one after another
npx localcloud-studio test ./infra --scenario "Order reaches the queue"
```

It exits 0 when everything passed, 1 when a scenario failed or the design didn't deploy or destroy cleanly, and 2 when it couldn't run at all. Terraform's output is printed only for a step that fails; `--verbose` streams all of it. The emulator gets its own port (`--port`, default 9398), so it never touches the emulators the app runs. `--keep` leaves the emulator running afterwards so you can look around.

In GitHub Actions it also writes a pass/fail table to the job summary:

```yaml
jobs:
  scenarios:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false
      - run: npx localcloud-studio test ./infra
```

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
- `src/utils/wiringCatalog.ts`: what each connection generates, read by both the canvas rules (`connectionRules.ts`) and the compiler (`terraformWiring.ts`)
- `src/utils/environments.ts`: the project's environments: defaults, adding, copying, removing
- `src/utils/explorerOps.ts` + `scenarios.ts`: Data tab operations and saved scenarios (run by `server/services/explorer.ts` and `scenarioRunner.ts`)
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

`tests/wiring.test.ts` compiles every pair of services the canvas accepts and fails if a connection generates nothing. Its all-connections canvas is a golden root too, so `validate:golden` runs `terraform validate` on every kind of wiring at once.

`test:emulator` applies each blueprint, plus a canvas with every other catalog service and a canvas with one of each kind of connection, to a fresh emulator on port 9397 (in dev and prod), then destroys it. It records which resource types work in `src/data/emulatorSupport.json`, which the UI reads. It takes a while and needs Docker, so it is run by hand and the results are committed. Pass a filter (`npm run test:emulator -- serverless --env dev`) to rerun part of it.

## License

[MIT](LICENSE)
