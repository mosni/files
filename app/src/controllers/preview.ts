// Preview logic for files.mosni.dev (preliminary-review P2). D-9: server-rendered so messenger crawlers
// (which do not run JavaScript) get a real OG unfurl. Session-aware island hydration (old D-41/D-63) was
// dropped in session 007 - E5a ships no island, so the probe was speculative build-ahead; E5 adds
// hydration when a real island exists.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { buildFileUrls } from "../lib/fileUrls.ts";
import { readablePathResolves } from "../lib/protection.ts";
import { resolveByPath, resolveByToken, type FileRecord } from "../storage/files.ts";
import { renderPreviewPage } from "../views/Preview.tsx";

function render(reply: FastifyReply, config: Config, record: FileRecord): void {
  const urls = buildFileUrls(config, record.protection, record.path, record.linkToken);
  reply.type("text/html; charset=utf-8").send(renderPreviewPage(record, urls));
}

export async function previewByPath(
  _request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  relPath: string,
): Promise<void> {
  const record = await resolveByPath(relPath);
  // `secret` must 404 at its readable path, not 403 - same rule as delivery (D-59).
  if (record === null || !readablePathResolves(record.protection)) {
    reply.code(404).send();
    return;
  }
  render(reply, config, record);
}

export async function previewByToken(
  _request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  token: string,
): Promise<void> {
  const record = await resolveByToken(token);
  if (record === null) {
    reply.code(404).send();
    return;
  }
  render(reply, config, record);
}
