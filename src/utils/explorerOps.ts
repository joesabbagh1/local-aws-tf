/**
 * What the Data tab, scenarios and the MCP `explore` tool can do to deployed resources. One list,
 * read by the UI (forms), the backend (which runs the operations in server/services/explorer.ts) and
 * the MCP server (tool descriptions), so the three never disagree about what exists.
 */

export interface ExplorerInput {
  key: string;
  label: string;
  /** `text` is one line, `body` a free-text payload, `json` a JSON value (parsed before sending). */
  kind: 'text' | 'body' | 'json';
  defaultValue?: string;
  placeholder?: string;
}

export interface ExplorerOperation {
  id: string;
  label: string;
  inputs: ExplorerInput[];
  /** Changes nothing: safe to repeat while waiting for an asynchronous flow to land. */
  reads?: boolean;
}

export interface ExplorerService {
  id: string;
  label: string;
  /** The catalog service whose deployed resources this lists. */
  nodeType: string;
  operations: ExplorerOperation[];
}

const minutes: ExplorerInput = { key: 'minutes', label: 'Last minutes', kind: 'text', defaultValue: '15' };
const filter: ExplorerInput = { key: 'filter', label: 'Contains', kind: 'text', placeholder: 'ERROR' };

export const EXPLORER_SERVICES: ExplorerService[] = [
  {
    id: 'apigateway',
    label: 'API Gateway',
    nodeType: 'aws_apigatewayv2_api',
    operations: [
      {
        id: 'request',
        label: 'Send request',
        inputs: [
          { key: 'method', label: 'Method', kind: 'text', defaultValue: 'GET' },
          { key: 'path', label: 'Path', kind: 'text', defaultValue: '/', placeholder: '/orders/123' },
          { key: 'headers', label: 'Headers', kind: 'json', defaultValue: '{}' },
          { key: 'body', label: 'Body', kind: 'body', placeholder: '{"orderId":"1001"}' },
        ],
      },
    ],
  },
  {
    id: 'lambda',
    label: 'Lambda',
    nodeType: 'aws_lambda_function',
    operations: [
      { id: 'invoke', label: 'Invoke', inputs: [{ key: 'event', label: 'Event', kind: 'json', defaultValue: '{\n  "ping": "hello"\n}' }] },
      { id: 'logs', label: 'Logs', inputs: [minutes, filter], reads: true },
    ],
  },
  {
    id: 'sqs',
    label: 'SQS',
    nodeType: 'aws_sqs_queue',
    operations: [
      { id: 'send_message', label: 'Send', inputs: [{ key: 'body', label: 'Message', kind: 'body', defaultValue: '{"orderId":"1001"}' }] },
      { id: 'receive_message', label: 'Receive', inputs: [], reads: true },
    ],
  },
  {
    id: 'sns',
    label: 'SNS',
    nodeType: 'aws_sns_topic',
    operations: [
      {
        id: 'publish',
        label: 'Publish',
        inputs: [
          { key: 'message', label: 'Message', kind: 'body', defaultValue: '{"orderId":"1001"}' },
          { key: 'subject', label: 'Subject', kind: 'text' },
        ],
      },
    ],
  },
  {
    id: 'events',
    label: 'EventBridge',
    nodeType: 'aws_cloudwatch_event_bus',
    operations: [
      {
        id: 'put_events',
        label: 'Put event',
        inputs: [
          { key: 'source', label: 'Source', kind: 'text', defaultValue: 'custom.app.orders' },
          { key: 'detailType', label: 'Detail type', kind: 'text', defaultValue: 'OrderPlaced' },
          { key: 'detail', label: 'Detail', kind: 'json', defaultValue: '{\n  "orderId": "1001"\n}' },
        ],
      },
    ],
  },
  {
    id: 'kinesis',
    label: 'Kinesis',
    nodeType: 'aws_kinesis_stream',
    operations: [
      {
        id: 'put_record',
        label: 'Put record',
        inputs: [
          { key: 'data', label: 'Data', kind: 'body', defaultValue: '{"orderId":"1001"}' },
          { key: 'partitionKey', label: 'Partition key', kind: 'text', defaultValue: 'key-1' },
        ],
      },
      { id: 'get_records', label: 'Read', inputs: [], reads: true },
    ],
  },
  {
    id: 'sfn',
    label: 'Step Functions',
    nodeType: 'aws_sfn_state_machine',
    operations: [
      { id: 'run_execution', label: 'Run and wait', inputs: [{ key: 'input', label: 'Input', kind: 'json', defaultValue: '{}' }] },
      { id: 'start_execution', label: 'Start', inputs: [{ key: 'input', label: 'Input', kind: 'json', defaultValue: '{}' }] },
      { id: 'list_executions', label: 'Executions', inputs: [], reads: true },
    ],
  },
  {
    id: 's3',
    label: 'S3',
    nodeType: 'aws_s3_bucket',
    operations: [
      {
        id: 'put_object',
        label: 'Upload',
        inputs: [
          { key: 'key', label: 'Key', kind: 'text', defaultValue: 'hello.txt' },
          { key: 'body', label: 'Content', kind: 'body', defaultValue: 'Hello from LocalCloud Studio' },
        ],
      },
      { id: 'get_object', label: 'Get', inputs: [{ key: 'key', label: 'Key', kind: 'text', defaultValue: 'hello.txt' }], reads: true },
      { id: 'list_objects', label: 'List', inputs: [], reads: true },
    ],
  },
  {
    id: 'dynamodb',
    label: 'DynamoDB',
    nodeType: 'aws_dynamodb_table',
    operations: [
      {
        id: 'put_item',
        label: 'Put item',
        inputs: [{ key: 'item', label: 'Item', kind: 'json', defaultValue: '{\n  "pk": "order#1001",\n  "sk": "meta",\n  "status": "PENDING"\n}' }],
      },
      { id: 'get_item', label: 'Get item', inputs: [{ key: 'key', label: 'Key', kind: 'json', defaultValue: '{\n  "pk": "order#1001",\n  "sk": "meta"\n}' }], reads: true },
      { id: 'scan', label: 'Scan', inputs: [], reads: true },
    ],
  },
  {
    id: 'logs',
    label: 'Logs',
    nodeType: 'aws_cloudwatch_log_group',
    operations: [{ id: 'tail', label: 'Tail', inputs: [minutes, filter], reads: true }],
  },
];

