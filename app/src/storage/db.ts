import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";

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
  });
}

// Self-healing schema (technical-baseline.md §3, following ../auth's D-57 pattern): re-applies schema.sql
// on every boot. Idempotent (CREATE DATABASE / TABLE IF NOT EXISTS), so a no-op on an up-to-date DB and
// self-heals one that predates a table added later. Throws on failure - the caller (server.ts boot hook)
// wraps this in try/catch and treats it as non-fatal (D-32-style), so a schema hiccup degrades rather than
// blocks boot.
//
// Runs on a DEDICATED bootstrap connection with NO database preselected, NOT the runtime pool: schema.sql
// begins with `CREATE DATABASE ... ; USE files;`, and the pool selects `files` in its handshake so it
// cannot even connect if the database does not exist yet - the exact case CREATE DATABASE exists to fix.
// One connection (not the pool) so the `USE` persists across every following statement. Executes one
// statement at a time so `multipleStatements` stays off (parameterized-queries-only posture); safe because
// schema.sql never puts `--` or `;` inside a string literal.
export async function applySchema(): Promise<void> {
  if (connectionParams === undefined) {
    throw new Error("db: initDb() must be called before applySchema()");
  }
  // Resolved via fileURLToPath rather than `new URL("./schema.sql", import.meta.url)` passed straight to
  // readFileSync: under Vitest's jsdom environment, the global `URL` constructor is jsdom's polyfill, not
  // Node's own - an instance of it fails Node's internal "is this a real file:// URL" brand check inside
  // fs, throwing "The URL must be of scheme file" even though the string itself is a valid file URL.
  // fileURLToPath takes the plain string and never touches the shadowed global.
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");
  const raw = readFileSync(schemaPath, "utf8");
  const statements = raw
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  const conn = await mysql.createConnection({
    host: connectionParams.host,
    port: connectionParams.port,
    user: connectionParams.user,
    password: connectionParams.password,
    // database deliberately omitted - see the note above.
  });
  try {
    for (const statement of statements) {
      if (/^CREATE\s+DATABASE/i.test(statement)) {
        // Best-effort: an app user granted only `ON files.*` cannot create databases, and MariaDB checks
        // that privilege BEFORE `IF NOT EXISTS` short-circuits, so this errors even when `files` already
        // exists. Tolerate it - if the database is genuinely missing and uncreatable, the `USE` that
        // follows throws and surfaces the real provisioning gap rather than this masking it.
        try {
          await conn.query(statement);
        } catch (err) {
          const code = (err as { code?: string }).code ?? "unknown";
          console.warn(`applySchema: CREATE DATABASE skipped (${code}) - relying on it already existing`);
        }
      } else {
        await conn.query(statement);
      }
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
