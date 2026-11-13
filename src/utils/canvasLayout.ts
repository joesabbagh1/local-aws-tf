import type { CloudNode } from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';

export const CARD_WIDTH = 264;
export const CARD_HEIGHT = 170;

const CONTAINER_RANK: Record<string, number> = {
  aws_vpc: 0,
  aws_subnet: 1,
};

export function isContainerNode(node: CloudNode): boolean {
  return Boolean(SERVICE_BY_TYPE[node.data.serviceType]?.isContainer);
}

export function getNodeSize(node: CloudNode): { width: number; height: number } {
  const svc = SERVICE_BY_TYPE[node.data.serviceType];
  if (svc?.isContainer) {
    return {
      width: node.width ?? node.measured?.width ?? svc.defaultWidth ?? 420,
      height: node.height ?? node.measured?.height ?? svc.defaultHeight ?? 280,
    };
  }
  return {
    width: node.measured?.width ?? CARD_WIDTH,
    height: node.measured?.height ?? CARD_HEIGHT,
  };
}

export function getAbsolutePosition(
  node: CloudNode,
  nodeById: Record<string, CloudNode>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodeById[parentId];
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

/** Walks the parentId chain and returns the nearest enclosing node of the given service type. */
export function findAncestorOfType(
  node: CloudNode,
  serviceType: string,
  nodeById: Record<string, CloudNode>
): CloudNode | undefined {
  let parentId = node.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodeById[parentId];
    if (!parent) return undefined;
    if (parent.data.serviceType === serviceType) return parent;
    parentId = parent.parentId;
  }
  return undefined;
}

/** Which container types a node may be dropped into. VPCs are top-level; subnets live in VPCs. */
function canNestInside(child: CloudNode, container: CloudNode): boolean {
  const childType = child.data.serviceType;
  const containerType = container.data.serviceType;
  if (childType === 'aws_vpc') return false;
  if (childType === 'aws_subnet') return containerType === 'aws_vpc';
  return containerType === 'aws_vpc' || containerType === 'aws_subnet';
}

/**
 * Finds the innermost container whose bounds contain the node's center,
 * ignoring the node itself and its own descendants.
 */
export function findDropContainer(node: CloudNode, nodes: CloudNode[]): CloudNode | undefined {
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const abs = getAbsolutePosition(node, nodeById);
  const size = getNodeSize(node);
  const cx = abs.x + size.width / 2;
  const cy = abs.y + size.height / 2;

  let best: CloudNode | undefined;
  let bestArea = Infinity;
  for (const candidate of nodes) {
    if (candidate.id === node.id || !isContainerNode(candidate)) continue;
    if (!canNestInside(node, candidate)) continue;
    if (isDescendantOf(candidate, node.id, nodeById)) continue;

    const cAbs = getAbsolutePosition(candidate, nodeById);
    const cSize = getNodeSize(candidate);
    const inside =
      cx >= cAbs.x && cx <= cAbs.x + cSize.width && cy >= cAbs.y && cy <= cAbs.y + cSize.height;
    const area = cSize.width * cSize.height;
    if (inside && area < bestArea) {
      best = candidate;
      bestArea = area;
    }
  }
  return best;
}

function isDescendantOf(
  node: CloudNode,
  ancestorId: string,
  nodeById: Record<string, CloudNode>
): boolean {
  let parentId = node.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = nodeById[parentId]?.parentId;
  }
  return false;
}

/**
 * React Flow requires parents to precede their children in the nodes array.
 * VPCs can only be top-level and subnets only nest in VPCs, so ranking
 * VPC → Subnet → everything else satisfies that ordering.
 */
function sortParentsFirst(nodes: CloudNode[]): CloudNode[] {
  return nodes
    .map((n, i) => ({ n, i, rank: CONTAINER_RANK[n.data.serviceType] ?? 2 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ n }) => n);
}

/**
 * Brings nodes from any source (templates, imports, older saves) into canvas shape:
 * containers get the group node type and a fixed size, dangling parents are dropped,
 * and parents are ordered before children.
 */
export function normalizeNodes(nodes: CloudNode[]): CloudNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const normalized = nodes.map((node): CloudNode => {
    const svc = SERVICE_BY_TYPE[node.data.serviceType];
    let next = node;

    if (next.parentId && !ids.has(next.parentId)) {
      const { parentId: _drop, ...rest } = next;
      next = { ...rest, position: getAbsolutePosition(node, nodeById) };
    }

    if (svc?.isContainer) {
      next = {
        ...next,
        type: 'awsContainer' as CloudNode['type'],
        width: next.width ?? svc.defaultWidth ?? 420,
        height: next.height ?? svc.defaultHeight ?? 280,
      };
    } else if (next.type !== 'awsNode') {
      next = { ...next, type: 'awsNode' };
    }
    return next;
  });

  return sortParentsFirst(normalized);
}

