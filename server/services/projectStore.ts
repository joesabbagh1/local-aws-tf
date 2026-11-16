import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Sql } from '../db';
import type { ProjectFile } from '../../src/utils/projectFile';

/**
 * Project persistence: rows in Postgres are the system of record, `localcloud.json` in each
 * project's working dir is the materialized, git-committable export. The backend is the file's
 * only writer; external edits are detected by hash and folded back in as new versions.
 */

/** The design document's file name inside every project working dir. */
export const PROJECT_FILE = 'localcloud.json';

export interface ProjectRow {
  id: string;
  name: string;
  working_dir: string;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectSummary extends ProjectRow {
  version: number;
  actor: string | null;
}

export interface VersionMeta {
  version: number;
  summary: string | null;
  actor: string;
  doc_hash: string;
  created_at: Date;
}

export type SaveResult =
  | { ok: true; version: number; noop: boolean }
  | { ok: false; conflict: true; currentVersion: number; doc: ProjectFile };

/** Canonical serialization used for both the materialized file and the version hash. */
export function canonicalDocJson(doc: ProjectFile): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

function docHash(doc: ProjectFile): string {
  return crypto.createHash('sha256').update(canonicalDocJson(doc)).digest('hex');
}

/** Accept anything shaped like a project document; the UI compiler trusts the same fields. */
export function isValidDoc(value: unknown): value is ProjectFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.nodes) && Array.isArray(v.edges) && !!v.environments && typeof v.environments === 'object';
}

/** Open (idempotent by working dir) or create a project; the working dir is created if missing. */
export async function ensureProject(
  sql: Sql,
  input: { workingDir: string; name?: string }
): Promise<ProjectRow> {
  const workingDir = path.resolve(input.workingDir);
  fs.mkdirSync(workingDir, { recursive: true });
  const name = (input.name || path.basename(workingDir) || 'project').trim() || 'project';
  const [row] = await sql`
    INSERT INTO projects (name, working_dir) VALUES (${name}, ${workingDir})
    ON CONFLICT (working_dir) DO UPDATE SET name = EXCLUDED.name
    RETURNING id, name, working_dir, created_at, updated_at
  `;
  return row as ProjectRow;
}

export async function listProjects(sql: Sql): Promise<ProjectSummary[]> {
  const rows = await sql`
    SELECT p.id, p.name, p.working_dir, p.created_at, p.updated_at,
           v.version, v.actor
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT version, actor FROM project_versions
      WHERE project_id = p.id ORDER BY version DESC LIMIT 1
    ) v ON true
    ORDER BY p.updated_at DESC
  `;
  return (rows as unknown as Record<string, any>[]).map((r) => ({
    ...r,
    version: Number(r.version ?? 0),
    actor: r.actor ?? null,
  })) as ProjectSummary[];
}

export async function getProject(sql: Sql, id: string): Promise<ProjectRow | null> {
  const [row] = await sql`SELECT id, name, working_dir, created_at, updated_at FROM projects WHERE id = ${id}`;
  return (row as ProjectRow) ?? null;
}

export async function renameProject(sql: Sql, id: string, name: string): Promise<ProjectRow | null> {
  const [row] = await sql`
    UPDATE projects SET name = ${name}, updated_at = now() WHERE id = ${id}
    RETURNING id, name, working_dir, created_at, updated_at
  `;
  return (row as ProjectRow) ?? null;
}

