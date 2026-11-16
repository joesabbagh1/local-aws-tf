import type { Node, Edge } from '@xyflow/react';

/**
 * An environment's id: `dev`, `testing`, `staging` and `prod` by default, plus any the project adds
 * (see utils/environments.ts). It is written into paths and resource names, so it is DNS-safe.
 */
export type EnvironmentId = string;

export interface EnvironmentProfile {
  id: EnvironmentId;
  name: string;
  shortLabel: string;
  color: string;
  badgeClass: string;
  region: string;
  accountId: string;
  emulatorPort: number;
  emulatorEndpoint: string;
  emulatorTelemetry: boolean;
  emulatorAuth: boolean;
  instanceSizingMultiplier: number;
  enableHighAvailability: boolean;
  /** Stricter audit checks, and no "cheaper outside production" suggestions. Defaults to true for `prod` only. */
  production?: boolean;
  defaultTags: Record<string, string>;
  /** Traffic and data volumes the cost estimate assumes for this environment. */
  usage: UsageProfile;
}

export interface UsageProfile {
  /** Requests reaching the app per month, in millions. Every request-driven service sees the full volume. */
  requestsMillions: number;
  /** Data served to the internet per month, GB. */
  dataTransferGb: number;
  /** Data held by each storage service, GB. */
  storageGb: number;
  /** Log data ingested per month across all log groups, GB. */
  logsGb: number;
}

export type AwsCategory =
  | 'Networking & Content Delivery'
  | 'Compute'
  | 'Containers'
  | 'Storage'
  | 'Database'
  | 'Application Integration'
  | 'Security, Identity, & Compliance'
  | 'Management & Governance'
  | 'Analytics & Streaming'
  | 'Developer Tools & AI';

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'json'
  | 'keyvalue'
  | 'list'
  | 'cidr'
  | 'code';

export interface SchemaField {
  key: string;
  label: string;
  type: FieldType;
  defaultValue: any;
  description?: string;
  options?: { label: string; value: string }[];
  placeholder?: string;
  group?: 'general' | 'networking' | 'security' | 'scaling' | 'advanced';
  envConfigurable?: boolean;
}

export interface AwsServiceMetadata {
  typeId: string;
  serviceCode: string;
  name: string;
  shortName: string;
  category: AwsCategory;
  color: string;
  iconName: string;
  description: string;
  terraformResourceType: string;
  isContainer?: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  schema: SchemaField[];
  outputs: { name: string; tfExpression: (resName: string) => string; description: string }[];
  /**
   * Why new designs shouldn't use this service, and what to use instead. Deprecated services are
   * hidden from the catalog and can't be added, but existing designs and imports still compile.
   */
  deprecated?: string;
}

export type ProvisioningState = 'unapplied' | 'planning' | 'provisioning' | 'provisioned' | 'failed';

export interface CloudNodeData extends Record<string, unknown> {
  label: string;
  resourceName: string;
  serviceType: string;
  baseConfig: Record<string, any>;
  envOverrides: Partial<Record<EnvironmentId, Record<string, any>>>;
  envEnabled: Record<EnvironmentId, boolean>;
  tags: Record<string, string>;
  notes?: string;
  // Inline code for Lambda functions or EC2 user_data
  inlineCode?: string;
  /** Lambda only: folder (relative to the project) zipped instead of inlineCode, dependencies included. */
  sourceDir?: string;
  // Legacy explicit VPC membership; nesting now uses React Flow parentId
  parentVpcId?: string;
  // Live provisioning status per environment
  provisioningStatus?: Partial<Record<EnvironmentId, ProvisioningState>>;
  provisionedOutputs?: Partial<Record<EnvironmentId, Record<string, string>>>;
}

export type CloudNode = Node<CloudNodeData, 'awsNode' | 'awsContainer'>;

export interface CloudEdgeData extends Record<string, unknown> {
  relationshipType:
    | 'depends_on'
    | 'network_attachment'
    | 'iam_grant'
    | 'event_trigger'
    | 'target_route'
    | 'data_flow';
  label?: string;
  iamActions?: string[];
  port?: number;
  protocol?: string;
}

export type CloudEdge = Edge<CloudEdgeData>;

export interface ArchitectureTemplate {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  badge: string;
  nodes: CloudNode[];
  edges: CloudEdge[];
}

export interface LintFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: 'Security' | 'Reliability' | 'Networking' | 'Cost' | 'Emulator';
  title: string;
  description: string;
  nodeId?: string;
  envId?: EnvironmentId;
  remediation?: string;
}

/** What a dollar is spent on: capacity that runs by the hour, data at rest, calls, bytes out, flat fees. */
export type CostDriver = 'compute' | 'storage' | 'requests' | 'transfer' | 'fees';

export interface CostBreakdownItem {
  nodeId: string;
  label: string;
  serviceType: string;
  category: AwsCategory;
  monthlyUsd: Record<EnvironmentId, number>;
  drivers: Record<EnvironmentId, Record<CostDriver, number>>;
  sizingNotes: Record<EnvironmentId, string>;
}

export interface CostSaving {
  id: string;
  nodeId: string;
  envId: EnvironmentId;
  title: string;
  detail: string;
  monthlyUsd: number;
}
