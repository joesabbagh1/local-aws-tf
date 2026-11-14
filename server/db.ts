import postgres from 'postgres';
import { MIGRATIONS } from './db/migrations';

/**
 * Postgres access for the backend. One pooled connection per server process; every request path
 * goes through the same pool. Migrations run on first use (see ready()) so both `serve` and `dev`
 * start from a correct schema without a separate command.
 */
export type Sql = postgres.Sql<Record<string, never>>;

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    // Terraform runs and emulator control hold advisory locks for minutes, not hours
    idle_timeout: 60,
    connect_timeout: 10,
    max: 10,
    onnotice: () => {}, // INFO notices from CREATE IF NOT EXISTS etc. are noise
  });
}

/** Apply pending migrations once per process. Safe to call concurrently from many processes. */
export async function migrate(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO schema_migrations (name) VALUES (${migration.name})`;
    });
  }
}

/**
 * Run `fn` holding the advisory lock for one project + scope (e.g. "tf:dev"). Advisory locks are
 * the serializer between the UI and MCP clients: only one terraform run / emulator control per
 * project+env can execute at a time, process-wide and across processes.
 */
export async function withAdvisoryLock<T>(sql: Sql, key: string, fn: () => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    // pg_try_advisory_xact_lock: fail fast instead of queueing — a second caller gets busy,
    // which beats silently waiting minutes for a terraform run to finish.
    const [row] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
    if (!row?.locked) throw new BusyError(key);
    return fn();
  });
}

/** Thrown by withAdvisoryLock when the lock is already held; surfaces as HTTP 409 / MCP "busy". */
export class BusyError extends Error {
  constructor(key: string) {
    super(`Another operation holds the lock for ${key}`);
    this.name = 'BusyError';
  }
}

/** Lazy one-time init per server process: connect check + migrations before the first query. */
export class DbReady {
  private ready: Promise<void> | null = null;

  constructor(private readonly sql: Sql) {}

  once(): Promise<void> {
    this.ready ??= (async () => {
      await this.sql`SELECT 1`;
      await migrate(this.sql);
    })().catch((err) => {
      this.ready = null; // a failed init must be retried by the next request
      throw err;
    });
    return this.ready;
  }
}
