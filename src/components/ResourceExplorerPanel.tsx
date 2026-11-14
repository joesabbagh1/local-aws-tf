import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { sanitizeIdentifier } from '../utils/terraformCompiler';
import { AwsServiceIcon } from './AwsServiceIcon';
import { Button, IconButton, Section, Segmented, cn, monoFieldCls } from './ui';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { Loader2, RefreshCw, Send, Upload, Inbox, Search, Zap, AlertTriangle } from 'lucide-react';

type ExplorerService = 's3' | 'dynamodb' | 'sqs' | 'lambda';

const SERVICES: { id: ExplorerService; label: string; nodeType: string; listOp: string }[] = [
  { id: 's3', label: 'S3', nodeType: 'aws_s3_bucket', listOp: 'list_buckets' },
  { id: 'dynamodb', label: 'DynamoDB', nodeType: 'aws_dynamodb_table', listOp: 'list_tables' },
  { id: 'sqs', label: 'SQS', nodeType: 'aws_sqs_queue', listOp: 'list_queues' },
  { id: 'lambda', label: 'Lambda', nodeType: 'aws_lambda_function', listOp: 'list_functions' },
];

interface ExploreResult {
  ok: boolean;
  emulatorOnline?: boolean;
  cliCommand?: string;
  data?: any;
  error?: string;
}

function extractResourceNames(service: ExplorerService, data: any): string[] {
  if (!data || typeof data !== 'object') return [];
  if (service === 's3') return (data.Buckets || []).map((b: any) => b.Name);
  if (service === 'dynamodb') return data.TableNames || [];
  if (service === 'sqs') return data.QueueUrls || [];
  return (data.Functions || []).map((f: any) => f.FunctionName);
}

/** Converts plain JSON into DynamoDB attribute-value JSON so users can type natural items. */
function toDynamoAttribute(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toDynamoAttribute) };
  return {
    M: Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, toDynamoAttribute(v)])),
  };
}

