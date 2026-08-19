import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { mintUniqueToken } from "../lib/tokens.ts";

export interface DbConnectionParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

let pool: Pool | undefined;
let connectionParams: DbConnectionParams | undefined;

export function initDb(params: DbConnectionParams): void {
  connectionParams = params;
  pool = mysql.createPool({
    host: params.host,
    port: params.port,
    user: params.user,
    password: params.password,
    database: params.database,
    // Review 060/OPS-4: pin BOTH halves of the date round-trip to UTC rather than leaving them on two
    // defaults that only happen to agree. mysql2 defaults to `timezone: 'local'`, i.e. the Node process's
    // zone, when serialising a JS Date into a DATETIME and when reading one back; MariaDB's own session
    // zone decides what NOW()/CURRENT_TIMESTAMP mean. Both are UTC in the shipped containers, so this was
    // correct - but `collection_acl.expires_at > NOW()` is an AUTHORIZATION decision (D-220/D-221), and a
    // TZ env var on either side would silently shift a grant's lifetime by hours in whichever direction
    // the drift ran. Pinned here, in SET time_zone below, and once more in the predicates themselves
    // (storage/aclPredicates.ts uses UTC_TIMESTAMP(), not NOW()).
    timezone: "Z",
  });
  // The write side is `timezone: "Z"` above; this is the read/compare side. Applied per connection because
  // the session zone is per connection and a pool opens them lazily over the process's lifetime.
  //
  // A numeric offset, never a named zone: named zones need MariaDB's timezone tables to have been loaded,
  // "+00:00" always resolves.
  //
  // The cast is deliberate and narrow. mysql2's promise pool re-emits this event's argument straight from
  // the underlying CALLBACK pool (lib/promise/inherit_events.js forwards the arguments untouched), so the
  // value here is a core callback-API connection even though the promise typings describe it as a promise
  // PoolConnection. Calling it through the shape it actually has is more honest than awaiting a promise
  // that does not exist.
  pool.on("connection", (connection) => {
    const core = connection as unknown as { query(sql: string, cb: (err: unknown) => void): void };
    core.query("SET time_zone = '+00:00'", (err) => {
      // Non-fatal: the authorization comparisons use UTC_TIMESTAMP() explicitly (storage/aclPredicates.ts)
      // and Date round-trips use `timezone: "Z"`, so a failure here only affects how a TIMESTAMP column
      // reads back for display.
      if (err) console.error("db: could not pin the session time zone to UTC", err);
    });
  });
}

function splitStatements(raw: string): string[] {
  return raw
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

// D-83: numbered migrations replace the additive-only self-healing schema.sql, which ran
// `CREATE TABLE IF NOT EXISTS` only and so could never alter a table already on the box - exactly what
// migration 002 (DROP + rebuild for the E3 shape) needs to do safely, once, and never again.
interface MigrationFile {
  version: number;
  path: string;
}

function migrationsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
}

// Filenames are "<version>-<slug>.sql"; the numeric prefix is the version, sorted ascending so migrations
// always apply in order regardless of directory listing order.
function loadMigrationFiles(): MigrationFile[] {
  const dir = migrationsDir();
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const match = /^(\d+)-/.exec(name);
      if (match === null) {
        throw new Error(`db: migration filename "${name}" has no leading numeric version`);
      }
      return { version: Number(match[1]), path: path.join(dir, name) };
    })
    .sort((a, b) => a.version - b.version);
}

// D-98: the token namespace is shared between collections and files, but each lives in its own table
// with its own unique index - so "is this token free" must check both. Used both by the migration 003
// backfill below and exported for storage/collections.ts's createCollection to reuse.
export async function isLinkTokenTaken(conn: mysql.Connection | Pool, token: string): Promise<boolean> {
  const [collectionRows] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM collections WHERE link_token = ? LIMIT 1",
    [token],
  );
  if (collectionRows.length > 0) return true;
  const [fileRows] = await conn.query<RowDataPacket[]>("SELECT 1 FROM files WHERE link_token = ? LIMIT 1", [
    token,
  ]);
  return fileRows.length > 0;
}

// Migration 003 (§1.1 of the E4 waves hand-off) adds `link_token VARCHAR(16) NOT NULL DEFAULT ''` to
// `collections`, but a unique index can't be created over a column where every existing row shares the
// same default value. Each pre-existing collection needs a freshly minted, cross-table-unique token
// FIRST - which needs mintUniqueToken()'s collision-retry, not expressible in the plain SQL migration
// file - and only then can the index go on. Runs on the same bootstrap connection the migration itself
// uses, so it sees the ADD COLUMN that just ran immediately before it.
export async function backfillCollectionLinkTokens(conn: mysql.Connection): Promise<void> {
  const [rows] = await conn.query<(RowDataPacket & { id: string })[]>(
    "SELECT id FROM collections WHERE link_token = ''",
  );
  for (const row of rows) {
    const token = await mintUniqueToken((candidate) => isLinkTokenTaken(conn, candidate));
    await conn.query("UPDATE collections SET link_token = ? WHERE id = ?", [token, row.id]);
  }
  // IF NOT EXISTS (MariaDB 10.5+) so this stays safe to call more than once - the real boot sequence only
  // ever calls it the one time schema_version gates migration 3 to, but the test suite's shared MariaDB
  // means a test can legitimately re-run the backfill directly against already-migrated rows.
  await conn.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_collection_link_token ON collections (link_token)");
}

