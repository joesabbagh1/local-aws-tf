import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { ApiGatewayV2Client, GetApisCommand } from '@aws-sdk/client-apigatewayv2';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient, GetItemCommand, ListTablesCommand, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, ListEventBusesCommand, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetRecordsCommand, GetShardIteratorCommand, KinesisClient, ListShardsCommand, ListStreamsCommand, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { InvokeCommand, LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { GetObjectCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DescribeExecutionCommand, ListExecutionsCommand, ListStateMachinesCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { ListTopicsCommand, PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { ListQueuesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/**
 * Data-plane operations against one environment's emulator: what the Data tab, scenarios and the
 * MCP `explore` tool run. The vocabulary (services, operations, inputs) is src/utils/explorerOps.ts.
 */

/**
 * Where the emulator's per-port credentials and CA live, and the dir mounted into emulator
 * containers. Overridable with LOCALCLOUD_EMULATOR_DIR when the backend itself runs in a
 * container and must share the host's dir at the same absolute path (see docker-compose.yml).
 */
export function emulatorDataDir(): string {
  return process.env.LOCALCLOUD_EMULATOR_DIR || path.join(os.homedir(), '.aws', 'emulator');
}

/** SDK client config for one emulator port, using the credentials and CA the emulator writes to ~/.aws/emulator/<port>/. */
function getEmulatorClientConfig(port: number, region: string) {
  const baseDir = path.join(emulatorDataDir(), String(port));
  const ini = fs.readFileSync(path.join(baseDir, 'emulator_credentials'), 'utf-8');
  const read = (key: string) => ini.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, 'm'))?.[1] || '';
  return {
    region,
    endpoint: `https://127.0.0.1:${port}`,
    credentials: {
      accessKeyId: read('aws_access_key_id'),
      secretAccessKey: read('aws_secret_access_key'),
    },
    disableHostPrefix: true,
    requestHandler: new NodeHttpHandler({
      httpsAgent: new https.Agent({ ca: fs.readFileSync(path.join(baseDir, 'ca.pem')) }),
    }),
  };
}

const MAX_PAYLOAD_CHARS = 64 * 1024;

function parseMaybeJson(text: string): unknown {
  const clipped = text.slice(0, MAX_PAYLOAD_CHARS);
  try {
    return JSON.parse(clipped);
  } catch {
    return clipped;
  }
}

function stripMetadata<T extends object>(output: T): Omit<T, '$metadata'> {
  const { $metadata: _meta, ...rest } = output as T & { $metadata?: unknown };
  return rest;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value));

const ATTRIBUTE_TYPES = new Set(['S', 'N', 'B', 'BOOL', 'NULL', 'L', 'M', 'SS', 'NS', 'BS']);

function isAttributeValue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && ATTRIBUTE_TYPES.has(keys[0]);
}

function toAttributeValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toAttributeValue) };
  return { M: Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, toAttributeValue(v)])) };
}

/** A DynamoDB item from plain JSON, or passed through when it is already in attribute-value form. */
export function toDynamoItem(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 0 && entries.every(([, v]) => isAttributeValue(v))) return value as Record<string, any>;
  return Object.fromEntries(entries.map(([k, v]) => [k, toAttributeValue(v)]));
}

export interface LiveResource {
  /** The resource's name in AWS, as the compiler wrote it (lc-<env>-<resource>). */
  name: string;
  /** What operations take as `target`: a name, URL or ARN depending on the service. */
  target: string;
}

const lastSegment = (value: string) => value.split(/[/:]/).pop() || value;