export function ResourceExplorerPanel() {
  const nodes = useCloudStore((s) => s.nodes);
  const selectedNodeId = useCloudStore((s) => s.selectedNodeId);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const env = environments[activeEnv];

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const nodeService = SERVICES.find((s) => s.nodeType === selectedNode?.data.serviceType);

  const [service, setService] = useState<ExplorerService>(nodeService?.id || 's3');
  const [resources, setResources] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [listing, setListing] = useState<ExploreResult | null>(null);
  const [result, setResult] = useState<ExploreResult | null>(null);
  const [busy, setBusy] = useState(false);

  const [objectKey, setObjectKey] = useState('hello.txt');
  const [objectBody, setObjectBody] = useState('Hello from LocalCloud Studio');
  const [itemJson, setItemJson] = useState('{\n  "pk": "order#1001",\n  "status": "PENDING"\n}');
  const [messageBody, setMessageBody] = useState('{"orderId":"1001"}');
  const [eventJson, setEventJson] = useState('{\n  "ping": "hello"\n}');

  useEffect(() => {
    if (nodeService) setService(nodeService.id);
  }, [nodeService?.id]);

  const explore = useCallback(
    async (
      operation: string,
      opts: { target?: string; input?: Record<string, unknown> } = {}
    ): Promise<ExploreResult> => {
      setBusy(true);
      try {
        const res = await fetch('/api/emulator/explore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            port: env.emulatorPort,
            region: env.region,
            service,
            operation,
            target: opts.target ?? target,
            input: opts.input,
          }),
        });
        return (await res.json()) as ExploreResult;
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Request failed' };
      } finally {
        setBusy(false);
      }
    },
    [env.emulatorPort, env.region, service, target]
  );

  // Resource name the canvas node compiles to, used to preselect the matching live resource
  const preferredMatch = useMemo(() => {
    if (!selectedNode || nodeService?.id !== service) return null;
    return sanitizeIdentifier(selectedNode.data.resourceName || selectedNode.data.label).replace(/_/g, '-');
  }, [selectedNode, nodeService, service]);

  const refreshList = useCallback(async () => {
    const svc = SERVICES.find((s) => s.id === service)!;
    const res = await explore(svc.listOp, { target: '' });
    setListing(res);
    const names = res.ok ? extractResourceNames(service, res.data) : [];
    setResources(names);
    const match =
      (preferredMatch && names.find((n) => n.toLowerCase().includes(preferredMatch))) || names[0] || '';
    setTarget(match);
    setResult(null);
  }, [explore, service, preferredMatch]);

  useEffect(() => {
    refreshList();
    // Re-list whenever the service or environment changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, activeEnv]);

  const run = async (operation: string, input?: Record<string, unknown>) => {
    setResult(await explore(operation, { input }));
  };

  const putItem = () => {
    try {
      const plain = JSON.parse(itemJson);
      const item = Object.fromEntries(
        Object.entries(plain).map(([k, v]) => [k, toDynamoAttribute(v)])
      );
      run('put_item', { item });
    } catch {
      setResult({ ok: false, error: 'Item must be valid JSON' });
    }
  };

  const invoke = () => {
    try {
      run('invoke', { event: JSON.parse(eventJson) });
    } catch {
      setResult({ ok: false, error: 'Event must be valid JSON' });
    }
  };

  const offline = listing?.emulatorOnline === false;

  return (
    <>
      <Section>
        <Segmented
          value={service}
          onChange={setService}
          options={SERVICES.map((s) => {
            const meta = SERVICE_BY_TYPE[s.nodeType];
            return {
              value: s.id,
              label: (
                <>
                  <span style={{ color: meta?.color }}>
                    <AwsServiceIcon iconName={meta?.iconName || 'Box'} className="w-3 h-3" />
                  </span>
                  {s.label}
                </>
              ),
            };
          })}
        />
      </Section>

      {/* Live resource picker */}
      <Section
        title={
          <>
            Live on <span className="font-mono">:{env.emulatorPort}</span> · {activeEnv}
          </>
        }
        aside={
          <IconButton onClick={refreshList} disabled={busy} title="Refresh" className="-mr-1.5">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </IconButton>
        }
      >
        {offline ? (
          <p className="text-xs text-warn flex gap-2 leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{listing?.error}</span>
          </p>
        ) : resources.length === 0 ? (
          <p className="text-xs text-fg-faint leading-relaxed">
            {listing?.ok === false
              ? listing.error
              : `No ${SERVICES.find((s) => s.id === service)?.label} resources yet. Apply ${activeEnv} first.`}
          </p>
        ) : (
          <select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setResult(null);
            }}
            className={monoFieldCls}
          >
            {resources.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}

        {/* Per-service operations */}
        {target && !offline && (
          <div className="mt-4 space-y-2">
            {service === 's3' && (
              <>
                <div className="flex gap-1.5">
                  <input value={objectKey} onChange={(e) => setObjectKey(e.target.value)} placeholder="Object key" className={monoFieldCls} />
                  <Button onClick={() => run('get_object', { key: objectKey })}>Get</Button>
                  <Button onClick={() => run('list_objects')}>
                    <Search className="w-3 h-3" /> List
                  </Button>
                </div>
                <textarea rows={3} value={objectBody} onChange={(e) => setObjectBody(e.target.value)} className={monoFieldCls} />
                <Button variant="primary" onClick={() => run('put_object', { key: objectKey, body: objectBody })}>
                  <Upload className="w-3 h-3" /> Upload {objectKey || 'object'}
                </Button>
              </>
            )}

            {service === 'dynamodb' && (
              <>
                <textarea rows={5} value={itemJson} onChange={(e) => setItemJson(e.target.value)} className={monoFieldCls} />
                <p className="text-[12.5px] text-fg-faint">
                  Plain JSON is converted to DynamoDB attribute values. Include the table's key attributes.
                </p>
                <div className="flex gap-1.5">
                  <Button variant="primary" onClick={putItem}>
                    <Upload className="w-3 h-3" /> Put item
                  </Button>
                  <Button onClick={() => run('scan')}>
                    <Search className="w-3 h-3" /> Scan
                  </Button>
                </div>
              </>
            )}

            {service === 'sqs' && (
              <>
                <textarea rows={3} value={messageBody} onChange={(e) => setMessageBody(e.target.value)} className={monoFieldCls} />
                <div className="flex gap-1.5">
                  <Button variant="primary" onClick={() => run('send_message', { body: messageBody })}>
                    <Send className="w-3 h-3" /> Send
                  </Button>
                  <Button onClick={() => run('receive_message')}>
                    <Inbox className="w-3 h-3" /> Receive
                  </Button>
                </div>
              </>
            )}

            {service === 'lambda' && (
              <>
                <textarea rows={5} value={eventJson} onChange={(e) => setEventJson(e.target.value)} className={monoFieldCls} />
                <Button variant="primary" onClick={invoke}>
                  <Zap className="w-3 h-3" /> Invoke
                </Button>
              </>
            )}
          </div>
        )}
      </Section>

      {/* Result */}
      {result && (
        <Section
          title={
            <span className={cn('flex items-center gap-1.5', result.ok ? 'text-fg-muted' : 'text-err')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', result.ok ? 'bg-ok' : 'bg-err')} />
              {result.ok ? 'Response' : 'Failed'}
            </span>
          }
        >
          {result.cliCommand && (
            <code className="block mb-2 text-[12.5px] font-mono text-fg-faint break-all select-text">$ {result.cliCommand}</code>
          )}
          <pre className="rounded-md border border-line bg-base p-3 font-mono text-[12.5px] leading-relaxed text-fg/90 overflow-x-auto max-h-80 select-text">
            {result.ok ? JSON.stringify(result.data, null, 2) : result.error}
          </pre>
        </Section>
      )}
    </>
  );
}
