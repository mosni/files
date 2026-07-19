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

export function initDb(params: DbConnectionParams): void {
  pool = mysql.createPool({
    host: params.host,
    port: params.port,
    user: params.user,
    password: params.password,
    database: params.database,
  });
}

// Self-healing schema (technical-baseline.md §3, following ../auth's D-57 pattern): re-applies schema.sql
// on every boot. Idempotent (CREATE TABLE IF NOT EXISTS), so a no-op on an up-to-date DB and self-heals
// one that predates a table added later. Throws on failure - the caller (server.ts boot hook) wraps this
// in try/catch and treats it as non-fatal (D-32-style), so a schema hiccup degrades rather than blocks
// boot.
//
// Executes one statement at a time rather than as a single multi-statement query, so the pool never needs
// `multipleStatements` (parameterized-queries-only posture). Safe because schema.sql never puts `--` or
// `;` inside a string literal.
export async function applySchema(): Promise<void> {
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

  const db = getPool();
  for (const statement of statements) {
    await db.query(statement);
  }
}

export async function closeDb(): Promise<void> {
  if (pool === undefined) return;
  await pool.end();
  pool = undefined;
}

function getPool(): Pool {
  if (pool === undefined) {
    throw new Error("db: initDb() must be called before use");
  }
  return pool;
}
