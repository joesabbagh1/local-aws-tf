import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type Connection,
} from '@xyflow/react';
import type {
  CloudNode,
  CloudEdge,
  EnvironmentId,
  EnvironmentProfile,
  ProvisioningState,
} from '../types/cloud';
import {
  DEFAULT_ENVIRONMENTS,
  SERVICE_BY_TYPE,
  getDefaultConfigForService,
} from '../data/awsCatalog';
import { ARCHITECTURE_TEMPLATES } from '../data/templates';
import {
  compileTerraformForEnvironment,
  resolveNodeConfigForEnv,
  sanitizeIdentifier,
  type CompileTarget,
} from '../utils/terraformCompiler';
import { AWS_EXPORT_USER_FILES } from '../utils/awsExport';
import { statusFromState } from '../utils/terraformState';
import { parseTerraformHclToCanvas, type HclImportResult } from '../utils/hclImporter';
import { toProjectFile, withRuntimeStateFrom } from '../utils/projectFile';
import {
  buildResourceNameResolver,
  planHasChanges,
  summarizePlan,
  type PlanResourceChange,
  type PlanSummary,
} from '../utils/planSummary';
import {
  autoLayoutNodes,
  findDropContainer,
  normalizeNodes,
  releaseChildren,
  reparentNode,
} from '../utils/canvasLayout';

export type RightDrawerTab =
  | 'inspector'
  | 'env-matrix'
  | 'terraform'
  | 'emulator'
  | 'explorer'
  | 'audit';

/** The main area: the architecture canvas or the cost analytics page. */
export type WorkspaceView = 'design' | 'costs';

export type TerraformCommand = 'init' | 'validate' | 'plan' | 'apply' | 'destroy';

/** A plan that has been run but not applied yet; the canvas shows it until the design changes. */
export interface PendingPlan extends PlanSummary {
  envId: EnvironmentId;
  /** Compiled Terraform at plan time. A different value means the plan no longer matches the canvas. */
  fingerprint: string;
}

/** Where the canvas is saved: a file next to the Terraform when the local API is reachable. */
export interface ProjectFileStatus {
  state: 'unknown' | 'saved' | 'saving' | 'unavailable' | 'error';
  file?: string;
  error?: string;
}

interface HistorySnapshot {
  nodes: CloudNode[];
  edges: CloudEdge[];
}

interface CloudStudioState {
  activeEnv: EnvironmentId;
  environments: Record<EnvironmentId, EnvironmentProfile>;

  nodes: CloudNode[];
  edges: CloudEdge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;

  // Undo / Redo History
  past: HistorySnapshot[];
  future: HistorySnapshot[];

  // UI Panels & Modals
  view: WorkspaceView;
  rightTab: RightDrawerTab;
  isCatalogOpen: boolean;
  isDrawerOpen: boolean;
  isTemplateModalOpen: boolean;
  isImportModalOpen: boolean;
  isExportModalOpen: boolean;
  emulatorStatuses: Record<number, { running: boolean; status: string; caExists: boolean }>;

  // Live Terminal / Execution Output
  terminalLogs: string[];
  isRunningCommand: boolean;
  runningCommand: TerraformCommand | null;
  runningEnv: EnvironmentId | null;
  pendingPlan: PendingPlan | null;
  projectFile: ProjectFileStatus;

  // Actions
  /** Snapshot for undo. Calls sharing a coalesceKey within a short window collapse into one entry. */
  pushHistory: (coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;

  setActiveEnv: (env: EnvironmentId) => void;
  updateEnvironmentProfile: (env: EnvironmentId, patch: Partial<EnvironmentProfile>) => void;

  onNodesChange: OnNodesChange<CloudNode>;
  onEdgesChange: OnEdgesChange<CloudEdge>;
  onConnect: OnConnect;
  onNodeDragStart: () => void;
  onNodeDragStop: (nodeIds: string[]) => void;

  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  /** Switches the drawer tab and opens the drawer if it is collapsed. */
  setRightTab: (tab: RightDrawerTab) => void;
  setView: (view: WorkspaceView) => void;
  setCatalogOpen: (open: boolean) => void;
  setDrawerOpen: (open: boolean) => void;
  setTemplateModalOpen: (open: boolean) => void;
  setImportModalOpen: (open: boolean) => void;
  setExportModalOpen: (open: boolean) => void;

  addServiceNode: (serviceType: string, position?: { x: number; y: number }) => void;
  duplicateNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  deleteEdge: (edgeId: string) => void;
  deleteSelectedElements: () => void;

  updateNodeMetadata: (
    nodeId: string,
    patch: { label?: string; resourceName?: string; notes?: string; inlineCode?: string; sourceDir?: string }
  ) => void;
  updateNodeProperty: (
    nodeId: string,
    key: string,
    value: any,
    scope: 'base' | EnvironmentId
  ) => void;
  resetNodeEnvOverride: (nodeId: string, envId: EnvironmentId, key?: string) => void;
  toggleNodeInEnvironment: (nodeId: string, envId: EnvironmentId) => void;
  updateNodeTags: (nodeId: string, tags: Record<string, string>) => void;

  updateEdgeData: (edgeId: string, patch: Partial<NonNullable<CloudEdge['data']>>) => void;

  loadTemplate: (templateId: string) => void;
  importTerraformHcl: (hclText: string) => HclImportResult;
  exportProjectJson: () => string;
  importProjectJson: (jsonText: string) => boolean;
  clearCanvas: () => void;
  autoLayoutCanvas: () => void;

  refreshEmulatorStatuses: () => Promise<void>;
  syncTerraformToDisk: () => Promise<{ ok: boolean; writtenFiles?: string[] }>;
  /** Writes Terraform for real AWS accounts to ./terraform-aws. LocalCloud never runs it. */
  exportForAws: () => Promise<{ ok: boolean; writtenFiles?: string[]; keptFiles?: string[]; error?: string }>;
  controlEmulatorContainer: (action: 'start' | 'stop', envId?: EnvironmentId) => Promise<void>;
  runTerraformCommand: (
    command: TerraformCommand,
    envId?: EnvironmentId,
    options?: { usePlan?: boolean }
  ) => Promise<void>;
  /** Plans first; applies only a plan that was reviewed and still matches the canvas. */
  requestApply: (envId?: EnvironmentId) => Promise<void>;
  discardPlan: () => void;
  loadProjectFromDisk: () => Promise<void>;
  /** Node status and outputs from each environment's Terraform state (all environments by default). */
  syncStatusFromState: (envIds?: EnvironmentId[]) => Promise<void>;
  appendTerminalLog: (msg: string) => void;
  clearTerminalLogs: () => void;
}

const initialTemplate = ARCHITECTURE_TEMPLATES[0];
const ENV_ORDER: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];
const MAX_TERMINAL_LINES = 500;
const HISTORY_COALESCE_MS = 1200;

