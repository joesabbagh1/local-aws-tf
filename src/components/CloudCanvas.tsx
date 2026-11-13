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
import { CARD_WIDTH } from '../utils/canvasLayout';
import type { CloudNode, CloudEdge } from '../types/cloud';
import { Button } from './ui';
import { PlanReviewBar } from './PlanReviewBar';

const EDGE_COLORS: Record<string, string> = {
  event_trigger: '#D4945A',
  iam_grant: '#7FAE7A',
  target_route: '#6E94B0',
  network_attachment: '#8E8CD8',
  data_flow: '#5A6166',
  depends_on: '#5A6166',
};

const EDGE_LEGEND = [
  { rel: 'event_trigger', label: 'Trigger' },
  { rel: 'iam_grant', label: 'Access' },
  { rel: 'target_route', label: 'Route' },
  { rel: 'network_attachment', label: 'Network' },
  { rel: 'data_flow', label: 'Data' },
];

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
          x: event.clientX - CARD_WIDTH / 2,
          y: event.clientY - 24,
        });
        addServiceNode(serviceType, position);
      } else {
        addServiceNode(serviceType);
      }
    },
    [addServiceNode]
  );

  // Edge colour encodes the relationship; selection uses the accent
  const styledEdges: CloudEdge[] = edges.map((edge): CloudEdge => {
    const rel = edge.data?.relationshipType || 'data_flow';
    const stroke = edge.selected ? '#E8C400' : EDGE_COLORS[rel] || EDGE_COLORS.data_flow;

    return {
      ...edge,
      // Solid lines read calmer; only the selected connection animates
      animated: !!edge.selected,
      label: edge.data?.label || rel,
      labelStyle: {
        fill: '#9CA1A4',
        fontSize: 10,
        fontFamily: '"IBM Plex Mono", monospace',
      },
      labelBgStyle: {
        fill: '#101214',
        fillOpacity: 1,
      },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      style: {
        stroke,
        strokeWidth: edge.selected ? 2 : 1.5,
      },
    };
  });

  return (
    <div ref={reactFlowWrapper} className="flex-1 h-full relative bg-base overflow-hidden">
      {/* Edge legend */}
      <div className="absolute bottom-[18px] left-14 z-10 pointer-events-none hidden xl:flex items-center gap-4 text-[11px] text-fg-faint">
        {EDGE_LEGEND.map(({ rel, label }) => (
          <span key={rel} className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: EDGE_COLORS[rel] }} />
            {label}
          </span>
        ))}
      </div>

      <PlanReviewBar />

      {/* Empty canvas */}
      {nodes.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto max-w-sm text-center">
            <h2 className="text-[15px] font-medium text-fg">Empty canvas</h2>
            <p className="text-[13px] text-fg-muted mt-1.5 leading-relaxed">
              Drag a service from the left, or start from a blueprint. Terraform for every environment
              updates as you build.
            </p>
            <div className="flex items-center justify-center gap-2 mt-5">
              <Button variant="primary" size="md" onClick={() => setTemplateModalOpen(true)}>
                Browse blueprints
              </Button>
              <Button
                size="md"
                onClick={() => addServiceNode('aws_lambda_function', { x: 350, y: 220 })}
              >
                Add a Lambda
              </Button>
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
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'smoothstep',
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2C3135" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) =>
            node.type === 'awsContainer' ? '#1E2124' : SERVICE_BY_TYPE[String(node.data?.serviceType || '')]?.color || '#6E7478'
          }
          nodeStrokeColor={(node) => (node.type === 'awsContainer' ? '#454B50' : 'transparent')}
          nodeBorderRadius={2}
          maskColor="rgba(16, 18, 20, 0.7)"
          style={{ width: 168, height: 112 }}
        />
      </ReactFlow>
    </div>
  );
}
