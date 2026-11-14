/**
 * Schema migrations, applied in order by the migration runner in server/db.ts. Every entry is one
 * transaction; the runner records applied names in schema_migrations. SQL strings (not a builder)
 * so the applied file is exactly what is reviewed.
 */
export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: '0001_init',
    sql: `
      CREATE TABLE projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        working_dir TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE project_versions (
        id BIGSERIAL PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version BIGINT NOT NULL,
        doc JSONB NOT NULL,
        doc_hash TEXT NOT NULL,
        summary TEXT,
        actor TEXT NOT NULL,
        parent_version BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (project_id, version)
      );
      CREATE INDEX project_versions_project_idx ON project_versions (project_id, version DESC);

      CREATE TABLE runs (
        id BIGSERIAL PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        env TEXT NOT NULL,
        command TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT 'emulator',
        status TEXT NOT NULL,
        exit_code INTEGER,
        plan_json JSONB,
        plan_inputs_hash TEXT,
        doc_version BIGINT,
        log TEXT,
        actor TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ
      );
      CREATE INDEX runs_project_idx ON runs (project_id, id DESC);

      CREATE TABLE events (
        id BIGSERIAL PRIMARY KEY,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        payload JSONB,
        doc_version BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX events_project_idx ON events (project_id, id DESC);
    `,
  },
];
