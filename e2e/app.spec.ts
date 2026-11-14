import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_PROJECT_DIR, projectFile, resetProject } from './project';

const node = (page: Page, label: string) => page.locator('.react-flow__node', { hasText: label }).first();
const inspector = (page: Page) => page.locator('aside').last();
const tab = (page: Page, name: string) => page.locator('aside nav button', { hasText: new RegExp(`^${name}$`) }).click();

/** Stands in for terraform: each request to the runner gets the lines `respond` returns. */
async function mockTerraform(page: Page, respond: (body: any) => string[]) {
  const calls: any[] = [];
  await page.route('**/terraform/run', async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: `${respond(body).join('\n')}\n` });
  });
  return calls;
}

const planLines = (changes: { type: string; name: string; actions: string[] }[]) => [
  '$ terraform plan',
  `__LC_PLAN__:${JSON.stringify(changes.map((c) => ({ address: `${c.type}.${c.name}`, ...c })))}`,
  '__LC_EXIT__:0',
];

test.beforeEach(async ({ page }) => {
  await resetProject();
  await page.goto('/');
  // The app has loaded the (empty) project and saved version 1 of its canvas
  await expect(page.locator('header')).toContainText('v1');
  await expect.poll(() => fs.existsSync(path.join(E2E_PROJECT_DIR, 'localcloud.json'))).toBe(true);
});

test('saves the canvas to the project file as you edit', async ({ page }) => {
  await node(page, 'Orders API Handler').click();
  await inspector(page).locator('input').first().fill('Orders API v2');
  await expect.poll(() => projectFile().nodes.some((n: any) => n.data.label === 'Orders API v2')).toBe(true);
});

test('reads applied status and outputs from Terraform state', async ({ page }) => {
  await expect(node(page, 'Orders API Handler')).toContainText('applied');
  await expect(node(page, 'Fulfillment Worker')).not.toContainText('applied');
  await node(page, 'Orders API Handler').click();
  await expect(inspector(page)).toContainText('Outputs in dev');
  await expect(inspector(page)).toContainText('lc-dev-orders_api_handler');
});

test('refuses a connection that means nothing, and says why', async ({ page }) => {
  const edgesBefore = await page.locator('.react-flow__edge').count();
  const from = node(page, 'Invoices & Media Bucket').locator('.react-flow__handle.source');
  const to = node(page, 'Customer Identity Pool').locator('.react-flow__handle.target');
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect(page.getByRole('status')).toContainText("doesn't mean anything");
  await expect(page.locator('.react-flow__edge')).toHaveCount(edgesBefore);
});

test('plans before applying, then applies exactly the reviewed plan', async ({ page }) => {
  const calls = await mockTerraform(page, (body) =>
    body.command === 'plan'
      ? planLines([
          { type: 'aws_lambda_function', name: 'fulfillment_worker', actions: ['create'] },
          { type: 'aws_s3_bucket', name: 'invoices_media_bucket', actions: ['update'] },
        ])
      : ['$ terraform apply', 'Apply complete!', '__LC_EXIT__:0']
  );

  await page.locator('header button', { hasText: 'Apply dev' }).click();
  await expect(page.locator('text=Plan for dev')).toBeVisible();
  await expect(page.locator('text=+1 add')).toBeVisible();
  await expect(node(page, 'Fulfillment Worker')).toContainText('+ create');
  await expect(node(page, 'Invoices & Media Bucket')).toContainText('~ change');
  expect(calls.map((c) => c.command)).toEqual(['plan']);

  await page.locator('.react-flow').locator('..').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('text=Plan for dev')).toBeHidden();
  expect(calls[1]).toMatchObject({ command: 'apply', usePlan: true });
});

test('shows a destroy plan and needs its own confirmation', async ({ page }) => {
  const calls = await mockTerraform(page, (body) =>
    body.command === 'plan' && body.destroy
      ? planLines([
          { type: 'aws_lambda_function', name: 'orders_api_handler', actions: ['delete'] },
          { type: 'aws_iam_role', name: 'orders_api_handler_exec_role', actions: ['delete'] },
        ])
      : ['__LC_EXIT__:0']
  );

  await tab(page, 'Run');
  await inspector(page).getByRole('button', { name: 'destroy', exact: true }).click();
  await expect(page.locator('text=Destroy dev')).toBeVisible();
  await expect(node(page, 'Orders API Handler')).toContainText('− destroy');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ command: 'plan', destroy: true });

  // The top bar's Apply must never apply a pending destroy plan: it plans normally instead
  await page.locator('header button', { hasText: 'Apply dev' }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toMatchObject({ command: 'plan', destroy: false });
});

