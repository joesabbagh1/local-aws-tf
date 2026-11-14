import { describe, expect, it } from 'vitest';
import { AWS_SERVICES_CATALOG, DEFAULT_ENVIRONMENTS, getDefaultConfigForService } from '../src/data/awsCatalog';
import { compileTerraformForEnvironment, EXTRA_HCL_KEY, injectExtraHcl } from '../src/utils/terraformCompiler';
import type { CloudNode } from '../src/types/cloud';

function nodeFor(typeId: string, extra: Partial<CloudNode['data']> = {}): CloudNode {
  return {
    id: `n-${typeId}`,
    type: 'awsNode',
    position: { x: 0, y: 0 },
    data: {
      label: 'Thing',
      resourceName: 'thing',
      serviceType: typeId,
      baseConfig: getDefaultConfigForService(typeId),
      envOverrides: {},
      envEnabled: { dev: true, testing: true, staging: true, prod: true },
      tags: {},
      ...extra,
    },
  };
}

const compileMain = (node: CloudNode, envId: 'dev' | 'prod' = 'dev') =>
  compileTerraformForEnvironment([node], [], DEFAULT_ENVIRONMENTS[envId], DEFAULT_ENVIRONMENTS).mainTf;

/** The body of `resource "<type>" "<name>" { ... }`, found by brace matching. */
function blockBody(mainTf: string, tfType: string, name: string): string {
  const header = `resource "${tfType}" "${name}" {`;
  const start = mainTf.indexOf(header);
  expect(start, `${header} not found`).toBeGreaterThan(-1);
  let depth = 1;
  let i = start + header.length;
  while (depth > 0 && i < mainTf.length) {
    if (mainTf[i] === '{') depth++;
    else if (mainTf[i] === '}') depth--;
    i++;
  }
  return mainTf.slice(start + header.length, i - 1);
}

describe('extra HCL', () => {
  it.each(AWS_SERVICES_CATALOG.map((svc) => [svc.typeId, svc] as const))(
    'lands inside the %s block',
    (typeId, svc) => {
      const node = nodeFor(typeId);
      node.data.baseConfig[EXTRA_HCL_KEY] = 'lifecycle {\n  prevent_destroy = true\n}';
      const mainTf = compileMain(node);
      expect(mainTf).not.toContain('was not applied');
      const body = blockBody(mainTf, svc.terraformResourceType, 'thing');
      expect(body).toContain('  lifecycle {\n    prevent_destroy = true\n  }');
      // Still the last thing in the block, so the block stays well-formed
      expect(body.trimEnd().endsWith('}')).toBe(true);
    }
  );

  it('follows environment overrides', () => {
    const node = nodeFor('aws_sqs_queue', { envOverrides: { prod: { [EXTRA_HCL_KEY]: 'max_message_size = 2048' } } });
    expect(compileMain(node, 'dev')).not.toContain('max_message_size');
    expect(compileMain(node, 'prod')).toContain('  max_message_size = 2048');
  });

  it('leaves the output untouched when empty', () => {
    const plain = compileMain(nodeFor('aws_s3_bucket'));
    const node = nodeFor('aws_s3_bucket');
    node.data.baseConfig[EXTRA_HCL_KEY] = '  \n';
    expect(compileMain(node)).toBe(plain);
  });

  it('only touches the named block', () => {
    const blocks = 'resource "aws_iam_role" "fn_exec_role" {\n  name = "x"\n}\n\nresource "aws_lambda_function" "fn" {\n  role = "${aws_iam_role.fn_exec_role.arn}"\n}';
    expect(injectExtraHcl(blocks, 'aws_lambda_function', 'fn', 'publish = true')).toBe(
      'resource "aws_iam_role" "fn_exec_role" {\n  name = "x"\n}\n\nresource "aws_lambda_function" "fn" {\n  role = "${aws_iam_role.fn_exec_role.arn}"\n\n  # Extra arguments (hand-written)\n  publish = true\n}'
    );
  });
});