/** Moves a node into (or out of) a container, keeping its on-screen position. */
export function reparentNode(
  nodes: CloudNode[],
  nodeId: string,
  newParentId: string | undefined
): CloudNode[] {
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const node = nodeById[nodeId];
  if (!node || node.parentId === newParentId) return nodes;

  const abs = getAbsolutePosition(node, nodeById);
  const parentAbs = newParentId
    ? getAbsolutePosition(nodeById[newParentId], nodeById)
    : { x: 0, y: 0 };

  const updated = nodes.map((n): CloudNode => {
    if (n.id !== nodeId) return n;
    const { parentId: _old, ...rest } = n;
    return {
      ...rest,
      ...(newParentId ? { parentId: newParentId } : {}),
      position: { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y },
    };
  });
  return sortParentsFirst(updated);
}

/** Lifts a container's direct children to its own parent before the container is removed. */
export function releaseChildren(nodes: CloudNode[], containerId: string): CloudNode[] {
  const container = nodes.find((n) => n.id === containerId);
  if (!container) return nodes;
  return nodes.map((n): CloudNode => {
    if (n.parentId !== containerId) return n;
    const { parentId: _old, ...rest } = n;
    return {
      ...rest,
      ...(container.parentId ? { parentId: container.parentId } : {}),
      position: {
        x: n.position.x + container.position.x,
        y: n.position.y + container.position.y,
      },
    };
  });
}

const LAYOUT_COLUMN: Record<string, number> = {
  'Networking & Content Delivery': 0,
  'Security, Identity, & Compliance': 1,
  Compute: 2,
  Containers: 2,
  'Application Integration': 3,
  'Analytics & Streaming': 3,
  'Developer Tools & AI': 3,
  Database: 4,
  Storage: 4,
  'Management & Governance': 4,
};

const GAP = 40;
const CONTAINER_PAD_X = 24;
const CONTAINER_PAD_TOP = 60;
const CONTAINER_PAD_BOTTOM = 24;
const CONTAINER_COLUMNS = 2;

/**
 * Arranges the canvas: top-level nodes in category columns, and each container's
 * children in a grid inside it, growing the container to fit (innermost first).
 */
export function autoLayoutNodes(nodes: CloudNode[]): CloudNode[] {
  const childrenOf: Record<string, CloudNode[]> = {};
  for (const n of nodes) {
    if (n.parentId) (childrenOf[n.parentId] ||= []).push(n);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  const sizes: Record<string, { width: number; height: number }> = {};

  const measure = (node: CloudNode): { width: number; height: number } => {
    if (sizes[node.id]) return sizes[node.id];
    const base = getNodeSize(node);
    const kids = childrenOf[node.id] || [];
    if (!isContainerNode(node) || kids.length === 0) return (sizes[node.id] = base);

    // Containers (subnets) first so they span the top rows of a VPC
    const ordered = [...kids].sort(
      (a, b) => Number(isContainerNode(b)) - Number(isContainerNode(a))
    );
    let y = CONTAINER_PAD_TOP;
    let contentWidth = 0;
    for (let i = 0; i < ordered.length; i += CONTAINER_COLUMNS) {
      const row = ordered.slice(i, i + CONTAINER_COLUMNS);
      let x = CONTAINER_PAD_X;
      let rowHeight = 0;
      for (const kid of row) {
        const kidSize = measure(kid);
        positions[kid.id] = { x, y };
        x += kidSize.width + CONTAINER_PAD_X;
        rowHeight = Math.max(rowHeight, kidSize.height);
      }
      contentWidth = Math.max(contentWidth, x);
      y += rowHeight + CONTAINER_PAD_X;
    }
    return (sizes[node.id] = {
      width: Math.max(base.width, contentWidth),
      height: Math.max(base.height, y - CONTAINER_PAD_X + CONTAINER_PAD_BOTTOM),
    });
  };

  const columns: Record<number, CloudNode[]> = {};
  for (const node of nodes) {
    if (node.parentId) continue;
    const svc = SERVICE_BY_TYPE[node.data.serviceType];
    const col = svc ? (LAYOUT_COLUMN[svc.category] ?? 2) : 2;
    (columns[col] ||= []).push(node);
  }

  let colX = 80;
  for (const col of Object.keys(columns).map(Number).sort((a, b) => a - b)) {
    let rowY = 70;
    let colWidth = 0;
    for (const n of columns[col]) {
      const size = measure(n);
      positions[n.id] = { x: colX, y: rowY };
      rowY += size.height + GAP;
      colWidth = Math.max(colWidth, size.width);
    }
    colX += colWidth + GAP * 2;
  }

  return nodes.map((n) => {
    const next: CloudNode = positions[n.id] ? { ...n, position: positions[n.id] } : n;
    return isContainerNode(n) && sizes[n.id] ? { ...next, ...sizes[n.id] } : next;
  });
}
