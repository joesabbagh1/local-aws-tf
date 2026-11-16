import type { CloudNode, EnvironmentId, EnvironmentProfile } from '../types/cloud';
import { DEFAULT_ENVIRONMENTS } from '../data/awsCatalog';

/**
 * Environments are a project setting: the four defaults, plus any the project adds or minus any it
 * removes. Everything that used to iterate a fixed list reads `envIdsOf(environments)` instead; the
 * record's key order is the display and compile order.
 */

/**
 * An id is written into directory names, the `lc-<env>` resource name prefix and container names,
 * so it must be DNS-safe and short enough to leave room in 32-character AWS names.
 */
export const ENV_ID_PATTERN = /^[a-z](?:[a-z0-9-]{0,14}[a-z0-9])?$/;

/** Colours for environments the app has no fixed colour for, in the palette's muted register. */
const EXTRA_ENV_COLORS = ['#B07A9E', '#8FA65F', '#7F8FC9', '#C7A85A', '#6FAFC0', '#C98A8A'];

const FIRST_EMULATOR_PORT = 9297;

export function envIdsOf(environments: Record<EnvironmentId, unknown> | undefined | null): EnvironmentId[] {
  return Object.keys(environments || {});
}

/** How an environment is written in tight spaces (tabs, table headers). */
export function envLabel(id: EnvironmentId): string {
  return id === 'testing' ? 'test' : id;
}

/** Production environments get the stricter audit checks; the others get the cost-saving suggestions. */
export function isProductionEnv(env: Pick<EnvironmentProfile, 'id' | 'production'> | undefined | null): boolean {
  if (!env) return false;
  return typeof env.production === 'boolean' ? env.production : env.id === 'prod';
}

/** Why `id` can't be used for a new environment, or null when it can. */
export function validateEnvId(id: string, existing: EnvironmentId[]): string | null {
  if (!ENV_ID_PATTERN.test(id)) {
    return 'Use 1–16 lowercase letters, digits or hyphens, starting with a letter (it goes into resource names).';
  }
  if (existing.includes(id)) return `An environment named ${id} already exists.`;
  return null;
}

export function nextEmulatorPort(environments: Record<EnvironmentId, Pick<EnvironmentProfile, 'emulatorPort'>>): number {
  const used = new Set(Object.values(environments).map((e) => Number(e.emulatorPort)));
  // Skip the four default ports even when their environment was removed, so re-adding it can't collide
  for (const env of Object.values(DEFAULT_ENVIRONMENTS)) used.add(env.emulatorPort);
  let port = FIRST_EMULATOR_PORT;
  while (used.has(port)) port++;
  return port;
}

function genericProfile(id: EnvironmentId, port: number): EnvironmentProfile {
  return {
    id,
    name: id.length <= 3 ? id.toUpperCase() : id.charAt(0).toUpperCase() + id.slice(1),
    shortLabel: id.toUpperCase().slice(0, 6),
    color: EXTRA_ENV_COLORS[0],
    badgeClass: '',
    region: 'us-east-1',
    accountId: '000000000000',
    emulatorPort: port,
    emulatorEndpoint: `https://127.0.0.1:${port}`,
    emulatorTelemetry: false,
    emulatorAuth: true,
    instanceSizingMultiplier: 1,
    enableHighAvailability: false,
    defaultTags: { Environment: id, ManagedBy: 'LocalCloudStudio', EmulatorPort: String(port) },
    usage: { ...DEFAULT_ENVIRONMENTS.dev.usage },
  };
}

/**
 * The environments a project actually has, from whatever was saved. A document with no usable
 * environments (a design started headlessly, an old file) gets the four defaults; otherwise the
 * saved keys are the whole list, so a removed default stays removed. Saved values win over the
 * app's defaults, except colours, which are presentation and always come from the app.
 */
