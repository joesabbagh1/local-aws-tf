import React, { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCloudStore } from '../store/useCloudStore';
import { AwsNodeCard } from './AwsNodeCard';
import { AwsContainerNode } from './AwsContainerNode';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import type { CloudNode, CloudEdge } from '../types/cloud';
import { Sparkles, PlusCircle, Terminal } from 'lucide-react';

const nodeTypes = {
  awsNode: AwsNodeCard,
  awsContainer: AwsContainerNode,
};

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  );
}

export function CloudCanvas() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance<CloudNode, CloudEdge> | null>(null);

  const nodes = useCloudStore((s) => s.nodes);
  const edges = useCloudStore((s) => s.edges);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const onNodesChange = useCloudStore((s) => s.onNodesChange);
  const onEdgesChange = useCloudStore((s) => s.onEdgesChange);
  const onConnect = useCloudStore((s) => s.onConnect);
  const selectNode = useCloudStore((s) => s.selectNode);
  const selectEdge = useCloudStore((s) => s.selectEdge);
  const addServiceNode = useCloudStore((s) => s.addServiceNode);
  const setTemplateModalOpen = useCloudStore((s) => s.setTemplateModalOpen);
  const onNodeDragStart = useCloudStore((s) => s.onNodeDragStart);
  const onNodeDragStop = useCloudStore((s) => s.onNodeDragStop);

  // Canvas keyboard shortcuts (ignored while typing in inspector fields)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const store = useCloudStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        store.redo();
      } else if (mod && key === 'd') {
        e.preventDefault();
        if (store.selectedNodeId) store.duplicateNode(store.selectedNodeId);
      } else if (!mod && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault();
        store.deleteSelectedElements();
      } else if (e.key === 'Escape') {
        store.selectNode(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const activeEnvProfile = environments[activeEnv];

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const serviceType = event.dataTransfer.getData('application/localcloud-service');
      if (!serviceType) return;

      if (rfInstance.current) {
        const position = rfInstance.current.screenToFlowPosition({
          x: event.clientX - 130,
          y: event.clientY - 30,
        });
        addServiceNode(serviceType, position);
      } else {
        addServiceNode(serviceType);
      }
    },
    [addServiceNode]
  );

  // Style edges with clean relationship colors & labels
  const styledEdges: CloudEdge[] = edges.map((edge): CloudEdge => {
    const rel = edge.data?.relationshipType || 'data_flow';
    let stroke = '#64748b';
    if (rel === 'event_trigger') stroke = '#f97316';
    if (rel === 'iam_grant') stroke = '#10b981';
    if (rel === 'network_attachment') stroke = '#8b5cf6';
    if (rel === 'target_route') stroke = '#38bdf8';

    return {
      ...edge,
      label: edge.data?.label || rel,
      labelStyle: {
        fill: '#cbd5e1',
        fontSize: 10,
        fontFamily: 'JetBrains Mono, monospace',
        fontWeight: 500,
      },
      labelBgStyle: {
        fill: '#0d1017',
        fillOpacity: 0.9,
        stroke: '#1e2433',
        strokeWidth: 1,
      },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 6,
      style: {
        stroke,
        strokeWidth: edge.selected ? 3 : 2,
      },
    };
  });

  return (
    <div
      ref={reactFlowWrapper}
      className="flex-1 h-full relative bg-[#090b10] overflow-hidden"
    >
      {/* Top Floating Environment Status Pill on Canvas */}
      <div className="absolute top-3 left-3 z-10 pointer-events-none flex items-center gap-2">
        <div className="px-3 py-1.5 rounded-xl bg-[#11141d]/90 backdrop-blur-md border border-slate-800/90 shadow-lg flex items-center gap-2.5">
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{
              backgroundColor: activeEnvProfile.color,
              boxShadow: `0 0 10px ${activeEnvProfile.color}`,
            }}
          />
          <div className="text-[11px]">
            <span className="font-semibold text-white">
              {activeEnvProfile.name}
            </span>
            <span className="text-slate-400 mx-1.5">•</span>
            <span className="font-mono text-slate-300">
              {activeEnvProfile.region}
            </span>
            <span className="text-slate-400 mx-1.5">•</span>
            <span className="font-mono text-orange-400">
              {activeEnvProfile.emulatorEndpoint}
            </span>
          </div>
        </div>

        <div className="px-2.5 py-1.5 rounded-xl bg-[#11141d]/85 backdrop-blur-md border border-slate-800/80 text-[11px] text-slate-400 hidden xl:flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="w-2 h-0.5 bg-orange-500 inline-block" /> Event Trigger
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-0.5 bg-emerald-500 inline-block" /> IAM / Data
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-0.5 bg-sky-400 inline-block" /> Route / Origin
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-0.5 bg-violet-500 inline-block" /> VPC Network
          </span>
        </div>
      </div>

      {/* Empty Canvas Onboarding Overlay */}
      {nodes.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto max-w-md w-full p-6 rounded-2xl bg-[#11141d]/95 border border-slate-800 shadow-2xl text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-orange-500/15 border border-orange-500/30 flex items-center justify-center mx-auto text-orange-400">
              <PlusCircle className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                Design Your Local AWS Architecture
              </h2>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                Drag and drop any AWS service from the left palette onto this 2D canvas, wire connections between handles, and watch your multi-environment Terraform compile in real time.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setTemplateModalOpen(true)}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-orange-500 hover:bg-orange-400 text-slate-950 flex items-center gap-1.5 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Load Starter Blueprint
              </button>
              <button
                type="button"
                onClick={() => addServiceNode('aws_lambda_function', { x: 350, y: 220 })}
                className="px-3.5 py-2 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1.5 transition-colors"
              >
                <Terminal className="w-3.5 h-3.5" />
                Add Lambda Node
              </button>
            </div>
          </div>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={(_e, _node, dragged) => onNodeDragStop(dragged.map((n) => n.id))}
        deleteKeyCode={null}
        onInit={(instance) => {
          rfInstance.current = instance;
        }}
        onNodeClick={(_e, node) => selectNode(node.id)}
        onEdgeClick={(_e, edge) => selectEdge(edge.id)}
        onPaneClick={() => {
          selectNode(null);
          selectEdge(null);
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'smoothstep',
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.3}
          color="#1e293b"
        />
        <Controls position="bottom-left" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            const svc = SERVICE_BY_TYPE[String(node.data?.serviceType || '')];
            return svc?.color || '#f97316';
          }}
          maskColor="rgba(9, 11, 16, 0.75)"
        />
      </ReactFlow>
    </div>
  );
}
