import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildLambdaArtifact } from '../server/api';

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('buildLambdaArtifact', () => {
  let project: string;
  let fnDir: string;
  let envDir: string;
  const art = { envId: 'dev', resourceName: 'orders', runtime: 'nodejs20.x', handler: 'index.handler', sourceDir: 'functions/orders' };

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-proj-'));
    fnDir = path.join(project, 'functions', 'orders');
    fs.mkdirSync(path.join(fnDir, 'node_modules', 'left-pad'), { recursive: true });
    fs.mkdirSync(path.join(fnDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(fnDir, 'index.mjs'), 'import pad from "left-pad";\nexport const handler = async () => pad("x", 3);\n');
    fs.writeFileSync(path.join(fnDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = (s, n) => s.padStart(n);\n');
    fs.writeFileSync(path.join(fnDir, '.git', 'HEAD'), 'ref');
    fs.writeFileSync(path.join(fnDir, '.DS_Store'), 'junk');
    envDir = path.join(project, 'out');
  });

  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it('zips the folder with its dependencies and without VCS / OS clutter', async () => {
    const { zipPath, error } = await buildLambdaArtifact(envDir, project, art);
    expect(error).toBeUndefined();
    const entries = execFileSync('unzip', ['-Z1', zipPath!]).toString().trim().split('\n').sort();
    expect(entries).toEqual(['index.mjs', 'node_modules/', 'node_modules/left-pad/', 'node_modules/left-pad/index.js']);
  });

  it('gives the same zip for the same content, and a new one when content changes', async () => {
    const first = sha((await buildLambdaArtifact(envDir, project, art)).zipPath!);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(fnDir, 'index.mjs'), later, later);
    expect(sha((await buildLambdaArtifact(envDir, project, art)).zipPath!)).toBe(first);

    fs.appendFileSync(path.join(fnDir, 'index.mjs'), '// change\n');
    expect(sha((await buildLambdaArtifact(envDir, project, art)).zipPath!)).not.toBe(first);
  });

  it('gives a stable zip for inline code', async () => {
    const inline = { ...art, sourceDir: '', code: 'export const handler = () => 1;\n' };
    const first = sha((await buildLambdaArtifact(envDir, project, inline)).zipPath!);
    await new Promise((r) => setTimeout(r, 1100));
    expect(sha((await buildLambdaArtifact(envDir, project, inline)).zipPath!)).toBe(first);
  });

  it('refuses folders that are missing or outside the project', async () => {
    expect((await buildLambdaArtifact(envDir, project, { ...art, sourceDir: 'nope' })).error).toContain('does not exist');
    expect((await buildLambdaArtifact(envDir, project, { ...art, sourceDir: '../../etc' })).error).toContain('outside the project');
  });
});

describe('securityGroupEgressQuirks', () => {
  it('finds only security groups that failed on the missing default egress rule', async () => {
    const { securityGroupEgressQuirks } = await import('../server/api');
    const output = `aws_vpc.main: Creation complete after 1s [id=vpc-1]

Error: revoking default IPv4 egress rule for Security Group (sg-1): operation error EC2: RevokeSecurityGroupEgress, https response error StatusCode: 400, api error InvalidPermission.NotFound: The specified rule does not exist

  with aws_security_group.app_sg,
  on main.tf line 40, in resource "aws_security_group" "app_sg":

Error: creating RDS DB Instance: InvalidParameterValue

  with aws_db_instance.db,
  on main.tf line 90, in resource "aws_db_instance" "db":
`;
    expect(securityGroupEgressQuirks(output)).toEqual(['aws_security_group.app_sg']);
  });
});