async function runStatement(conn: mysql.Connection, statement: string): Promise<void> {
  if (/^CREATE\s+DATABASE/i.test(statement)) {
    // Best-effort: an app user granted only `ON files.*` cannot create databases, and MariaDB checks
    // that privilege BEFORE `IF NOT EXISTS` short-circuits, so this errors even when `files` already
    // exists. Tolerate it - if the database is genuinely missing and uncreatable, the `USE` that
    // follows throws and surfaces the real provisioning gap rather than this masking it.
    try {
      await conn.query(statement);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "unknown";
      console.warn(`applyMigrations: CREATE DATABASE skipped (${code}) - relying on it already existing`);
    }
  } else {
    await conn.query(statement);
  }
}

// Replaces the old self-healing applySchema() (D-83). Runs on a DEDICATED bootstrap connection with NO
// database preselected, NOT the runtime pool: migration 001 begins with `CREATE DATABASE ...; USE
// files;`, and the pool selects `files` in its handshake so it cannot even connect if the database does
// not exist yet - the exact case CREATE DATABASE exists to fix. One connection (not the pool) so the
// `USE` persists across every following statement, in every migration. Executes one statement at a time
// so `multipleStatements` stays off (parameterized-queries-only posture); safe because no migration file
// puts `--` or `;` inside a string literal.
//
// `schema_version` itself needs a selected database to live in, so this always runs an explicit
// `CREATE DATABASE IF NOT EXISTS` + `USE` against the configured database name FIRST, before anything
// else - migration 001 also happens to carry the same two statements verbatim (it is the historical
// schema.sql body), so on a fresh install they simply run twice; both are idempotent.
export async function applyMigrations(): Promise<void> {
  if (connectionParams === undefined) {
    throw new Error("db: initDb() must be called before applyMigrations()");
  }
  const dbName = connectionParams.database;
  const migrations = loadMigrationFiles();

  const conn = await mysql.createConnection({
    host: connectionParams.host,
    port: connectionParams.port,
    user: connectionParams.user,
    password: connectionParams.password,
    // database deliberately omitted - see the note above.
  });
  try {
    // Every test file that touches the DB calls initDb()+applyMigrations() in its own beforeAll, and the
    // suite runs many files concurrently against the same shared MariaDB (D-45) - the old additive-only
    // schema.sql was safe under that concurrency purely because every statement was CREATE ... IF NOT
    // EXISTS. schema_version bookkeeping is not: two callers can both see a migration as unapplied and
    // race to record it (a PRIMARY KEY collision on schema_version), and worse, migration 002's DROP
    // TABLE could re-fire against another test file's in-flight data. A server-wide advisory lock
    // (GET_LOCK, MariaDB/MySQL-specific, no schema needed) serializes the whole check-then-apply
    // sequence across every concurrent caller, in-process or not.
    const [lockRows] = await conn.query<(RowDataPacket & { acquired: number })[]>(
      "SELECT GET_LOCK('files_schema_migrations', 30) AS acquired",
    );
    if (lockRows[0]?.acquired !== 1) {
      throw new Error("db: applyMigrations() could not acquire the schema migration lock within 30s");
    }
    try {
      await runStatement(conn, `CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      await conn.query(`USE \`${dbName}\``);

      await conn.query(
        `CREATE TABLE IF NOT EXISTS schema_version (
          version INT NOT NULL,
          applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (version)
        )`,
      );
      const [rows] = await conn.query<(RowDataPacket & { version: number })[]>(
        "SELECT version FROM schema_version",
      );
      const applied = new Set(rows.map((row) => row.version));

      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        const statements = splitStatements(readFileSync(migration.path, "utf8"));
        for (const statement of statements) {
          await runStatement(conn, statement);
        }
        if (migration.version === 3) {
          await backfillCollectionLinkTokens(conn);
        }
        await conn.query("INSERT INTO schema_version (version) VALUES (?)", [migration.version]);
      }
    } finally {
      await conn.query("SELECT RELEASE_LOCK('files_schema_migrations')");
    }
  } finally {
    await conn.end();
  }
}

export async function closeDb(): Promise<void> {
  if (pool === undefined) return;
  await pool.end();
  pool = undefined;
}

// Exported so the rest of storage/ (files.ts, collections.ts) can run their own queries against the
// same pool - db.ts owns the connection lifecycle, but it is not the only module that queries MariaDB.
export function getPool(): Pool {
  if (pool === undefined) {
    throw new Error("db: initDb() must be called before use");
  }
  return pool;
}
