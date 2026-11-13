# LocalCloud Studio

Design AWS infrastructure on a 2D canvas, compile it to Terraform for four environments at once, and deploy it to [AWS Emulator](https://github.com/aws/aws-emulator) running locally.

## Quick start

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

Requirements for the live features: Docker, Terraform, and `zip`.

## What you can do

- **Canvas**: drag services from the catalog, wire them together, and configure every field in the inspector. Drop resources into **VPC** and **Subnet** containers to place them in that network. The compiler fills in `vpc_id` / `subnet_ids` from the nesting.
- **Environments**: `dev`, `testing`, `staging` and `prod` share one canvas. Any field can be overridden per environment, and any resource can be switched off for one environment.
- **Terraform**: **Sync TF** writes `terraform-out/environments/<env>/` (main, provider, variables, tfvars, outputs) and zips Lambda handler code into `artifacts/`.
- **Runner**: start or stop an emulator container per environment (ports 9297–9300), then run `init / validate / plan / apply / destroy` with live output. Nodes turn amber while they're provisioning and green once applied, and the inspector shows the Terraform outputs.
- **Data**: browse and poke the deployed resources (S3 objects, DynamoDB items, SQS messages, Lambda invokes).
- **Audit**: architecture checks per environment and an estimated monthly AWS cost per environment.
- **Import / Save**: import existing `.tf` files onto the canvas, or download / load a `.localcloud.json` project. The canvas also auto-saves in the browser.

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
- `vite.config.ts`: local API used by the UI (emulator control, Terraform runner, data explorer)
