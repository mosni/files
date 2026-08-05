#!/usr/bin/env node
// E6 Wave G2: rasterizes web/public/icon.svg (D-179) into the PNG sizes the PWA manifest (G3) references.
// Runs as `prebuild`, automatically before `npm run build` (including inside the Docker build) - so the
// generated PNGs never need to be committed, only the source SVG does.
//
// sharp is already a runtime dependency (D-78, built from source against system libvips) - no new package.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_SVG = path.join(rootDir, "web/public/icon.svg");
const OUT_DIR = path.join(rootDir, "web/public/icons");

const TARGETS = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  // G1's background is already full-bleed, so the maskable variant is the SAME art at 512 - a circular
  // crop of it keeps every mark inside the central 80% G1 was drawn to.
  { file: "icon-maskable-512.png", size: 512 },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const { file, size } of TARGETS) {
    await sharp(SOURCE_SVG).resize(size, size).png().toFile(path.join(OUT_DIR, file));
    console.log(`generated ${path.relative(rootDir, path.join(OUT_DIR, file))} (${size}x${size})`);
  }
}

main().catch((err) => {
  console.error("generate-icons: failed -", err);
  process.exitCode = 1;
});