export function resolveEnvironments(saved: unknown): Record<EnvironmentId, EnvironmentProfile> {
  const entries =
    saved && typeof saved === 'object'
      ? Object.entries(saved as Record<string, unknown>).filter(
          ([id, value]) => ENV_ID_PATTERN.test(id) && !!value && typeof value === 'object'
        )
      : [];
  if (entries.length === 0) return structuredClone(DEFAULT_ENVIRONMENTS);

  const out: Record<EnvironmentId, EnvironmentProfile> = {};
  let customIndex = 0;
  for (const [id, value] of entries) {
    const builtin = DEFAULT_ENVIRONMENTS[id];
    const savedProfile = value as Partial<EnvironmentProfile>;
    const port = Number(savedProfile.emulatorPort) || builtin?.emulatorPort || nextEmulatorPort(out);
    const base = builtin ?? genericProfile(id, port);
    out[id] = {
      ...base,
      ...savedProfile,
      id,
      emulatorPort: port,
      emulatorEndpoint: savedProfile.emulatorEndpoint || `https://127.0.0.1:${port}`,
      defaultTags: { ...base.defaultTags, ...(savedProfile.defaultTags || {}) },
      usage: { ...base.usage, ...(savedProfile.usage || {}) },
      color: builtin?.color ?? EXTRA_ENV_COLORS[customIndex++ % EXTRA_ENV_COLORS.length],
      badgeClass: builtin?.badgeClass ?? '',
    };
  }
  return out;
}

export interface EnvironmentDesign {
  nodes: CloudNode[];
  environments: Record<EnvironmentId, EnvironmentProfile>;
}

/**
 * Adds an environment. `copyFrom` starts it as a copy of another one: its region, usage and
 * production flag, and every resource's overrides and on/off switch for that environment.
 * Without it the new environment deploys every resource with base values.
 */
export function addEnvironment(
  design: EnvironmentDesign,
  id: EnvironmentId,
  options: { name?: string; copyFrom?: EnvironmentId; region?: string } = {}
): EnvironmentDesign {
  const source = options.copyFrom ? design.environments[options.copyFrom] : undefined;
  const port = nextEmulatorPort(design.environments);
  const generic = genericProfile(id, port);
  const profile: EnvironmentProfile = {
    ...generic,
    ...(source
      ? {
          region: source.region,
          accountId: source.accountId,
          instanceSizingMultiplier: source.instanceSizingMultiplier,
          enableHighAvailability: source.enableHighAvailability,
          production: isProductionEnv(source) || undefined,
          usage: { ...source.usage },
        }
      : {}),
    ...(options.region ? { region: options.region } : {}),
    name: options.name?.trim() || generic.name,
  };

  // Re-resolving gives the new environment its colour and keeps every profile in one shape
  const environments = resolveEnvironments({ ...design.environments, [id]: profile });
  const nodes = source
    ? design.nodes.map((node) => {
        const overrides = node.data.envOverrides?.[source.id];
        const enabled = node.data.envEnabled?.[source.id];
        if (!overrides && enabled === undefined) return node;
        return {
          ...node,
          data: {
            ...node.data,
            envOverrides: overrides
              ? { ...node.data.envOverrides, [id]: structuredClone(overrides) }
              : node.data.envOverrides,
            envEnabled: enabled === undefined ? node.data.envEnabled : { ...node.data.envEnabled, [id]: enabled },
          },
        };
      })
    : design.nodes;
  return { environments, nodes };
}

/** Removes an environment and everything resources stored for it. The last one can't be removed. */
export function removeEnvironment(design: EnvironmentDesign, id: EnvironmentId): EnvironmentDesign {
  if (!design.environments[id] || envIdsOf(design.environments).length <= 1) return design;
  const { [id]: _removed, ...rest } = design.environments;
  const dropKey = <T,>(record: Record<string, T> | undefined): Record<string, T> | undefined => {
    if (!record || !(id in record)) return record;
    const { [id]: _drop, ...kept } = record;
    return kept;
  };
  const nodes = design.nodes.map((node) => {
    const data = node.data;
    if (
      !(data.envOverrides && id in data.envOverrides) &&
      !(data.envEnabled && id in data.envEnabled) &&
      !(data.provisioningStatus && id in data.provisioningStatus) &&
      !(data.provisionedOutputs && id in data.provisionedOutputs)
    ) {
      return node;
    }
    return {
      ...node,
      data: {
        ...data,
        envOverrides: dropKey(data.envOverrides) ?? {},
        envEnabled: dropKey(data.envEnabled) ?? {},
        provisioningStatus: dropKey(data.provisioningStatus),
        provisionedOutputs: dropKey(data.provisionedOutputs),
      },
    };
  });
  return { environments: resolveEnvironments(rest), nodes };
}
