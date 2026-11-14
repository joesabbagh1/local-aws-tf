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
    await tx`
      INSERT INTO project_versions (project_id, version, doc, doc_hash, summary, actor, parent_version)
      VALUES (${projectId}, ${version}, ${JSON.stringify(doc)}::jsonb, ${hash}, ${opts.summary ?? null}, ${opts.actor}, ${opts.baseVersion})
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
        VALUES (${projectId}, ${opts.actor}, 'doc.save', ${JSON.stringify({ summary: opts.summary ?? null })}::jsonb, ${version})
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

export interface ProjectDiff {
  nodes: {
    added: { id: string; label: string; serviceType: string }[];
    removed: { id: string; label: string; serviceType: string }[];
    changed: { id: string; label: string; changes: string[] }[];
  };
  edges: {
    added: { id: string; source: string; target: string; relationshipType?: string }[];
    removed: string[];
    changed: { id: string; changes: string[] }[];
  };
  environments: string[];
}

function nodeBrief(node: ProjectFile['nodes'][number]) {
  return { id: node.id, label: String(node.data?.label ?? node.id), serviceType: String(node.data?.serviceType ?? '') };
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
    if (JSON.stringify(before.data?.baseConfig) !== JSON.stringify(n.data?.baseConfig)) changes.push('baseConfig');
    if (JSON.stringify(before.data?.envOverrides) !== JSON.stringify(n.data?.envOverrides)) changes.push('envOverrides');
    if (JSON.stringify(before.data?.envEnabled) !== JSON.stringify(n.data?.envEnabled)) changes.push('envEnabled');
    if (before.data?.label !== n.data?.label || before.data?.resourceName !== n.data?.resourceName) changes.push('name');
    if (before.parentId !== n.parentId) changes.push('parent');
    if (before.data?.inlineCode !== n.data?.inlineCode || before.data?.sourceDir !== n.data?.sourceDir) changes.push('code');
    if (changes.length) nodes.changed.push({ ...nodeBrief(n), changes });
  }

  const fromEdges = new Map(fromDoc.edges.map((e) => [e.id, e]));
  const toEdges = new Map(toDoc.edges.map((e) => [e.id, e]));
  const edges = {
    added: [...toEdges.values()]
      .filter((e) => !fromEdges.has(e.id))
      .map((e) => ({ id: e.id, source: e.source, target: e.target, relationshipType: e.data?.relationshipType as string | undefined })),
    removed: [...fromEdges.keys()].filter((id) => !toEdges.has(id)),
    changed: [] as ProjectDiff['edges']['changed'],
  };
  for (const e of toEdges.values()) {
    const before = fromEdges.get(e.id);
    if (before && JSON.stringify(before.data) !== JSON.stringify(e.data)) {
      edges.changed.push({ id: e.id, changes: ['data'] });
    }
  }

  const environments = Object.keys(toDoc.environments ?? {}).filter((env) => {
    const a = (fromDoc.environments as Record<string, unknown> | undefined)?.[env];
    const b = (toDoc.environments as Record<string, unknown>)[env];
    return JSON.stringify(a) !== JSON.stringify(b);
  });

  return { nodes, edges, environments };
}
