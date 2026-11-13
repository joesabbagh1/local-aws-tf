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
import { compileTerraformForEnvironment } from '../utils/terraformCompiler';
import { parseTerraformHclToCanvas } from '../utils/hclImporter';

export type RightDrawerTab =
  | 'inspector'
  | 'env-matrix'
  | 'terraform'
  | 'emulator'
  | 'explorer'
  | 'audit';

interface HistorySnapshot {
  nodes: CloudNode[];
  edges: CloudEdge[];
}

interface CloudStudioState {
  activeEnv: EnvironmentId;
  environments: Record<EnvironmentId, EnvironmentProfile>;
  targetLocalEmulator: boolean;

  nodes: CloudNode[];
  edges: CloudEdge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;

  // Undo / Redo History
  past: HistorySnapshot[];
  future: HistorySnapshot[];

  // UI Panels & Modals
  rightTab: RightDrawerTab;
  isTemplateModalOpen: boolean;
  isImportModalOpen: boolean;
  emulatorStatuses: Record<number, { running: boolean; status: string; caExists: boolean }>;

  // Live Terminal / Execution Output
  terminalLogs: string[];
  isRunningCommand: boolean;

  // Actions
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  setActiveEnv: (env: EnvironmentId) => void;
  updateEnvironmentProfile: (env: EnvironmentId, patch: Partial<EnvironmentProfile>) => void;
  setTargetLocalEmulator: (enabled: boolean) => void;

  onNodesChange: OnNodesChange<CloudNode>;
  onEdgesChange: OnEdgesChange<CloudEdge>;
  onConnect: OnConnect;

  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  setRightTab: (tab: RightDrawerTab) => void;
  setTemplateModalOpen: (open: boolean) => void;
  setImportModalOpen: (open: boolean) => void;

  addServiceNode: (serviceType: string, position?: { x: number; y: number }) => void;
  duplicateNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  deleteEdge: (edgeId: string) => void;
  deleteSelectedElements: () => void;

