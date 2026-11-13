# LocalCloud Studio

Design AWS infrastructure on a 2D canvas, compile it to Terraform for four environments at once, and deploy it to [AWS Emulator](https://github.com/aws/aws-emulator) running locally.

## Quick start

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

Requirements for the live features: Docker, Terraform, and `zip`.

To run it without the dev server, against any project directory:

```bash
npm run build
npm start -- path/to/project --port 5173   # or: npx localcloud path/to/project, once installed
```

The canvas is saved to `localcloud.json` in the project directory and Terraform is written to `terraform-out/` next to it.

## What you can do

- **Canvas**: drag services from the catalog, wire them together, and configure every field in the inspector. Drop resources into **VPC** and **Subnet** containers to place them in that network. The compiler fills in `vpc_id` / `subnet_ids` from the nesting.
- **Environments**: `dev`, `testing`, `staging` and `prod` share one canvas. Any field can be overridden per environment, and any resource can be switched off for one environment.
- **Extra HCL**: every resource has an **Extra HCL** field for arguments the form doesn't cover. It is written inside the resource block as typed and can be overridden per environment like any other field.
- **Terraform**: **Sync** writes `terraform-out/environments/<env>/` (main, provider, variables, tfvars, outputs) and zips Lambda handler code into `artifacts/`. `terraform-out/` is generated and git-ignored.
- **Run**: start or stop an emulator container per environment (ports 9297–9300), then run `init / validate / plan / apply / destroy` with live output.
- **Plan before apply**: **Apply** first runs `terraform plan`. The canvas marks each resource as create, change, replace or destroy, and a bar shows the totals. Nothing is applied until you press **Apply** on that bar, which applies exactly the saved plan. Editing the design discards the plan.
- **Data**: browse and poke the deployed resources (S3 objects, DynamoDB items, SQS messages, Lambda invokes).
- **Audit**: architecture checks per environment and an estimated monthly AWS cost per environment.
- **Project file**: the canvas saves to `./localcloud.json` as you edit, so it can be committed and diffed. It holds the design only (no selection or provisioning state). Reload the page after pulling changes to it.
- **Import**: import existing `.tf` files onto the canvas, or download / load a project file by hand.

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘Z / ⌘⇧Z | Undo / redo |
| ⌫ / Delete | Delete selection |
| ⌘D | Duplicate selected resource |
| Esc | Clear selection |

## Layout

- `src/data`: AWS service catalog and blueprints
- `src/utils/terraformCompiler.ts`: canvas → Terraform
- `src/utils/hclImporter.ts`: Terraform → canvas
- `src/utils/canvasLayout.ts`: container nesting and auto-layout
- `server/api.ts`: local API used by the UI (project file, emulator control, Terraform runner, data explorer). It only answers requests from the local page.
- `server/cli.ts`: standalone server for the built UI and the API (`npm start`)

## Tests

```bash
npm test                  # compiler golden files, plan summary, extra HCL, project file
npm run validate:golden   # terraform validate on every blueprint × environment (needs terraform)
```

`tests/golden/<blueprint>/<env>/` holds the Terraform each blueprint compiles to. After an intended compiler change, refresh it with `npm test -- -u` and review the diff. CI runs both commands.