export const EXPLORER_SERVICE_BY_ID: Record<string, ExplorerService> = Object.fromEntries(
  EXPLORER_SERVICES.map((svc) => [svc.id, svc])
);

export const EXPLORER_SERVICE_BY_NODE_TYPE: Record<string, ExplorerService> = Object.fromEntries(
  EXPLORER_SERVICES.map((svc) => [svc.nodeType, svc])
);

export function explorerOperation(service: string, operation: string): ExplorerOperation | undefined {
  return EXPLORER_SERVICE_BY_ID[service]?.operations.find((op) => op.id === operation);
}

/** One line per service for tool descriptions: `sqs: send_message, receive_message`. */
export function explorerOperationsSummary(): string {
  return EXPLORER_SERVICES.map((svc) => `${svc.id}: ${svc.operations.map((op) => op.id).join(', ')}`).join('; ');
}

/**
 * An operation's form values as the input the backend takes: JSON fields parsed, empty ones left
 * out. Returns the field that isn't valid JSON instead of throwing.
 */
export function buildExplorerInput(
  operation: ExplorerOperation,
  values: Record<string, string>
): { input: Record<string, unknown> } | { invalid: string } {
  const input: Record<string, unknown> = {};
  for (const field of operation.inputs) {
    const raw = values[field.key] ?? field.defaultValue ?? '';
    if (field.kind === 'json') {
      if (!raw.trim()) continue;
      try {
        input[field.key] = JSON.parse(raw);
      } catch {
        return { invalid: field.label };
      }
    } else if (raw !== '') {
      input[field.key] = raw;
    }
  }
  return { input };
}
