/**
 * Emulator gaps the runner recovers from on its own, detected in Terraform's plain-text output.
 * Shared by the app's runner (server/api.ts) and the emulator test (scripts/apply-blueprints.ts),
 * so what the test records is what the app does.
 */

/** Terraform output split into one chunk per diagnostic. */
const diagnostics = (output: string) => output.split(/(?=Error: )/);

/**
 * aws/aws-emulator#46: the emulator stores a VPC security group's default egress rule without
 * ports, so the provider's request to remove it (ports 0-0) doesn't match, and Terraform marks the
 * (existing) group tainted. Returns the addresses of groups that failed only for that reason.
 */
export function securityGroupEgressQuirks(applyOutput: string): string[] {
  const addresses = new Set<string>();
  for (const chunk of diagnostics(applyOutput)) {
    if (!/^Error: revoking default IPv[46] egress rule for Security Group/.test(chunk)) continue;
    if (!/InvalidPermission\.NotFound/.test(chunk)) continue;
    const addr = /\bwith (aws_security_group\.[A-Za-z0-9_-]+)/.exec(chunk)?.[1];
    if (addr) addresses.add(addr);
  }
  return [...addresses];
}

export function isSecurityGroupEgressQuirk(message: string): boolean {
  return /revoking default IPv[46] egress rule for Security Group/.test(message) && /InvalidPermission\.NotFound/.test(message);
}

/**
 * Resources whose delete the emulator has not implemented (it answers 501 NotImplemented, e.g.
 * DeleteReplicationGroup, aws/aws-emulator#355). Nothing can delete them, so a destroy can only
 * drop them from state; restarting the emulator clears them. `id` is the resource's id, for
 * taking it back into state with `terraform import` if the design is applied again.
 */
export function unimplementedDeletes(output: string): { address: string; operation: string; id?: string }[] {
  return failedDeletes(output, (chunk) => /NotImplemented: operation (\w+) is scaffolded but not implemented/.exec(chunk)?.[1]).map(
    ({ address, detail, id }) => ({ address, operation: detail, id })
  );
}

/**
 * Resources whose delete failed because something still uses them (an ElastiCache subnet group
 * under a replication group the emulator can't delete, say). Only meaningful once a resource the
 * emulator can't delete was dropped from state: then nothing else can ever free them.
 */
export function blockedDeletes(output: string): { address: string; id?: string }[] {
  return failedDeletes(output, (chunk) => /\w*InUse\b|DependencyViolation|is currently in use|has dependencies/.exec(chunk)?.[0]).map(
    ({ address, id }) => ({ address, id })
  );
}

/**
 * Ids of resources a create failed on because they already exist ("creating ElastiCache Subnet
 * Group (lc-dev-sessions-subnets): ... AlreadyExists"). After a destroy dropped resources the
 * emulator couldn't delete, applying again meets them here.
 */
export function alreadyExisting(output: string): string[] {
  const ids = new Set<string>();
  for (const chunk of diagnostics(output)) {
    if (!/AlreadyExists|already exists/i.test(chunk)) continue;
    const id = /^Error: creating [^(:]*\(([^)]+)\)/.exec(chunk)?.[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Ids named by "Error: <verb> <Thing> (<id>)" diagnostics, e.g. "modifying ElastiCache Replication Group (lc-dev-sessions)". */
export function failedIds(output: string): string[] {
  const ids = new Set<string>();
  for (const chunk of diagnostics(output)) {
    const id = /^Error: \w+ [^(:]*\(([^)]+)\)/.exec(chunk)?.[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** "Error: deleting ..." diagnostics `match` recognises, with the resource address (and id) each one is about. */
function failedDeletes(output: string, match: (chunk: string) => string | undefined): { address: string; detail: string; id?: string }[] {
  const found = new Map<string, { detail: string; id?: string }>();
  for (const chunk of diagnostics(output)) {
    if (!/^Error: deleting /.test(chunk)) continue;
    const detail = match(chunk);
    if (!detail) continue;
    const address = /\bwith ((?:module\.[^\s,]+\.)?aws_[a-z0-9_]+\.[A-Za-z0-9_-]+(?:\[[^\]]*\])?)/.exec(chunk)?.[1] ?? addressById(output, chunk);
    if (address) found.set(address, { detail, id: deletedId(chunk) });
  }
  return [...found].map(([address, { detail, id }]) => ({ address, detail, ...(id ? { id } : {}) }));
}

const deletedId = (chunk: string) => /^Error: deleting [^(:]*\(([^)]+)\)/.exec(chunk)?.[1];

/**
 * Applying a saved plan prints diagnostics without the `with <address>` line. The error names the
 * resource's id instead ("deleting ElastiCache Replication Group (lc-dev-sessions): ..."), which
 * matches the "<address>: Destroying... [id=<id>]" progress line earlier in the output.
 */
function addressById(output: string, chunk: string): string | undefined {
  const id = deletedId(chunk);
  if (!id) return undefined;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^((?:module\\.[^\\s:]+\\.)?aws_[a-z0-9_]+\\.[^\\s:]+): Destroying\\.\\.\\. \\[id=${escaped}\\]`, 'm').exec(output)?.[1];
}

export function isBlockedDelete(message: string): boolean {
  return /deleting /.test(message) && /\w*InUse\b|DependencyViolation|is currently in use|has dependencies/.test(message);
}

export function isUnimplementedDelete(message: string): boolean {
  return /deleting /.test(message) && /NotImplemented: operation \w+ is scaffolded but not implemented/.test(message);
}
