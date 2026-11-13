import type { Node, Edge } from '@xyflow/react';

export type EnvironmentId = 'dev' | 'testing' | 'staging' | 'prod';

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
  defaultTags: Record<string, string>;
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
  emulatorSupportLevel: 'full' | 'high' | 'partial';
  isContainer?: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  schema: SchemaField[];
  outputs: { name: string; tfExpression: (resName: string) => string; description: string }[];
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

export interface CostBreakdownItem {
  nodeId: string;
  label: string;
  serviceType: string;
  monthlyUsd: Record<EnvironmentId, number>;
  sizingNotes: Record<EnvironmentId, string>;
}