export async function deleteProject(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM projects WHERE id = ${id}`;
  return rows.count > 0;
}

interface HeadInfo {
  version: number;
  doc: ProjectFile;
  doc_hash: string;
  actor: string;
  summary: string | null;
  created_at: Date;
}

/** postgres.js hands jsonb back as a string when it was written via an explicit ::jsonb cast. */
function parseDocColumn(value: unknown): ProjectFile {
  return (typeof value === 'string' ? JSON.parse(value) : value) as ProjectFile;
}

async function headRow(exec: Sql, projectId: string): Promise<HeadInfo | null> {
  const [row] = await exec`
    SELECT version, doc, doc_hash, actor, summary, created_at FROM project_versions
    WHERE project_id = ${projectId} ORDER BY version DESC LIMIT 1
  `;
  if (!row) return null;
  const r = row as unknown as Record<string, unknown>;
  return {
    version: Number(r.version),
    doc: parseDocColumn(r.doc),
    doc_hash: String(r.doc_hash),
    actor: String(r.actor),
    summary: (r.summary as string | null) ?? null,
    created_at: r.created_at as Date,
  };
}

export async function getHead(sql: Sql, projectId: string) {
  return headRow(sql, projectId);
}

/**
 * Fold an externally changed localcloud.json (git pull, hand edit) back into history as a new
 * version. Format-only changes (whitespace, key order) re-serialize to the same hash and are
 * ignored; content changes become an 'import' version so the previous design is never lost.
 */
export async function reconcileFile(sql: Sql, project: ProjectRow): Promise<number> {
  const filePath = path.join(project.working_dir, PROJECT_FILE);
  if (!fs.existsSync(filePath)) return 0;
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return 0; // a broken file is reported by the read path, never silently replaced
  }
  if (!isValidDoc(doc)) return 0;
  const head = await headRow(sql, project.id);
  if (head && head.doc_hash === docHash(doc)) return head.version;
  if (!head) {
    // First open of a folder that already has a design: adopt it as version 1
    const saved = await saveDoc(sql, project.id, doc, { baseVersion: 0, actor: 'import', summary: 'adopted localcloud.json' });
    return saved.ok ? saved.version : saved.currentVersion;
  }
  const saved = await saveDoc(sql, project.id, doc, {
    baseVersion: head.version,
    actor: 'import',
    summary: 'localcloud.json changed externally',
  });
  return saved.ok ? saved.version : saved.currentVersion;
}

/**
 * Save a new version with optimistic concurrency: baseVersion must equal the current head, else
 * the caller gets a conflict carrying the winning doc. No-op saves (same content as head) return
 * the head version without inserting a row.
 */
export async function saveDoc(
  sql: Sql,
  projectId: string,
  doc: ProjectFile,
  opts: { baseVersion: number; actor: string; summary?: string }
): Promise<SaveResult> {
  const project = await getProject(sql, projectId);
  if (!project) throw new Error('Project not found');

  return sql.begin(async (tx) => {
    // Row lock makes the head check + insert atomic across concurrent writers
    await tx`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
    const head = await headRow(tx as unknown as Sql, projectId);
    const headVersion = head?.version ?? 0;
    if (headVersion !== opts.baseVersion) {
      return {
        ok: false as const,
        conflict: true as const,
        currentVersion: headVersion,
        doc: head ? head.doc : (doc as ProjectFile),
      };
    }

    const hash = docHash(doc);
    if (head && head.doc_hash === hash) {
      return { ok: true as const, version: headVersion, noop: true };
    }

    const version = opts.baseVersion + 1;
    // Autosaves carry no summary; describe the change so history reads as a list of edits
    const summary = opts.summary ?? (head ? summarizeDiff(diffDocs(head.doc, doc)) : 'Started the design');
    await tx`
      INSERT INTO project_versions (project_id, version, doc, doc_hash, summary, actor, parent_version)
      VALUES (${projectId}, ${version}, ${JSON.stringify(doc)}::jsonb, ${hash}, ${summary}, ${opts.actor}, ${opts.baseVersion})
    `;
    await tx`UPDATE projects SET updated_at = now() WHERE id = ${projectId}`;

    // The file is the export of the head version; write it inside the transaction's critical
    // section so a crash never leaves the file ahead of or behind the DB.
    fs.mkdirSync(project.working_dir, { recursive: true });
    const filePath = path.join(project.working_dir, PROJECT_FILE);
    fs.writeFileSync(filePath + '.tmp', canonicalDocJson(doc));
    fs.renameSync(filePath + '.tmp', filePath);

    // The audit trail skips UI autosaves (versions already record them) but keeps every other actor.
    if (opts.actor !== 'ui') {
      await tx`
        INSERT INTO events (project_id, actor, action, payload, doc_version)
        VALUES (${projectId}, ${opts.actor}, 'doc.save', ${JSON.stringify({ summary })}::jsonb, ${version})
      `;
    }
    return { ok: true as const, version, noop: false };
  });
}