let lastHistoryPush = { key: '', at: 0 };

const TF_PROGRESS_LINE =
  /^(?:module\.[^\s]+\.)?([a-z0-9_]+)\.([A-Za-z0-9_-]+)(?:\[[^\]]*\])?: (Creating|Creation complete|Modifying|Modifications complete|Destroying|Destruction complete|Still creating|Still modifying)/;
const TF_ERROR_RESOURCE = /with (?:module\.[^\s]+\.)?([a-z0-9_]+)\.([A-Za-z0-9_-]+)/;

/** Everything that decides what `terraform plan` would do for one environment. */
function planFingerprint(
  state: Pick<CloudStudioState, 'nodes' | 'edges' | 'environments'>,
  envId: EnvironmentId
): string {
  const compiled = compileTerraformForEnvironment(state.nodes, state.edges, state.environments[envId], state.environments);
  const lambdaCode = state.nodes
    .filter((n) => n.data.serviceType === 'aws_lambda_function' && n.data.envEnabled?.[envId] !== false)
    .map((n) => `${n.id}:${n.data.sourceDir ?? ''}:${n.data.inlineCode || ''}`);
  return [compiled.mainTf, compiled.providerTf, compiled.variablesTf, compiled.tfvars, compiled.outputsTf, ...lambdaCode].join('\u0000');
}

interface LambdaArtifact {
  envId: EnvironmentId;
  resourceName: string;
  runtime: string;
  handler: string;
  code?: string;
  sourceDir?: string;
}

/** Every file of one compile target, laid out as environments/<env>/…, plus the Lambda zips to build. */
function buildTerraformFiles(
  state: Pick<CloudStudioState, 'nodes' | 'edges' | 'environments'>,
  target: CompileTarget
) {
  const { nodes, edges, environments } = state;
  const files: Record<string, string> = {};
  const filesIfMissing: Record<string, string> = {};
  const lambdaArtifacts: LambdaArtifact[] = [];

  for (const envId of ENV_ORDER) {
    const compiled = compileTerraformForEnvironment(nodes, edges, environments[envId], environments, target);
    const dir = `environments/${envId}`;
    files[`${dir}/main.tf`] = compiled.mainTf;
    files[`${dir}/provider.tf`] = compiled.providerTf;
    files[`${dir}/variables.tf`] = compiled.variablesTf;
    files[`${dir}/${envId}.tfvars`] = compiled.tfvars;
    files[`${dir}/outputs.tf`] = compiled.outputsTf;

    if (target === 'emulator') {
      files[`${dir}/run-emulator-${envId}.sh`] = compiled.emulatorScriptSh;
      if (envId === 'dev') {
        files['Dockerfile.emulator'] = compiled.dockerfile;
        files['docker-compose.emulator.yml'] = compiled.dockerComposeYml;
      }
    } else {
      files[`${dir}/backend.tf`] = compiled.backendTf;
      // Filled in by the user once; later exports keep their values
      for (const name of AWS_EXPORT_USER_FILES) filesIfMissing[`${dir}/${name}`] = compiled.backendConfig;
    }

    for (const n of nodes) {
      if (n.data.serviceType === 'aws_lambda_function' && n.data.envEnabled?.[envId] !== false) {
        const cfg = resolveNodeConfigForEnv(n, envId);
        lambdaArtifacts.push({
          envId,
          resourceName: sanitizeIdentifier(n.data.resourceName || n.data.label),
          runtime: String(cfg.runtime || 'nodejs20.x'),
          handler: String(cfg.handler || 'index.handler'),
          code: n.data.inlineCode,
          sourceDir: n.data.sourceDir,
        });
      }
    }
  }

  return { files, filesIfMissing, lambdaArtifacts };
}