/** The deployed resources of one service, named so they can be matched to canvas nodes. */
export async function listLiveResources(port: number, region: string, service: string): Promise<LiveResource[] | null> {
  const config = getEmulatorClientConfig(port, region);
  const named = (values: (string | undefined)[], nameOf: (v: string) => string = (v) => v): LiveResource[] =>
    values.filter((v): v is string => !!v).map((v) => ({ name: nameOf(v), target: v }));

  switch (service) {
    case 'apigateway': {
      const out = await new ApiGatewayV2Client(config).send(new GetApisCommand({}));
      return (out.Items || []).filter((api) => api.ApiId).map((api) => ({ name: api.Name || api.ApiId!, target: api.ApiId! }));
    }
    case 'lambda':
      return named(((await new LambdaClient(config).send(new ListFunctionsCommand({}))).Functions || []).map((f) => f.FunctionName));
    case 'sqs':
      return named((await new SQSClient(config).send(new ListQueuesCommand({}))).QueueUrls || [], lastSegment);
    case 'sns':
      return named(((await new SNSClient(config).send(new ListTopicsCommand({}))).Topics || []).map((t) => t.TopicArn), lastSegment);
    case 'events':
      return named(((await new EventBridgeClient(config).send(new ListEventBusesCommand({}))).EventBuses || []).map((b) => b.Name)).filter(
        (bus) => bus.name !== 'default'
      );
    case 'kinesis':
      return named((await new KinesisClient(config).send(new ListStreamsCommand({}))).StreamNames || []);
    case 'sfn':
      return ((await new SFNClient(config).send(new ListStateMachinesCommand({}))).stateMachines || [])
        .filter((m) => m.stateMachineArn)
        .map((m) => ({ name: m.name || lastSegment(m.stateMachineArn!), target: m.stateMachineArn! }));
    case 's3':
      return named(((await new S3Client({ ...config, forcePathStyle: true }).send(new ListBucketsCommand({}))).Buckets || []).map((b) => b.Name));
    case 'dynamodb':
      return named((await new DynamoDBClient(config).send(new ListTablesCommand({}))).TableNames || []);
    case 'logs':
      return named(((await new CloudWatchLogsClient(config).send(new DescribeLogGroupsCommand({}))).logGroups || []).map((g) => g.logGroupName));
    default:
      return null;
  }
}

/** The `target` of the deployed resource a canvas node compiled to, if it is deployed. */
export async function resolveLiveTarget(port: number, region: string, service: string, liveName: string): Promise<string | null> {
  const resources = await listLiveResources(port, region, service);
  return resources?.find((r) => r.name === liveName)?.target ?? null;
}

