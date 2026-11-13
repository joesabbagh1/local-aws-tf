import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { sanitizeIdentifier } from '../utils/terraformCompiler';
import { AwsServiceIcon } from './AwsServiceIcon';
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
    <div className="p-4 space-y-4">
      {/* Service switcher */}
      <div className="grid grid-cols-4 gap-1 bg-[#141824] p-1 rounded-xl border border-slate-800">
        {SERVICES.map((s) => {
          const meta = SERVICE_BY_TYPE[s.nodeType];
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setService(s.id)}
              className={`py-1.5 rounded-lg text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors ${
                service === s.id
                  ? 'bg-[#1f2637] text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              <span style={{ color: meta?.color }}>
                <AwsServiceIcon iconName={meta?.iconName || 'Box'} className="w-3.5 h-3.5" />
              </span>
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Live resource picker */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-300">
            Live resources on :{env.emulatorPort} ({activeEnv})
          </span>
          <button
            type="button"
            onClick={refreshList}
            disabled={busy}
            className="text-[10px] text-slate-300 hover:text-white flex items-center gap-1 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </button>
        </div>

        {offline ? (
          <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/30 text-[11px] text-amber-200 flex gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{listing?.error}</span>
          </div>
        ) : resources.length === 0 ? (
          <p className="text-[11px] text-slate-500 px-1">
            {listing?.ok === false
              ? listing.error
              : `No ${SERVICES.find((s) => s.id === service)?.label} resources yet. Apply the ${activeEnv} environment first.`}
          </p>
        ) : (
          <select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setResult(null);
            }}
            className="w-full bg-[#0d1017] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-orange-500"
          >
            {resources.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Per-service operations */}
      {target && !offline && (
        <div className="p-3 rounded-xl bg-[#141824] border border-slate-800 space-y-2.5">
          {service === 's3' && (
            <>
              <button type="button" onClick={() => run('list_objects')} className={actionBtn}>
                <Search className="w-3 h-3" /> List objects
              </button>
              <div className="flex gap-1.5">
                <input value={objectKey} onChange={(e) => setObjectKey(e.target.value)} placeholder="Object key" className={inputCls} />
                <button type="button" onClick={() => run('get_object', { key: objectKey })} className={actionBtn}>
                  Get
                </button>
              </div>
              <textarea rows={3} value={objectBody} onChange={(e) => setObjectBody(e.target.value)} className={`${inputCls} text-emerald-300`} />
              <button type="button" onClick={() => run('put_object', { key: objectKey, body: objectBody })} className={primaryBtn}>
                <Upload className="w-3 h-3" /> Upload as {objectKey || 'object'}
              </button>
            </>
          )}

          {service === 'dynamodb' && (
            <>
              <button type="button" onClick={() => run('scan')} className={actionBtn}>
                <Search className="w-3 h-3" /> Scan items
              </button>
              <textarea rows={5} value={itemJson} onChange={(e) => setItemJson(e.target.value)} className={`${inputCls} text-emerald-300`} />
              <p className="text-[10px] text-slate-500">Plain JSON is converted to DynamoDB attribute values. Include the table's key attributes.</p>
              <button type="button" onClick={putItem} className={primaryBtn}>
                <Upload className="w-3 h-3" /> Put item
              </button>
            </>
          )}

          {service === 'sqs' && (
            <>
              <textarea rows={3} value={messageBody} onChange={(e) => setMessageBody(e.target.value)} className={`${inputCls} text-emerald-300`} />
              <div className="flex gap-1.5">
                <button type="button" onClick={() => run('send_message', { body: messageBody })} className={primaryBtn}>
                  <Send className="w-3 h-3" /> Send
                </button>
                <button type="button" onClick={() => run('receive_message')} className={actionBtn}>
                  <Inbox className="w-3 h-3" /> Receive
                </button>
              </div>
            </>
          )}

          {service === 'lambda' && (
            <>
              <textarea rows={5} value={eventJson} onChange={(e) => setEventJson(e.target.value)} className={`${inputCls} text-emerald-300`} />
              <button type="button" onClick={invoke} className={primaryBtn}>
                <Zap className="w-3 h-3" /> Invoke {target}
              </button>
            </>
          )}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px]">
            <span className={result.ok ? 'text-emerald-400' : 'text-rose-400'}>
              {result.ok ? 'Success' : 'Failed'}
            </span>
          </div>
          {result.cliCommand && (
            <code className="block text-[10px] font-mono text-slate-400 break-all">$ {result.cliCommand}</code>
          )}
          <pre className="rounded-xl border border-slate-800 bg-[#080a0f] p-3 font-mono text-[10.5px] leading-relaxed text-slate-200 overflow-x-auto max-h-80 select-text">
            {result.ok ? JSON.stringify(result.data, null, 2) : result.error}
          </pre>
        </div>
      )}
    </div>
  );
}

const inputCls =
  'w-full bg-[#0d1017] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-orange-500';
const actionBtn =
  'px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 shrink-0';
const primaryBtn =
  'px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-orange-500 hover:bg-orange-400 text-slate-950 flex items-center gap-1 shrink-0';
