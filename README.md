# LocalCloud Studio

Design AWS infrastructure on a 2D canvas, compile it to Terraform for four environments at once, and deploy it to [AWS Emulator](https://github.com/aws/aws-emulator) running locally. When it works locally, export Terraform for your real AWS accounts and deploy it with your usual pipeline. LocalCloud itself only ever runs against the emulator.

## Quick start

In the folder that should hold your project:

```bash
npx localcloud-studio            # opens on http://127.0.0.1:5173
npx localcloud-studio ./infra --port 8080 --open
```

The canvas is saved to `localcloud.json` in that folder, Terraform for the emulator goes to `terraform-out/`, and **Export for AWS** writes `terraform-aws/`. Needs Node 18+. The live features (emulators, plan, apply) also need Docker, Terraform 1.10+ and `zip`.

### From a clone

```bash
npm install
npm run dev        # http://127.0.0.1:5173, saves to this folder
npm run build && npm start -- path/to/project
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
- **Project file**: the canvas saves to `./localcloud.json` as you edit, so it can be committed and diffed. It holds the design only (no selection or provisioning state). Reload the page after pulling changes to it.
- **Import**: import existing `.tf` files onto the canvas, or download / load a project file by hand. Arguments the form models become fields; the rest are kept as each resource's Extra HCL. Anything that can't be kept (arguments LocalCloud generates itself, `count` / `for_each`, resource types with no canvas service) is listed after the import.

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
npm test                  # compiler golden files, AWS export, plan summary, extra HCL, project file
npm run validate:golden   # terraform validate on every golden root (needs terraform)
npm run test:e2e          # browser tests against the built app (run npm run build first; terraform is mocked)
npm run test:emulator     # apply + destroy every blueprint on a fresh emulator (needs docker + terraform)
```

`tests/golden/<target>/<blueprint>/<env>/` holds the Terraform each blueprint compiles to, for the emulator and as the AWS export (plus a small fixture that covers the export's network inputs and AMI lookup). After an intended compiler change, refresh it with `npm test -- -u` and review the diff. CI runs the first three.

`test:emulator` applies each blueprint, plus a canvas with every other catalog service, to a fresh emulator on port 9397 (in dev and prod), then destroys it. It records which resource types work in `src/data/emulatorSupport.json`, which the UI reads. It takes a while and needs Docker, so it is run by hand and the results are committed. Pass a filter (`npm run test:emulator -- serverless --env dev`) to rerun part of it.

## License

[MIT](LICENSE)