  updateNodeMetadata: (
    nodeId: string,
    patch: { label?: string; resourceName?: string; notes?: string; inlineCode?: string }
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
  importTerraformHcl: (hclText: string) => number;
  exportProjectJson: () => string;
  importProjectJson: (jsonText: string) => boolean;
  clearCanvas: () => void;
  autoLayoutCanvas: () => void;

  refreshEmulatorStatuses: () => Promise<void>;
  syncTerraformToDisk: () => Promise<{ ok: boolean; writtenFiles?: string[] }>;
  controlEmulatorContainer: (action: 'start' | 'stop', envId?: EnvironmentId) => Promise<void>;
  runTerraformCommand: (
    command: 'init' | 'validate' | 'plan' | 'apply' | 'destroy',
    envId?: EnvironmentId
  ) => Promise<void>;
  appendTerminalLog: (msg: string) => void;
  clearTerminalLogs: () => void;
}

const initialTemplate = ARCHITECTURE_TEMPLATES[0];
const ENV_ORDER: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

export const useCloudStore = create<CloudStudioState>()(
  persist(
    (set, get) => ({
      activeEnv: 'dev',
      environments: { ...DEFAULT_ENVIRONMENTS },
      targetLocalEmulator: true,

      nodes: initialTemplate.nodes,
      edges: initialTemplate.edges,
      selectedNodeId: initialTemplate.nodes[2]?.id || null,
      selectedEdgeId: null,

      past: [],
      future: [],

      rightTab: 'inspector',
      isTemplateModalOpen: false,
      isImportModalOpen: false,
      emulatorStatuses: {
        9297: { running: false, status: 'unchecked', caExists: false },
        9298: { running: false, status: 'unchecked', caExists: false },
        9299: { running: false, status: 'unchecked', caExists: false },
        9300: { running: false, status: 'unchecked', caExists: false },
      },

      terminalLogs: [
        '✨ LocalCloud Studio ready. Multi-environment compiler online (dev:9297, testing:9298, staging:9299, prod:9300).',
      ],
      isRunningCommand: false,

      pushHistory: () => {
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

      setTargetLocalEmulator: (enabled) => set({ targetLocalEmulator: enabled }),

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

      setRightTab: (tab) => set({ rightTab: tab }),
      setTemplateModalOpen: (open) => set({ isTemplateModalOpen: open }),
      setImportModalOpen: (open) => set({ isImportModalOpen: open }),

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
          type: 'awsNode',
          position: defaultPos,
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

        set((state) => ({
          nodes: [...state.nodes, newNode],
          selectedNodeId: newId,
          selectedEdgeId: null,
          rightTab: 'inspector',
        }));
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
          nodes: [...state.nodes.map((n) => ({ ...n, selected: false })), copyNode],
          selectedNodeId: newId,
        }));
      },

      deleteNode: (nodeId) => {
        get().pushHistory();
        set((state) => ({
          nodes: state.nodes.filter((n) => n.id !== nodeId),
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
        const { selectedNodeId, selectedEdgeId } = get();
        if (selectedNodeId) {
          get().deleteNode(selectedNodeId);
        } else if (selectedEdgeId) {
          get().deleteEdge(selectedEdgeId);
        }
      },

      updateNodeMetadata: (nodeId, patch) => {
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
        const clonedNodes = structuredClone(tpl.nodes);
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
        const { nodes, edges, importedCount } = parseTerraformHclToCanvas(hclText);
        if (importedCount > 0) {
          get().pushHistory();
          set({
            nodes,
            edges,
            selectedNodeId: nodes[0]?.id || null,
            selectedEdgeId: null,
            isImportModalOpen: false,
          });
        }
        return importedCount;
      },

      exportProjectJson: () => {
        const { nodes, edges, environments, activeEnv, targetLocalEmulator } = get();
        return JSON.stringify(
          {
            version: '2.0.0',
            exportedAt: new Date().toISOString(),
            activeEnv,
            targetLocalEmulator,
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
            nodes: parsed.nodes,
            edges: parsed.edges,
            environments: parsed.environments || get().environments,
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
        const nodes = get().nodes;
        const categoryOrder: Record<string, number> = {
          'Networking & Content Delivery': 0,
          'Security, Identity, & Compliance': 1,
          Compute: 2,
          Containers: 2,
          'Application Integration': 3,
          Database: 4,
          Storage: 4,
          'Analytics & Streaming': 3,
          'Developer Tools & AI': 3,
          'Management & Governance': 4,
        };

        const columns: Record<number, CloudNode[]> = {};
        for (const node of nodes) {
          const svc = SERVICE_BY_TYPE[node.data.serviceType];
          const col = svc ? (categoryOrder[svc.category] ?? 2) : 2;
          if (!columns[col]) columns[col] = [];
          columns[col].push(node);
        }

        const updatedNodes: CloudNode[] = [];
        Object.entries(columns).forEach(([colStr, colNodes]) => {
          const colIdx = Number(colStr);
          colNodes.forEach((n, rowIdx) => {
            updatedNodes.push({
              ...n,
              position: {
                x: 80 + colIdx * 340,
                y: 70 + rowIdx * 200,
              },
            });
          });
        });

        set({ nodes: updatedNodes });
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
        const { nodes, edges, environments, targetLocalEmulator, appendTerminalLog } = get();
        const files: Record<string, string> = {};
        const lambdaArtifacts: {
          envId: EnvironmentId;
          resourceName: string;
          runtime: string;
          code?: string;
        }[] = [];

        for (const envId of ENV_ORDER) {
          const profile = environments[envId];
          const compiled = compileTerraformForEnvironment(
            nodes,
            edges,
            profile,
            environments,
            targetLocalEmulator
          );
          files[`environments/${envId}/main.tf`] = compiled.mainTf;
          files[`environments/${envId}/provider.tf`] = compiled.providerTf;
          files[`environments/${envId}/variables.tf`] = compiled.variablesTf;
          files[`environments/${envId}/${envId}.tfvars`] = compiled.tfvars;
          files[`environments/${envId}/outputs.tf`] = compiled.outputsTf;
          files[`environments/${envId}/run-emulator-${envId}.sh`] = compiled.emulatorScriptSh;

          if (envId === 'dev') {
            files['Dockerfile.emulator'] = compiled.dockerfile;
            files['docker-compose.emulator.yml'] = compiled.dockerComposeYml;
          }

          for (const n of nodes) {
            if (n.data.serviceType === 'aws_lambda_function' && n.data.envEnabled?.[envId] !== false) {
              const resName = (n.data.resourceName || n.data.label)
                .toLowerCase()
                .replace(/[^a-z0-9_]/g, '_');
              lambdaArtifacts.push({
                envId,
                resourceName: resName,
                runtime: String(n.data.baseConfig?.runtime || 'nodejs20.x'),
                code: n.data.inlineCode,
              });
            }
          }
        }

        try {
          const res = await fetch('/api/terraform/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files, lambdaArtifacts }),
          });
          const data = await res.json();
          if (data.ok) {
            appendTerminalLog(
              `✅ Synced ${data.writtenFiles?.length || 0} Terraform & Lambda zip artifacts to ./terraform-out`
            );
            return { ok: true, writtenFiles: data.writtenFiles };
          }
          return { ok: false };
        } catch {
          return { ok: false };
        }
      },

      controlEmulatorContainer: async (action, targetEnvId) => {
        const envId = targetEnvId || get().activeEnv;
        const profile = get().environments[envId];
        const { appendTerminalLog, refreshEmulatorStatuses } = get();

        set({ isRunningCommand: true });
        appendTerminalLog(
          `🐳 [${envId.toUpperCase()}] ${action === 'start' ? 'Starting' : 'Stopping'} aws-emulator container on port ${profile.emulatorPort}...`
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
              `✅ [${envId.toUpperCase()}] Container ${action} succeeded:\n${data.output || 'Ready'}`
            );
          } else {
            appendTerminalLog(
              `⚠️ [${envId.toUpperCase()}] Container ${action} note: ${data.error || ''}\n${data.output || ''}`
            );
          }
          await refreshEmulatorStatuses();
        } catch (err: any) {
          appendTerminalLog(`❌ [${envId.toUpperCase()}] Failed: ${err?.message}`);
        } finally {
          set({ isRunningCommand: false });
        }
      },

      runTerraformCommand: async (command, targetEnvId) => {
        const envId = targetEnvId || get().activeEnv;
        const profile = get().environments[envId];
        const { syncTerraformToDisk, appendTerminalLog } = get();

        set({ isRunningCommand: true });

        // Mark active nodes as planning/provisioning on canvas
        const interimState: ProvisioningState =
          command === 'apply' ? 'provisioning' : command === 'plan' ? 'planning' : 'unapplied';

        set((state) => ({
          nodes: state.nodes.map((n) =>
            n.data.envEnabled?.[envId] !== false
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    provisioningStatus: {
                      ...(n.data.provisioningStatus || {}),
                      [envId]: interimState,
                    },
                  },
                }
              : n
          ),
        }));

        await syncTerraformToDisk();
        appendTerminalLog(
          `🚀 [${envId.toUpperCase()}] Running 'terraform ${command}' in ./terraform-out/environments/${envId} (Endpoint: https://127.0.0.1:${profile.emulatorPort})...`
        );

        try {
          const res = await fetch('/api/terraform/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              command,
              envId,
              port: profile.emulatorPort,
              region: profile.region,
            }),
          });
          const data = await res.json();