/** One HTTPS request to an API on the emulator, trusting the emulator's own CA. */
function requestEmulatorApi(
  port: number,
  apiId: string,
  input: Record<string, any>
): Promise<{ status: number; headers: Record<string, string>; body: unknown; url: string }> {
  const method = String(input.method || 'GET').toUpperCase();
  if (!/^[A-Z]{3,7}$/.test(method)) throw new Error(`Invalid method ${input.method}`);
  if (!/^[A-Za-z0-9]+$/.test(apiId)) throw new Error(`Invalid API id ${apiId}`);
  const rawPath = String(input.path || '/');
  // The emulator serves every API under one path on its own port; nothing else is reachable from here
  const url = `https://127.0.0.1:${port}/_aws/execute-api/${apiId}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;
  const body = input.body === undefined || input.body === '' ? undefined : asText(input.body);
  const headers: Record<string, string> = {};
  if (input.headers && typeof input.headers === 'object') {
    for (const [k, v] of Object.entries(input.headers)) headers[k] = String(v);
  }
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }
  const ca = fs.readFileSync(path.join(emulatorDataDir(), String(port), 'ca.pem'));

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, ca, timeout: 30000 }, (res) => {
      let text = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        if (text.length < MAX_PAYLOAD_CHARS) text += chunk;
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode || 0,
          headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])),
          body: parseMaybeJson(text),
          url,
        })
      );
    });
    req.on('timeout', () => req.destroy(new Error('The API did not answer within 30 seconds')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function tailLogGroup(config: ReturnType<typeof getEmulatorClientConfig>, logGroupName: string, input: Record<string, any>) {
  const minutes = Math.min(Math.max(Number(input.minutes) || 15, 1), 24 * 60);
  const contains = typeof input.filter === 'string' && input.filter.trim() ? input.filter.trim() : '';
  try {
    const out = await new CloudWatchLogsClient(config).send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime: Date.now() - minutes * 60_000,
        limit: 200,
        // A quoted term matches the text anywhere in the message
        ...(contains ? { filterPattern: `"${contains.replace(/"/g, '\\"')}"` } : {}),
      })
    );
    const events = (out.events || [])
      // Not every emulator build applies the pattern; filter again here so the answer is the same either way
      .filter((e) => !contains || (e.message || '').includes(contains))
      .map((e) => ({ time: e.timestamp ? new Date(e.timestamp).toISOString() : '', message: (e.message || '').replace(/\n$/, '') }));
    return { logGroup: logGroupName, events };
  } catch (err: any) {
    if (err?.name === 'ResourceNotFoundException') return { logGroup: logGroupName, events: [], note: 'No log group yet: nothing has logged.' };
    throw err;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs one data-plane operation against the emulator. Returns null for unsupported operations. */
export async function runExplorerOperation(
  port: number,
  region: string,
  service: string,
  operation: string,
  target: string,
  input: Record<string, any>
): Promise<unknown | null> {
  if (operation === 'list') {
    const resources = await listLiveResources(port, region, service);
    return resources ? { resources } : null;
  }

  const config = getEmulatorClientConfig(port, region);

  switch (`${service}:${operation}`) {
    case 'apigateway:list_apis':
      return stripMetadata(await new ApiGatewayV2Client(config).send(new GetApisCommand({})));
    case 'apigateway:request':
      return requestEmulatorApi(port, target, input);

    case 's3:list_buckets':
      return stripMetadata(await new S3Client({ ...config, forcePathStyle: true }).send(new ListBucketsCommand({})));
    case 's3:list_objects':
      return stripMetadata(
        await new S3Client({ ...config, forcePathStyle: true }).send(
          new ListObjectsV2Command({ Bucket: target, MaxKeys: 100 })
        )
      );
    case 's3:put_object':
      return stripMetadata(
        await new S3Client({ ...config, forcePathStyle: true }).send(
          new PutObjectCommand({ Bucket: target, Key: String(input.key || ''), Body: asText(input.body) })
        )
      );
    case 's3:get_object': {
      const out = await new S3Client({ ...config, forcePathStyle: true }).send(
        new GetObjectCommand({ Bucket: target, Key: String(input.key || '') })
      );
      const { Body, ...meta } = stripMetadata(out);
      return { ...meta, Payload: parseMaybeJson((await Body?.transformToString()) || '') };
    }

    case 'dynamodb:list_tables':
      return stripMetadata(await new DynamoDBClient(config).send(new ListTablesCommand({})));
    case 'dynamodb:scan':
      return stripMetadata(await new DynamoDBClient(config).send(new ScanCommand({ TableName: target, Limit: 50 })));
    case 'dynamodb:put_item':
      return stripMetadata(
        await new DynamoDBClient(config).send(new PutItemCommand({ TableName: target, Item: toDynamoItem(input.item) }))
      );
    case 'dynamodb:get_item':
      return stripMetadata(
        await new DynamoDBClient(config).send(new GetItemCommand({ TableName: target, Key: toDynamoItem(input.key) }))
      );

    case 'sqs:list_queues':
      return stripMetadata(await new SQSClient(config).send(new ListQueuesCommand({})));
    case 'sqs:send_message':
      return stripMetadata(
        await new SQSClient(config).send(new SendMessageCommand({ QueueUrl: target, MessageBody: asText(input.body) }))
      );
    case 'sqs:receive_message':
      return stripMetadata(
        await new SQSClient(config).send(
          new ReceiveMessageCommand({ QueueUrl: target, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 })
        )
      );

    case 'sns:list_topics':
      return stripMetadata(await new SNSClient(config).send(new ListTopicsCommand({})));
    case 'sns:publish':
      return stripMetadata(
        await new SNSClient(config).send(
          new PublishCommand({
            TopicArn: target,
            Message: asText(input.message),
            ...(input.subject ? { Subject: String(input.subject) } : {}),
          })
        )
      );

    case 'events:list_event_buses':
      return stripMetadata(await new EventBridgeClient(config).send(new ListEventBusesCommand({})));
    case 'events:put_events':
      return stripMetadata(
        await new EventBridgeClient(config).send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: target,
                Source: String(input.source || 'custom.app'),
                DetailType: String(input.detailType || 'Event'),
                Detail: typeof input.detail === 'string' ? input.detail : JSON.stringify(input.detail ?? {}),
              },
            ],
          })
        )
      );

    case 'kinesis:list_streams':
      return stripMetadata(await new KinesisClient(config).send(new ListStreamsCommand({})));
    case 'kinesis:put_record':
      return stripMetadata(
        await new KinesisClient(config).send(
          new PutRecordCommand({
            StreamName: target,
            Data: Buffer.from(asText(input.data)),
            PartitionKey: String(input.partitionKey || 'localcloud'),
          })
        )
      );
    case 'kinesis:get_records': {
      const client = new KinesisClient(config);
      const shards = (await client.send(new ListShardsCommand({ StreamName: target }))).Shards || [];
      const records: { shard: string; partitionKey?: string; data: unknown }[] = [];
      for (const shard of shards.slice(0, 4)) {
        const iterator = (
          await client.send(new GetShardIteratorCommand({ StreamName: target, ShardId: shard.ShardId, ShardIteratorType: 'TRIM_HORIZON' }))
        ).ShardIterator;
        if (!iterator) continue;
        const out = await client.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: 25 }));
        for (const record of out.Records || []) {
          records.push({
            shard: shard.ShardId || '',
            partitionKey: record.PartitionKey,
            data: parseMaybeJson(Buffer.from(record.Data || []).toString('utf-8')),
          });
        }
      }
      return { records };
    }

    case 'sfn:list_state_machines':
      return stripMetadata(await new SFNClient(config).send(new ListStateMachinesCommand({})));
    case 'sfn:list_executions':
      return stripMetadata(await new SFNClient(config).send(new ListExecutionsCommand({ stateMachineArn: target, maxResults: 10 })));
    case 'sfn:start_execution':
    case 'sfn:run_execution': {
      const client = new SFNClient(config);
      const started = await client.send(
        new StartExecutionCommand({
          stateMachineArn: target,
          input: typeof input.input === 'string' ? input.input : JSON.stringify(input.input ?? {}),
        })
      );
      if (operation === 'start_execution' || !started.executionArn) return stripMetadata(started);
      // Wait for the execution to settle so a scenario can assert on how it ended
      const deadline = Date.now() + 30_000;
      for (;;) {
        const state = await client.send(new DescribeExecutionCommand({ executionArn: started.executionArn }));
        if (state.status !== 'RUNNING' || Date.now() > deadline) {
          return {
            executionArn: started.executionArn,
            status: state.status,
            output: state.output ? parseMaybeJson(state.output) : undefined,
            error: state.error,
            cause: state.cause,
          };
        }
        await sleep(500);
      }
    }

    case 'lambda:list_functions':
      return stripMetadata(await new LambdaClient(config).send(new ListFunctionsCommand({})));
    case 'lambda:invoke': {
      const out = await new LambdaClient(config).send(
        new InvokeCommand({
          FunctionName: target,
          Payload: Buffer.from(JSON.stringify(input.event ?? {})),
        })
      );
      const { Payload, ...meta } = stripMetadata(out);
      return { ...meta, Payload: parseMaybeJson(Buffer.from(Payload || []).toString('utf-8')) };
    }
    case 'lambda:logs':
      return tailLogGroup(config, `/aws/lambda/${target}`, input);

    case 'logs:list_log_groups':
      return stripMetadata(await new CloudWatchLogsClient(config).send(new DescribeLogGroupsCommand({})));
    case 'logs:tail':
      return tailLogGroup(config, target, input);

    default:
      return null;
  }
}