test('a plan that went stale is refused without marking anything failed', async ({ page }) => {
  await mockTerraform(page, (body) =>
    body.command === 'plan'
      ? planLines([{ type: 'aws_lambda_function', name: 'fulfillment_worker', actions: ['create'] }])
      : ['The Terraform files or Lambda code changed since this plan was reviewed.', '__LC_PLAN_STALE__', '__LC_EXIT__:1']
  );
  await page.locator('header button', { hasText: 'Apply dev' }).click();
  await expect(page.locator('text=Plan for dev')).toBeVisible();
  await page.locator('.react-flow').locator('..').getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(page.locator('text=Plan for dev')).toBeHidden();
  await expect(page.locator('.react-flow__node', { hasText: 'failed' })).toHaveCount(0);
  await expect(inspector(page)).toContainText('changed since this plan was reviewed');
});

test('zips a Lambda from a code folder, and reports a missing one', async ({ page }) => {
  await node(page, 'Orders API Handler').click();
  await inspector(page).getByRole('button', { name: 'Folder', exact: true }).click();
  const folder = inspector(page).locator('input[placeholder="functions/orders"]');
  await folder.fill('functions/orders');
  await expect.poll(() => projectFile().nodes.find((n: any) => n.data.resourceName === 'orders_api_handler').data.sourceDir).toBe('functions/orders');

  await page.locator('header button', { hasText: 'Sync' }).click();
  const zip = path.join(E2E_PROJECT_DIR, 'terraform-out/environments/dev/artifacts/orders_api_handler.zip');
  await expect
    .poll(() => (fs.existsSync(zip) ? execFileSync('unzip', ['-Z1', zip]).toString() : ''))
    .toContain('node_modules/left-pad/index.js');

  await folder.fill('functions/missing');
  await page.waitForTimeout(1000);
  await page.locator('header button', { hasText: 'Sync' }).click();
  await tab(page, 'Run');
  await expect(inspector(page)).toContainText('code folder "functions/missing" does not exist');
});

test('exports Terraform for AWS and keeps the backend settings on re-export', async ({ page }) => {
  await page.locator('header button', { hasText: 'Export for AWS' }).click();
  const modal = page.locator('div.fixed.inset-0');
  await modal.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(modal).toContainText('Wrote');

  const backend = path.join(E2E_PROJECT_DIR, 'terraform-aws/environments/prod/backend.tfbackend');
  const mainTf = fs.readFileSync(path.join(E2E_PROJECT_DIR, 'terraform-aws/environments/prod/main.tf'), 'utf-8');
  expect(mainTf).not.toMatch(/emulator|127\.0\.0\.1/);
  fs.writeFileSync(backend, fs.readFileSync(backend, 'utf-8').replace('CHANGE-ME-terraform-state', 'acme-state'));

  await modal.getByRole('button', { name: 'Export again' }).click();
  await expect(modal).toContainText('kept your 4 backend settings');
  expect(fs.readFileSync(backend, 'utf-8')).toContain('acme-state');
});

test('imports Terraform, keeps unknown arguments, and lists what it could not keep', async ({ page }) => {
  await page.locator('header button', { hasText: 'Import' }).first().click();
  const modal = page.locator('div.fixed.inset-0');
  await modal.locator('textarea').fill(`resource "aws_lambda_function" "billing" {
  function_name = "billing"
  role          = aws_iam_role.legacy.arn
  runtime       = "python3.12"
  publish       = true
  count         = 2
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = "x"
}
`);
  await modal.getByRole('button', { name: 'Import to canvas' }).click();
  await expect(modal).toContainText('Imported 1 resource; 1 argument kept as Extra HCL.');
  await expect(modal).toContainText('Not imported: role on aws_lambda_function.billing (generated by LocalCloud)');
  await expect(modal).toContainText('Not imported: count on aws_lambda_function.billing (not supported on the canvas)');
  await expect(modal).toContainText('No canvas service for 1 resource(s): aws_s3_bucket_versioning.assets');

  await modal.getByRole('button', { name: 'Close' }).click();
  await node(page, 'Billing').click();
  await expect(inspector(page).locator('textarea[placeholder^="publish = true"]')).toHaveValue(/publish\s+= true/);
});

test('shows how each service fared on the emulator', async ({ page }) => {
  await node(page, 'Orders API Handler').click();
  await expect(inspector(page)).toContainText('Applies and destroys on the emulator');

  await page.locator('aside').first().locator('div[draggable="true"]', { hasText: 'Virtual Server Instance' }).click();
  await expect(inspector(page)).toContainText('Fails on the emulator');
  await page.locator('aside').first().locator('div[draggable="true"]', { hasText: 'Security Group' }).click();
  await expect(inspector(page)).toContainText('Works on the emulator with a second Apply');
});

test('previews the AWS export next to the emulator build', async ({ page }) => {
  await tab(page, 'Terraform');
  await inspector(page).getByRole('button', { name: 'AWS export' }).click();
  await inspector(page).getByRole('button', { name: 'backend', exact: true }).click();
  await expect(inspector(page)).toContainText('backend "s3" {}');
  await expect(inspector(page)).toContainText('terraform-aws/environments/dev/');
});