          if (data.output) {
            appendTerminalLog(data.output);
          }

          const finalState: ProvisioningState = data.ok
            ? command === 'apply'
              ? 'provisioned'
              : command === 'destroy'
              ? 'unapplied'
              : 'provisioned'
            : 'failed';

          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.data.envEnabled?.[envId] !== false
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      provisioningStatus: {
                        ...(n.data.provisioningStatus || {}),
                        [envId]: finalState,
                      },
                    },
                  }
                : n
            ),
          }));

          if (data.ok) {
            appendTerminalLog(`✅ [${envId.toUpperCase()}] terraform ${command} completed successfully.`);
          } else {
            appendTerminalLog(
              `⚠️ [${envId.toUpperCase()}] terraform ${command} exited with code ${data.code ?? 1}.`
            );
          }
        } catch (err: any) {
          appendTerminalLog(`❌ [${envId.toUpperCase()}] Error: ${err?.message}`);
        } finally {
          set({ isRunningCommand: false });
        }
      },

      appendTerminalLog: (msg) =>
        set((state) => ({
          terminalLogs: [...state.terminalLogs.slice(-60), `[${new Date().toLocaleTimeString()}] ${msg}`],
        })),

      clearTerminalLogs: () => set({ terminalLogs: [] }),
    }),
    {
      name: 'localcloud-studio-storage-v2',
      partialize: (state) => ({
        activeEnv: state.activeEnv,
        environments: state.environments,
        targetLocalEmulator: state.targetLocalEmulator,
        nodes: state.nodes,
        edges: state.edges,
      }),
    }
  )
);
