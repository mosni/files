// Shared fixture-seeding for the e2e tier's storage volume.
//
// Five specs write bytes straight into the `e2e-storage` volume (there is no live IdP in this sandbox to
// drive a real upload for every case, so a fixture is a row in mariadb plus its bytes on disk). That
// volume is ALSO written by app-e2e itself for the specs that do drive a real upload - and since review
// 060/SEC-2 the two do so as DIFFERENT UIDS: the app runs as `node` (uid 1000), while verify-e2e runs as
// root in the Playwright image.
//
// That matters because both land in the SAME directory. A fixture's disk_dir is "2026/08" in several
// specs, and controllers/upload.ts's currentDiskDir() is the real "<YYYY>/<mm>" - the same string for any
// run during that month. Whichever writes first creates the directory and owns it. Root first means the
// app's own rename() into it fails with EACCES, which surfaces as a 500 on the completing tus PATCH:
// upload-flow, video-playback and share specs all failed exactly that way, and ONLY in a full parallel
// run, because running upload-flow alone let the app create the directory itself.
//
// So: seeding widens the directory rather than assuming ownership. chmod is idempotent and works whether
// root or the app got there first, and it is scoped to a throwaway test volume - the production storage
// root is 0755 and owned by uid 1000 outright (see the Dockerfile and README's deploy steps).

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Ensure `dir` exists and is writable by both root and uid 1000. */
export async function ensureSharedDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Every level, not just the leaf: "2026" is created by the same recursive mkdir and needs traversal
  // plus write for the month directory beneath it to be creatable by the other uid later.
  const parent = path.dirname(dir);
  if (parent !== dir) await chmod(parent, 0o777).catch(() => {});
  await chmod(dir, 0o777);
}

/** Write a fixture's bytes at `absPath`, creating its directory shared-writable first. */
export async function writeFixture(absPath: string, body: string | Buffer): Promise<void> {
  await ensureSharedDir(path.dirname(absPath));
  await writeFile(absPath, body);
}