function withProvisioningState(
  nodes: CloudNode[],
  envId: EnvironmentId,
  decide: (node: CloudNode, current: ProvisioningState | undefined) => ProvisioningState | undefined
): CloudNode[] {
  return nodes.map((n) => {
    const current = n.data.provisioningStatus?.[envId];
    const next = decide(n, current);
    if (!next || next === current) return n;
    return {
      ...n,
      data: {
        ...n.data,
        provisioningStatus: { ...(n.data.provisioningStatus || {}), [envId]: next },
      },
    };
  });
}

/** Environment colours are presentation, not user settings; always take the current ones. */
function withCurrentEnvironmentColors(
  environments: Partial<Record<EnvironmentId, EnvironmentProfile>> | undefined
): Record<EnvironmentId, EnvironmentProfile> | undefined {
  if (!environments) return undefined;
  return Object.fromEntries(
    ENV_ORDER.map((id) => [
      id,
      { ...DEFAULT_ENVIRONMENTS[id], ...environments[id], color: DEFAULT_ENVIRONMENTS[id].color },
    ])
  ) as Record<EnvironmentId, EnvironmentProfile>;
}

// Disk copy of the project. Saving starts only after the first load, so a fresh tab can never
// overwrite the file with its default canvas.
const projectDisk = { ready: false, lastSaved: '', loading: null as Promise<void> | null };
const PROJECT_SAVE_DEBOUNCE_MS = 800;