export async function listVersions(sql: Sql, projectId: string, limit = 50): Promise<VersionMeta[]> {
  const rows = await sql`
    SELECT version, summary, actor, doc_hash, created_at FROM project_versions
    WHERE project_id = ${projectId} ORDER BY version DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, version: Number(r.version) }) as VersionMeta);
}

export async function getVersion(sql: Sql, projectId: string, version: number) {
  const [row] = await sql`
    SELECT version, doc, doc_hash, summary, actor, created_at FROM project_versions
    WHERE project_id = ${projectId} AND version = ${version}
  `;
  if (!row) return null;
  const r = row as unknown as Record<string, unknown>;
  return {
    version: Number(r.version),
    doc: parseDocColumn(r.doc),
    doc_hash: String(r.doc_hash),
    actor: String(r.actor),
    summary: (r.summary as string | null) ?? null,
    created_at: r.created_at as Date,
  };
}

/** Restore never rewrites history: it appends a copy of an old version as the new head. */
export async function restoreVersion(
  sql: Sql,
  projectId: string,
  version: number,
  actor: string
): Promise<SaveResult> {
  const old = await getVersion(sql, projectId, version);
  if (!old) throw new Error(`Version ${version} not found`);
  const head = await headRow(sql, projectId);
  return saveDoc(sql, projectId, old.doc, {
    baseVersion: head?.version ?? 0,
    actor,
    summary: `restored version ${version}`,
  });
}

/** One value that differs between two versions. `env` is set for a per-environment override or switch. */
export interface FieldChange {
  field: string;
  env?: string;
  from?: unknown;
  to?: unknown;
}

export interface EdgeBrief {
  id: string;
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  relationshipType?: string;
}

export interface ProjectDiff {
  nodes: {
    added: { id: string; label: string; serviceType: string }[];
    removed: { id: string; label: string; serviceType: string }[];
    /** `changes` names what kind of thing changed; `fields` lists each value, before and after. */
    changed: { id: string; label: string; serviceType: string; changes: string[]; fields: FieldChange[] }[];
  };
  edges: {
    added: EdgeBrief[];
    removed: EdgeBrief[];
    changed: (EdgeBrief & { changes: string[] })[];
  };
  /** Ids of environments that were added, removed or edited. */
  environments: string[];
  environmentChanges: { id: string; change: 'added' | 'removed' | 'changed'; fields: FieldChange[] }[];
  /** Names of scenarios that were added, removed or edited. */
  scenarios: { added: string[]; removed: string[]; changed: string[] };
}

function nodeBrief(node: ProjectFile['nodes'][number]) {
  return { id: node.id, label: String(node.data?.label ?? node.id), serviceType: String(node.data?.serviceType ?? '') };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Key-by-key differences between two flat records. */
function recordChanges(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, env?: string): FieldChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: FieldChange[] = [];
  for (const field of keys) {
    const from = before?.[field];
    const to = after?.[field];
    if (!same(from, to)) changes.push({ field, ...(env ? { env } : {}), from, to });
  }
  return changes;
}

/** Structural diff of two design docs, keyed by node/edge id. Pure. */
export function diffDocs(fromDoc: ProjectFile, toDoc: ProjectFile): ProjectDiff {
  const fromNodes = new Map(fromDoc.nodes.map((n) => [n.id, n]));
  const toNodes = new Map(toDoc.nodes.map((n) => [n.id, n]));
  const nodes = {
    added: [...toNodes.values()].filter((n) => !fromNodes.has(n.id)).map(nodeBrief),
    removed: [...fromNodes.values()].filter((n) => !toNodes.has(n.id)).map(nodeBrief),
    changed: [] as ProjectDiff['nodes']['changed'],
  };
  for (const n of toNodes.values()) {
    const before = fromNodes.get(n.id);
    if (!before) continue;
    const changes: string[] = [];
    const fields: FieldChange[] = [];

    const config = recordChanges(before.data?.baseConfig, n.data?.baseConfig);
    if (config.length) changes.push('baseConfig');
    fields.push(...config);

    const overrideEnvs = new Set([...Object.keys(before.data?.envOverrides ?? {}), ...Object.keys(n.data?.envOverrides ?? {})]);
    const overrides = [...overrideEnvs].flatMap((env) => recordChanges(before.data?.envOverrides?.[env], n.data?.envOverrides?.[env], env));
    if (overrides.length) changes.push('envOverrides');
    fields.push(...overrides);

    // A missing entry means "on", so compare what each side means rather than what it stores
    const enabledEnvs = new Set([...Object.keys(before.data?.envEnabled ?? {}), ...Object.keys(n.data?.envEnabled ?? {})]);
    const enabled = [...enabledEnvs]
      .filter((env) => (before.data?.envEnabled?.[env] !== false) !== (n.data?.envEnabled?.[env] !== false))
      .map((env) => ({ field: 'deployed', env, from: before.data?.envEnabled?.[env] !== false, to: n.data?.envEnabled?.[env] !== false }));
    if (enabled.length) changes.push('envEnabled');
    fields.push(...enabled);

    if (before.data?.label !== n.data?.label || before.data?.resourceName !== n.data?.resourceName) {
      changes.push('name');
      if (before.data?.label !== n.data?.label) fields.push({ field: 'name', from: before.data?.label, to: n.data?.label });
      if (before.data?.resourceName !== n.data?.resourceName) {
        fields.push({ field: 'resource id', from: before.data?.resourceName, to: n.data?.resourceName });
      }
    }
    if (before.parentId !== n.parentId) {
      changes.push('parent');
      const labelOf = (doc: ProjectFile, id?: string) => (id ? String(doc.nodes.find((x) => x.id === id)?.data?.label ?? id) : 'canvas');
      fields.push({ field: 'placed in', from: labelOf(fromDoc, before.parentId), to: labelOf(toDoc, n.parentId) });
    }
    if (before.data?.inlineCode !== n.data?.inlineCode || before.data?.sourceDir !== n.data?.sourceDir) {
      changes.push('code');
      // Code is long: say that it changed, and show the folder when that is what moved
      if (before.data?.sourceDir !== n.data?.sourceDir) fields.push({ field: 'code folder', from: before.data?.sourceDir, to: n.data?.sourceDir });
      else fields.push({ field: 'inline code' });
    }
    if (!same(before.data?.tags, n.data?.tags)) {
      changes.push('tags');
      fields.push(...recordChanges(before.data?.tags, n.data?.tags).map((c) => ({ ...c, field: `tag ${c.field}` })));
    }
    if (changes.length) nodes.changed.push({ ...nodeBrief(n), changes, fields });
  }

  const edgeBrief = (doc: ProjectFile, e: ProjectFile['edges'][number]): EdgeBrief => {
    const labelOf = (id: string) => String(doc.nodes.find((n) => n.id === id)?.data?.label ?? id);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceLabel: labelOf(e.source),
      targetLabel: labelOf(e.target),
      relationshipType: e.data?.relationshipType as string | undefined,
    };
  };
  const fromEdges = new Map(fromDoc.edges.map((e) => [e.id, e]));
  const toEdges = new Map(toDoc.edges.map((e) => [e.id, e]));
  const edges = {
    added: [...toEdges.values()].filter((e) => !fromEdges.has(e.id)).map((e) => edgeBrief(toDoc, e)),
    removed: [...fromEdges.values()].filter((e) => !toEdges.has(e.id)).map((e) => edgeBrief(fromDoc, e)),
    changed: [] as ProjectDiff['edges']['changed'],
  };
  for (const e of toEdges.values()) {
    const before = fromEdges.get(e.id);
    if (before && !same(before.data, e.data)) {
      const changes = recordChanges(before.data as Record<string, unknown>, e.data as Record<string, unknown>).map((c) => c.field);
      edges.changed.push({ ...edgeBrief(toDoc, e), changes: changes.length ? changes : ['data'] });
    }
  }

  const fromEnvs = (fromDoc.environments ?? {}) as Record<string, Record<string, unknown>>;
  const toEnvs = (toDoc.environments ?? {}) as Record<string, Record<string, unknown>>;
  const environmentChanges: ProjectDiff['environmentChanges'] = [];
  for (const id of new Set([...Object.keys(fromEnvs), ...Object.keys(toEnvs)])) {
    if (!fromEnvs[id]) environmentChanges.push({ id, change: 'added', fields: [] });
    else if (!toEnvs[id]) environmentChanges.push({ id, change: 'removed', fields: [] });
    else {
      const fields = recordChanges(fromEnvs[id], toEnvs[id]);
      if (fields.length) environmentChanges.push({ id, change: 'changed', fields });
    }
  }

  const fromScenarios = new Map((fromDoc.scenarios ?? []).map((sc) => [sc.id, sc]));
  const toScenarios = new Map((toDoc.scenarios ?? []).map((sc) => [sc.id, sc]));
  const scenarios = {
    added: [...toScenarios.values()].filter((sc) => !fromScenarios.has(sc.id)).map((sc) => sc.name),
    removed: [...fromScenarios.values()].filter((sc) => !toScenarios.has(sc.id)).map((sc) => sc.name),
    changed: [...toScenarios.values()].filter((sc) => fromScenarios.has(sc.id) && !same(fromScenarios.get(sc.id), sc)).map((sc) => sc.name),
  };

  return { nodes, edges, environments: environmentChanges.map((c) => c.id), environmentChanges, scenarios };
}

/**
 * One line saying what a change did, e.g. "Changed memory_size on Orders API" or "Added Jobs and
 * 2 more". Used as the summary of saves that don't bring their own (canvas autosaves).
 */
export function summarizeDiff(diff: ProjectDiff): string {
  const parts: string[] = [];
  const names = (labels: string[]) =>
    labels.length === 1 ? labels[0] : labels.length === 2 ? `${labels[0]} and ${labels[1]}` : `${labels[0]} and ${labels.length - 1} more`;

  if (diff.nodes.added.length) parts.push(`Added ${names(diff.nodes.added.map((n) => n.label))}`);
  if (diff.nodes.removed.length) parts.push(`Removed ${names(diff.nodes.removed.map((n) => n.label))}`);
  if (diff.nodes.changed.length === 1) {
    const [node] = diff.nodes.changed;
    const fields = [...new Set(node.fields.map((f) => f.field))];
    const renamed = node.fields.find((f) => f.field === 'name');
    if (renamed && fields.length <= 2) parts.push(`Renamed ${String(renamed.from)} to ${String(renamed.to)}`);
    else if (fields.length === 1) {
      const env = node.fields[0].env;
      parts.push(`Changed ${fields[0]} on ${node.label}${env && node.fields.every((f) => f.env === env) ? ` in ${env}` : ''}`);
    } else parts.push(`Edited ${node.label}`);
  } else if (diff.nodes.changed.length > 1) {
    parts.push(`Edited ${names(diff.nodes.changed.map((n) => n.label))}`);
  }
  if (diff.edges.added.length === 1) parts.push(`Connected ${diff.edges.added[0].sourceLabel} to ${diff.edges.added[0].targetLabel}`);
  else if (diff.edges.added.length > 1) parts.push(`Added ${diff.edges.added.length} connections`);
  if (diff.edges.removed.length === 1) parts.push(`Disconnected ${diff.edges.removed[0].sourceLabel} from ${diff.edges.removed[0].targetLabel}`);
  else if (diff.edges.removed.length > 1) parts.push(`Removed ${diff.edges.removed.length} connections`);
  if (diff.edges.changed.length) parts.push(`Edited ${diff.edges.changed.length === 1 ? 'a connection' : `${diff.edges.changed.length} connections`}`);
  for (const env of diff.environmentChanges) {
    parts.push(env.change === 'added' ? `Added environment ${env.id}` : env.change === 'removed' ? `Removed environment ${env.id}` : `Changed environment ${env.id}`);
  }
  if (diff.scenarios.added.length) parts.push(`Added scenario ${names(diff.scenarios.added)}`);
  if (diff.scenarios.removed.length) parts.push(`Removed scenario ${names(diff.scenarios.removed)}`);
  if (diff.scenarios.changed.length) parts.push(`Edited scenario ${names(diff.scenarios.changed)}`);

  if (parts.length === 0) return 'Rearranged the canvas';
  const line = parts.length > 2 ? `${parts.slice(0, 2).join('; ')}; and more` : parts.join('; ');
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