async function saveProjectToDisk(): Promise<void> {
  if (!projectDisk.ready) return;
  const state = useCloudStore.getState();
  const project = toProjectFile(state);
  const serialized = JSON.stringify(project);
  if (serialized === projectDisk.lastSaved) return;

  const file = state.projectFile.file;
  useCloudStore.setState({ projectFile: { state: 'saving', file } });
  try {
    const res = await fetch('/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    projectDisk.lastSaved = serialized;
    useCloudStore.setState({ projectFile: { state: 'saved', file } });
  } catch (err: any) {
    useCloudStore.setState({ projectFile: { state: 'error', file, error: err?.message || 'Save failed' } });
  }
}

export const useCloudStore = create<CloudStudioState>()(
  persist(
    (set, get) => ({
      activeEnv: 'dev',
      environments: { ...DEFAULT_ENVIRONMENTS },

      nodes: normalizeNodes(initialTemplate.nodes),
      edges: initialTemplate.edges,
      selectedNodeId: initialTemplate.nodes[2]?.id || null,
      selectedEdgeId: null,

      past: [],
      future: [],

      view: 'design',
      rightTab: 'inspector',
      isCatalogOpen: true,
      isDrawerOpen: true,
      isTemplateModalOpen: false,
      isImportModalOpen: false,
      isExportModalOpen: false,
      emulatorStatuses: {
        9297: { running: false, status: 'unchecked', caExists: false },
        9298: { running: false, status: 'unchecked', caExists: false },
        9299: { running: false, status: 'unchecked', caExists: false },
        9300: { running: false, status: 'unchecked', caExists: false },
      },

      terminalLogs: [
        'LocalCloud Studio ready. Emulator ports: dev 9297, testing 9298, staging 9299, prod 9300.',
      ],
      isRunningCommand: false,
      runningCommand: null,
      runningEnv: null,
      pendingPlan: null,
      projectFile: { state: 'unknown' },

      pushHistory: (coalesceKey) => {
        const now = Date.now();
        if (
          coalesceKey &&
          lastHistoryPush.key === coalesceKey &&
          now - lastHistoryPush.at < HISTORY_COALESCE_MS
        ) {
          lastHistoryPush.at = now;
          return;
        }
        lastHistoryPush = { key: coalesceKey || '', at: now };

        const { nodes, edges, past } = get();
        const snapshot: HistorySnapshot = {
          nodes: structuredClone(nodes),
          edges: structuredClone(edges),
        };
        set({
          past: [...past.slice(-24), snapshot],
          future: [],
        });
      },

      undo: () => {
        const { past, future, nodes, edges } = get();
        if (past.length === 0) return;
        lastHistoryPush = { key: '', at: 0 };
        const previous = past[past.length - 1];
        const newPast = past.slice(0, past.length - 1);
        set({
          past: newPast,
          future: [{ nodes: structuredClone(nodes), edges: structuredClone(edges) }, ...future],
          nodes: previous.nodes,
          edges: previous.edges,
        });
      },

      redo: () => {
        const { past, future, nodes, edges } = get();
        if (future.length === 0) return;
        lastHistoryPush = { key: '', at: 0 };
        const next = future[0];
        const newFuture = future.slice(1);
        set({
          past: [...past, { nodes: structuredClone(nodes), edges: structuredClone(edges) }],
          future: newFuture,
          nodes: next.nodes,
          edges: next.edges,
        });
      },

      setActiveEnv: (env) => set({ activeEnv: env }),

      updateEnvironmentProfile: (env, patch) =>
        set((state) => ({
          environments: {
            ...state.environments,
            [env]: {
              ...state.environments[env],
              ...patch,
            },
          },
        })),


      onNodesChange: (changes) => {
        set({
          nodes: applyNodeChanges(changes, get().nodes),
        });
      },

      onEdgesChange: (changes) => {
        set({
          edges: applyEdgeChanges(changes, get().edges),
        });
      },

      onConnect: (connection: Connection) => {
        get().pushHistory();
        const srcNode = get().nodes.find((n) => n.id === connection.source);
        const dstNode = get().nodes.find((n) => n.id === connection.target);

        let relationshipType: NonNullable<CloudEdge['data']>['relationshipType'] = 'data_flow';
        let label = 'Connects To';

        if (srcNode && dstNode) {
          const sType = srcNode.data.serviceType;
          const dType = dstNode.data.serviceType;
          if (sType === 'aws_vpc' || sType === 'aws_subnet' || sType === 'aws_security_group') {
            relationshipType = 'network_attachment';
            label = 'VPC Network';
          } else if (
            sType === 'aws_apigatewayv2_api' ||
            sType === 'aws_sqs_queue' ||
            sType === 'aws_sns_topic' ||
            sType === 'aws_kinesis_stream' ||
            sType === 'aws_cloudwatch_event_bus'
          ) {
            relationshipType = 'event_trigger';
            label = 'Event Trigger';
          } else if (
            dType === 'aws_dynamodb_table' ||
            dType === 'aws_s3_bucket' ||
            dType === 'aws_secretsmanager_secret' ||
            dType === 'aws_kms_key'
          ) {
            relationshipType = 'iam_grant';
            label = 'IAM Policy & Data';
          } else if (sType === 'aws_lb' || sType === 'aws_cloudfront_distribution') {
            relationshipType = 'target_route';
            label = 'Route Traffic';
          }
        }

        const newEdge: CloudEdge = {
          ...connection,
          id: `edge-${connection.source}-${connection.target}-${Date.now().toString(36)}`,
          animated: relationshipType !== 'network_attachment',
          data: {
            relationshipType,
            label,
          },
        };

        set({
          edges: addEdge(newEdge, get().edges),
          selectedEdgeId: newEdge.id,
          selectedNodeId: null,
        });
      },

      onNodeDragStart: () => get().pushHistory(),

      onNodeDragStop: (nodeIds) => {
        let nodes = get().nodes;
        for (const id of nodeIds) {
          const node = nodes.find((n) => n.id === id);
          if (!node) continue;
          const container = findDropContainer(node, nodes);
          nodes = reparentNode(nodes, id, container?.id);
        }
        if (nodes !== get().nodes) set({ nodes });
      },

      selectNode: (nodeId) =>
        set({
          selectedNodeId: nodeId,
          selectedEdgeId: null,
        }),

      selectEdge: (edgeId) =>
        set({
          selectedEdgeId: edgeId,
          selectedNodeId: null,
        }),

      setRightTab: (tab) => set({ rightTab: tab, isDrawerOpen: true }),
      setView: (view) => set({ view }),
      setCatalogOpen: (open) => set({ isCatalogOpen: open }),
      setDrawerOpen: (open) => set({ isDrawerOpen: open }),
      setTemplateModalOpen: (open) => set({ isTemplateModalOpen: open }),
      setImportModalOpen: (open) => set({ isImportModalOpen: open }),
      setExportModalOpen: (open) => set({ isExportModalOpen: open }),

      addServiceNode: (serviceType, position) => {
        const svc = SERVICE_BY_TYPE[serviceType];
        if (!svc) return;
        get().pushHistory();

        const existingOfType = get().nodes.filter((n) => n.data.serviceType === serviceType).length;
        const indexSuffix = existingOfType + 1;
        const cleanShort = svc.shortName
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '_')
          .replace(/_+/g, '_');

        const newId = `node-${cleanShort}-${Date.now().toString(36)}`;
        const defaultPos = position || {
          x: 240 + ((get().nodes.length * 45) % 450),
          y: 120 + ((get().nodes.length * 40) % 340),
        };

        const defaultInlineCode =
          serviceType === 'aws_lambda_function'
            ? `export const handler = async (event) => {\n  console.log("Event received on AWS Emulator:", JSON.stringify(event));\n  return {\n    statusCode: 200,\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify({\n      ok: true,\n      service: "${cleanShort}_${indexSuffix}",\n      environment: process.env.ENVIRONMENT || "dev",\n      timestamp: new Date().toISOString(),\n    }),\n  };\n};\n`
            : undefined;

        const newNode: CloudNode = {
          id: newId,
          type: svc.isContainer ? 'awsContainer' : 'awsNode',
          position: defaultPos,
          ...(svc.isContainer
            ? { width: svc.defaultWidth ?? 420, height: svc.defaultHeight ?? 280 }
            : {}),
          data: {
            label: `${svc.shortName} ${indexSuffix}`,
            resourceName: `${cleanShort}_${indexSuffix}`,
            serviceType,
            baseConfig: getDefaultConfigForService(serviceType),
            envOverrides: {},
            envEnabled: {
              dev: true,
              testing: true,
              staging: true,
              prod: true,
            },
            tags: {
              Service: svc.serviceCode,
            },
            inlineCode: defaultInlineCode,
          },
        };

        // Dropping onto a VPC / Subnet places the new resource inside it
        let nodes = normalizeNodes([...get().nodes, newNode]);
        const container = position ? findDropContainer(newNode, nodes) : undefined;
        if (container) nodes = reparentNode(nodes, newId, container.id);

        set({
          nodes,
          selectedNodeId: newId,
          selectedEdgeId: null,
          rightTab: 'inspector',
        });
      },

      duplicateNode: (nodeId) => {
        const node = get().nodes.find((n) => n.id === nodeId);
        if (!node) return;
        get().pushHistory();

        const newId = `${node.id}-copy-${Date.now().toString(36)}`;
        const copyNode: CloudNode = {
          ...node,
          id: newId,
          position: {
            x: node.position.x + 48,
            y: node.position.y + 48,
          },
          selected: true,
          data: {
            ...structuredClone(node.data),
            label: `${node.data.label} Copy`,
            resourceName: `${node.data.resourceName}_copy`,
          },
        };

        set((state) => ({
          nodes: normalizeNodes([...state.nodes.map((n) => ({ ...n, selected: false })), copyNode]),
          selectedNodeId: newId,
        }));
      },

      deleteNode: (nodeId) => {
        get().pushHistory();
        set((state) => ({
          nodes: releaseChildren(state.nodes, nodeId).filter((n) => n.id !== nodeId),
          edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
          selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
        }));
      },

      deleteEdge: (edgeId) => {
        get().pushHistory();
        set((state) => ({
          edges: state.edges.filter((e) => e.id !== edgeId),
          selectedEdgeId: state.selectedEdgeId === edgeId ? null : state.selectedEdgeId,
        }));
      },

      deleteSelectedElements: () => {
        const { nodes, edges, selectedNodeId, selectedEdgeId } = get();
        const nodeIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
        if (selectedNodeId) nodeIds.add(selectedNodeId);
        const edgeIds = new Set(edges.filter((e) => e.selected).map((e) => e.id));
        if (selectedEdgeId) edgeIds.add(selectedEdgeId);
        if (nodeIds.size === 0 && edgeIds.size === 0) return;

        get().pushHistory();
        let remaining = nodes;
        for (const id of nodeIds) remaining = releaseChildren(remaining, id);
        set({
          nodes: remaining.filter((n) => !nodeIds.has(n.id)),
          edges: edges.filter(
            (e) => !edgeIds.has(e.id) && !nodeIds.has(e.source) && !nodeIds.has(e.target)
          ),
          selectedNodeId: null,
          selectedEdgeId: null,
        });
      },

      updateNodeMetadata: (nodeId, patch) => {
        get().pushHistory(`meta:${nodeId}:${Object.keys(patch).join(',')}`);
        set((state) => ({
          nodes: state.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    ...patch,
                  },
                }
              : node
          ),
        }));
      },

      updateNodeProperty: (nodeId, key, value, scope) => {
        get().pushHistory(`prop:${nodeId}:${scope}:${key}`);
        set((state) => ({
          nodes: state.nodes.map((node) => {
            if (node.id !== nodeId) return node;

            if (scope === 'base') {
              return {
                ...node,
                data: {
                  ...node.data,
                  baseConfig: {
                    ...node.data.baseConfig,
                    [key]: value,
                  },
                },
              };
            }

            const currentEnvOverrides = node.data.envOverrides?.[scope] || {};
            return {
              ...node,
              data: {
                ...node.data,
                envOverrides: {
                  ...node.data.envOverrides,
                  [scope]: {
                    ...currentEnvOverrides,
                    [key]: value,
                  },
                },
              },
            };
          }),
        }));
      },

      resetNodeEnvOverride: (nodeId, envId, key) => {
        get().pushHistory();
        set((state) => ({
          nodes: state.nodes.map((node) => {
            if (node.id !== nodeId) return node;
            const envMap = { ...(node.data.envOverrides?.[envId] || {}) };
            if (key) {
              delete envMap[key];
            } else {
              for (const k of Object.keys(envMap)) delete envMap[k];
            }
            return {
              ...node,
              data: {
                ...node.data,
                envOverrides: {
                  ...node.data.envOverrides,
                  [envId]: envMap,
                },
              },
            };
          }),
        }));
      },

      toggleNodeInEnvironment: (nodeId, envId) => {
        get().pushHistory();
        set((state) => ({
          nodes: state.nodes.map((node) => {
            if (node.id !== nodeId) return node;
            const current = node.data.envEnabled?.[envId] !== false;
            return {
              ...node,
              data: {
                ...node.data,
                envEnabled: {
                  ...node.data.envEnabled,
                  [envId]: !current,
                },
              },
            };
          }),
        }));
      },

      updateNodeTags: (nodeId, tags) => {
        get().pushHistory();
        set((state) => ({
          nodes: state.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    tags,
                  },
                }
              : node
          ),
        }));
      },

      updateEdgeData: (edgeId, patch) => {
        get().pushHistory(`edge:${edgeId}:${Object.keys(patch).join(',')}`);
        set((state) => ({
          edges: state.edges.map((edge) =>
            edge.id === edgeId
              ? {
                  ...edge,
                  data: {
                    ...(edge.data || { relationshipType: 'data_flow' }),
                    ...patch,
                  },
                }
              : edge
          ),
        }));
      },

      loadTemplate: (templateId) => {
        const tpl = ARCHITECTURE_TEMPLATES.find((t) => t.id === templateId);
        if (!tpl) return;
        get().pushHistory();
        const clonedNodes = normalizeNodes(structuredClone(tpl.nodes));
        const clonedEdges = structuredClone(tpl.edges);
        set({
          nodes: clonedNodes,
          edges: clonedEdges,
          selectedNodeId: clonedNodes[0]?.id || null,
          selectedEdgeId: null,
          isTemplateModalOpen: false,
        });
      },

      importTerraformHcl: (hclText) => {
        const result = parseTerraformHclToCanvas(hclText);
        if (result.importedCount > 0) {
          get().pushHistory();
          set({
            nodes: autoLayoutNodes(normalizeNodes(result.nodes)),
            edges: result.edges,
            selectedNodeId: result.nodes[0]?.id || null,
            selectedEdgeId: null,
          });
        }
        return result;
      },

      exportProjectJson: () => {
        const { nodes, edges, environments, activeEnv } = get();
        return JSON.stringify(
          {
            version: '2.0.0',
            exportedAt: new Date().toISOString(),
            activeEnv,
            environments,
            nodes,
            edges,
          },
          null,
          2
        );
      },

      importProjectJson: (jsonText) => {
        try {
          const parsed = JSON.parse(jsonText);
          if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return false;
          get().pushHistory();
          set({
            nodes: normalizeNodes(parsed.nodes),
            edges: parsed.edges,
            environments: withCurrentEnvironmentColors(parsed.environments) || get().environments,
            activeEnv: parsed.activeEnv || 'dev',
            selectedNodeId: parsed.nodes[0]?.id || null,
            selectedEdgeId: null,
            isImportModalOpen: false,
          });
          return true;
        } catch {
          return false;
        }
      },

      clearCanvas: () => {
        get().pushHistory();
        set({
          nodes: [],
          edges: [],
          selectedNodeId: null,
          selectedEdgeId: null,
        });
      },

      autoLayoutCanvas: () => {
        get().pushHistory();
        set({ nodes: autoLayoutNodes(get().nodes) });
      },

      refreshEmulatorStatuses: async () => {
        try {
          const ports = Object.values(get().environments)
            .map((e) => e.emulatorPort)
            .join(',');
          const res = await fetch(`/api/emulator/status?ports=${ports}`);
          if (!res.ok) return;
          const data = await res.json();
          if (data.ok && data.statuses) {
            set({ emulatorStatuses: data.statuses });
          }
        } catch {
          // Ignore network errors if running static preview
        }
      },

      syncTerraformToDisk: async () => {
        const { appendTerminalLog } = get();
        const { files, lambdaArtifacts } = buildTerraformFiles(get(), 'emulator');

        try {
          const res = await fetch('/api/terraform/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'emulator', files, lambdaArtifacts }),
          });
          const data = await res.json();
          if (data.ok) {
            appendTerminalLog(
              `Synced ${data.writtenFiles?.length || 0} Terraform & Lambda zip artifacts to ./terraform-out`
            );
            for (const error of data.errors || []) appendTerminalLog(`Error: ${error}`);
            return { ok: (data.errors || []).length === 0, writtenFiles: data.writtenFiles };
          }
          return { ok: false };
        } catch {
          return { ok: false };
        }
      },

      exportForAws: async () => {
        const { files, filesIfMissing, lambdaArtifacts } = buildTerraformFiles(get(), 'aws');
        try {
          const res = await fetch('/api/terraform/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'aws', files, filesIfMissing, lambdaArtifacts }),
          });
          const data = await res.json();
          if (!data.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
          if (data.errors?.length) return { ok: false, error: data.errors.join(' · ') };
          get().appendTerminalLog(`Exported Terraform for AWS to ./${data.outDir} (${data.writtenFiles?.length || 0} files)`);
          return { ok: true, writtenFiles: data.writtenFiles, keptFiles: data.keptFiles };
        } catch (err: any) {
          return { ok: false, error: err?.message || 'The local API is not reachable' };
        }
      },

      controlEmulatorContainer: async (action, targetEnvId) => {
        const envId = targetEnvId || get().activeEnv;
        const profile = get().environments[envId];
        const { appendTerminalLog, refreshEmulatorStatuses } = get();

        set({ isRunningCommand: true });
        appendTerminalLog(
          `[${envId.toUpperCase()}] ${action === 'start' ? 'Starting' : 'Stopping'} aws-emulator container on port ${profile.emulatorPort}...`
        );

        try {
          const res = await fetch('/api/emulator/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action,
              envId,
              port: profile.emulatorPort,
            }),
          });
          const data = await res.json();
          if (data.ok) {
            appendTerminalLog(
              `[${envId.toUpperCase()}] Container ${action} succeeded:\n${data.output || 'Ready'}`
            );
          } else {
            appendTerminalLog(
              `Warning: [${envId.toUpperCase()}] Container ${action} note: ${data.error || ''}\n${data.output || ''}`
            );
          }
          await refreshEmulatorStatuses();
        } catch (err: any) {
          appendTerminalLog(`Error: [${envId.toUpperCase()}] ${err?.message}`);
        } finally {
          set({ isRunningCommand: false });
        }
      },

      requestApply: async (targetEnvId) => {
        const envId = targetEnvId || get().activeEnv;
        const plan = get().pendingPlan;
        const reviewed =
          plan && plan.envId === envId && planHasChanges(plan) && plan.fingerprint === planFingerprint(get(), envId);
        if (reviewed) {
          await get().runTerraformCommand('apply', envId, { usePlan: true });
        } else {
          set({ rightTab: 'emulator' });
          await get().runTerraformCommand('plan', envId);
        }
      },

      discardPlan: () => set({ pendingPlan: null }),

      runTerraformCommand: async (command, targetEnvId, options) => {
        const envId = targetEnvId || get().activeEnv;
        const profile = get().environments[envId];
        const { syncTerraformToDisk, appendTerminalLog } = get();
        const tag = `[${envId.toUpperCase()}]`;

        // Any run other than applying the reviewed plan makes that plan obsolete
        const keepPlan = command === 'apply' && options?.usePlan;
        set((state) => ({
          isRunningCommand: true,
          runningCommand: command,
          runningEnv: envId,
          pendingPlan: keepPlan || state.pendingPlan?.envId !== envId ? state.pendingPlan : null,
        }));
        const fingerprint = planFingerprint(get(), envId);
        let planChanges: PlanResourceChange[] | null = null;

        const interimState: ProvisioningState | undefined =
          command === 'apply' || command === 'destroy'
            ? 'provisioning'
            : command === 'plan'
              ? 'planning'
              : undefined;
        const previousStates = Object.fromEntries(
          get().nodes.map((n) => [n.id, n.data.provisioningStatus?.[envId]])
        );
        if (interimState) {
          set((state) => ({
            nodes: withProvisioningState(state.nodes, envId, (n) =>
              n.data.envEnabled?.[envId] !== false ? interimState : undefined
            ),
          }));
        }

        const synced = await syncTerraformToDisk();
        if (!synced.ok) {
          appendTerminalLog(`Error: ${tag} ./terraform-out could not be prepared (see above, or is the local server running?). Nothing was run.`);
          set((state) => ({
            nodes: withProvisioningState(state.nodes, envId, (n) => previousStates[n.id] ?? 'unapplied'),
            isRunningCommand: false,
            runningCommand: null,
            runningEnv: null,
          }));
          return;
        }

        appendTerminalLog(
          `${tag} $ terraform ${command} in ./terraform-out/environments/${envId} → https://127.0.0.1:${profile.emulatorPort}`
        );

        const resolveNode = buildResourceNameResolver(get().nodes, envId);
        const settled = new Map<string, ProvisioningState>();
        const markNode = (nodeId: string | undefined, state: ProvisioningState) => {
          if (!nodeId) return;
          settled.set(nodeId, state);
          set((s) => ({
            nodes: withProvisioningState(s.nodes, envId, (n) => (n.id === nodeId ? state : undefined)),
          }));
        };

        const handleLine = (line: string) => {
          if (!line.trim()) return;
          appendTerminalLog(line);
          const progress = line.match(TF_PROGRESS_LINE);
          if (progress) {
            const nodeId = resolveNode(progress[2]);
            const verb = progress[3];
            if (verb === 'Creation complete' || verb === 'Modifications complete') {
              markNode(nodeId, 'provisioned');
            } else if (verb === 'Destruction complete') {
              markNode(nodeId, 'unapplied');
            } else if (nodeId && !settled.has(nodeId)) {
              markNode(nodeId, 'provisioning');
              settled.delete(nodeId);
            }
            return;
          }
          const errorRes = line.match(TF_ERROR_RESOURCE);
          if (errorRes) markNode(resolveNode(errorRes[2]), 'failed');
        };

        let exitCode = 1;
        try {
          const res = await fetch('/api/terraform/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              command,
              envId,
              port: profile.emulatorPort,
              region: profile.region,
              usePlan: options?.usePlan === true,
            }),
          });
          if (!res.body) throw new Error(`HTTP ${res.status}`);

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const exitMatch = line.match(/^__LC_EXIT__:(-?\d+)$/);
              if (exitMatch) exitCode = Number(exitMatch[1]);
              else if (line.startsWith('__LC_PLAN__:')) {
                try {
                  planChanges = JSON.parse(line.slice('__LC_PLAN__:'.length));
                } catch {
                  planChanges = null;
                }
              } else handleLine(line);
            }
            if (done) break;
          }
          if (buffer) handleLine(buffer);
        } catch (err: any) {
          appendTerminalLog(`Error: ${tag} ${err?.message}`);
        }

        const ok = exitCode === 0;
        set((state) => ({
          nodes: withProvisioningState(state.nodes, envId, (n, current) => {
            if (n.data.envEnabled?.[envId] === false || settled.has(n.id)) return undefined;
            if (current !== interimState) return undefined;
            if (!ok) return command === 'plan' ? (previousStates[n.id] ?? 'unapplied') : 'failed';
            if (command === 'apply') return 'provisioned';
            if (command === 'destroy') return 'unapplied';
            return previousStates[n.id] ?? 'unapplied';
          }),
          isRunningCommand: false,
          runningCommand: null,
          runningEnv: null,
          pendingPlan:
            command === 'plan' && ok && planChanges
              ? { envId, fingerprint, ...summarizePlan(planChanges, state.nodes, envId) }
              : command === 'apply' && state.pendingPlan?.envId === envId
                ? null
                : state.pendingPlan,
        }));

        appendTerminalLog(
          ok
            ? `${tag} terraform ${command} completed successfully.`
            : `Warning: ${tag} terraform ${command} exited with code ${exitCode}.`
        );

        // Whatever the outcome, state now says what exists (a failed apply can still create some resources)
        if (command === 'apply' || command === 'destroy') await get().syncStatusFromState([envId]);
      },

      syncStatusFromState: async (envIds = ENV_ORDER) => {
        await Promise.all(
          envIds.map(async (envId) => {
            try {
              const res = await fetch(`/api/terraform/state?envId=${envId}`);
              const data = await res.json();
              if (!data.ok) return;
              set((state) => {
                // Don't fight a run that is updating this environment live
                if (state.isRunningCommand && state.runningEnv === envId) return {};
                const { status, outputs } = statusFromState(state.nodes, envId, data);
                return {
                  nodes: state.nodes.map((n) => {
                    const nextStatus = status[n.id];
                    const nextOutputs = outputs[n.id];
                    if (
                      n.data.provisioningStatus?.[envId] === nextStatus &&
                      JSON.stringify(n.data.provisionedOutputs?.[envId]) === JSON.stringify(nextOutputs)
                    ) {
                      return n;
                    }
                    return {
                      ...n,
                      data: {
                        ...n.data,
                        provisioningStatus: { ...(n.data.provisioningStatus || {}), [envId]: nextStatus },
                        provisionedOutputs: { ...(n.data.provisionedOutputs || {}), [envId]: nextOutputs },
                      },
                    };
                  }),
                };
              });
            } catch {
              // No local API (static preview): keep whatever status the browser had
            }
          })
        );
      },

      loadProjectFromDisk: () => {
        // StrictMode mounts twice in development; both callers share one load
        projectDisk.loading ??= (async () => {
        try {
          const res = await fetch('/api/project');
          const data = await res.json();
          if (!data.ok) {
            // Never overwrite a file we could not read
            set({ projectFile: { state: data.exists ? 'error' : 'unavailable', file: data.file, error: data.error } });
            if (data.exists) get().appendTerminalLog(`Error: ${data.error}. Fix or remove the file, then reload.`);
            return;
          }

          if (data.exists && Array.isArray(data.project?.nodes) && Array.isArray(data.project?.edges)) {
            const project = data.project;
            const nodes = withRuntimeStateFrom(normalizeNodes(project.nodes), get().nodes);
            set((state) => ({
              nodes,
              edges: project.edges,
              environments: withCurrentEnvironmentColors(project.environments) || state.environments,
              selectedNodeId: nodes.some((n) => n.id === state.selectedNodeId) ? state.selectedNodeId : null,
              selectedEdgeId: null,
              past: [],
              future: [],
            }));
          }

          projectDisk.ready = true;
          projectDisk.lastSaved = data.exists ? JSON.stringify(toProjectFile(get())) : '';
          set({ projectFile: { state: 'saved', file: data.file } });
          get().appendTerminalLog(
            data.exists ? `Loaded project from ./${data.file}` : `Saving project to ./${data.file}`
          );
          // First run in this directory, or the file needs normalising: write it now
          await saveProjectToDisk();
        } catch {
          // No local API (static preview): the canvas stays in browser storage only
          set({ projectFile: { state: 'unavailable' } });
        }
        })();
        return projectDisk.loading;
      },

      appendTerminalLog: (msg) =>
        set((state) => ({
          terminalLogs: [
            ...state.terminalLogs.slice(-(MAX_TERMINAL_LINES - 1)),
            `[${new Date().toLocaleTimeString()}] ${msg}`,
          ],
        })),

      clearTerminalLogs: () => set({ terminalLogs: [] }),
    }),
    {
      name: 'localcloud-studio-storage-v2',
      partialize: (state) => ({
        activeEnv: state.activeEnv,
        environments: state.environments,
        nodes: state.nodes,
        edges: state.edges,
        isCatalogOpen: state.isCatalogOpen,
        isDrawerOpen: state.isDrawerOpen,
      }),
      // Older saves predate VPC / Subnet containers; bring them into the current canvas shape
      merge: (persisted, current) => {
        const saved = (persisted || {}) as Partial<CloudStudioState>;
        let nodes = normalizeNodes(saved.nodes ?? current.nodes);
        // A reload mid-run leaves nodes stuck in an in-flight state
        for (const envId of ENV_ORDER) {
          nodes = withProvisioningState(nodes, envId, (_n, state) =>
            state === 'planning' || state === 'provisioning' ? 'unapplied' : undefined
          );
        }
        const environments = withCurrentEnvironmentColors(saved.environments) || current.environments;
        return { ...current, ...saved, environments, nodes };
      },
    }
  )
);

// React to design changes: drop a plan that no longer matches the canvas, and save the project file
let projectChangeTimer: ReturnType<typeof setTimeout> | undefined;
useCloudStore.subscribe((state, prev) => {
  if (
    state.nodes === prev.nodes &&
    state.edges === prev.edges &&
    state.environments === prev.environments
  ) {
    return;
  }
  clearTimeout(projectChangeTimer);
  projectChangeTimer = setTimeout(() => {
    const { pendingPlan, isRunningCommand } = useCloudStore.getState();
    if (
      pendingPlan &&
      !isRunningCommand &&
      pendingPlan.fingerprint !== planFingerprint(useCloudStore.getState(), pendingPlan.envId)
    ) {
      useCloudStore.setState({ pendingPlan: null });
    }
    void saveProjectToDisk();
  }, PROJECT_SAVE_DEBOUNCE_MS);
});
