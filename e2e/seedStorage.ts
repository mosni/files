// Shared fixture-seeding for the e2e tier's storage volume.
//
// Five specs write bytes straight into the `e2e-storage` volume (there is no live IdP in this sandbox to
// drive a real upload for every case, so a fixture is a row in mariadb plus its bytes on disk). That
// volume is ALSO written by app-e2e itself for the specs that DO drive a real upload, and both land in the
// same directory: a fixture's disk_dir is "2026/08" in several specs, and controllers/upload.ts's
// currentDiskDir() is the real "<YYYY>/<mm>" - the same string for any run during that month.
//
// Today both write as root, so ownership is not a problem. This exists because review 060/SEC-2 briefly
// moved app-e2e to `USER node` (uid 1000) and that made it one immediately: whichever process created the
// directory owned it, root-first meant the app's own rename() into it failed with EACCES, and it surfaced
// as a 500 on the completing tus PATCH across five specs - but ONLY in a full parallel run, because
// running upload-flow alone let the app create the directory itself. That change is currently backed out
// (see the Dockerfile), and this is kept deliberately: it is correct either way, costs nothing, and is the
// piece the e2e tier needs ready before non-root can be tried again.
//
// Seeding therefore widens the directory rather than assuming ownership. chmod is idempotent and works
// whichever process got there first, and it is scoped to a throwaway test volume - the production storage
// root is untouched by any of this.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Ensure `dir` exists and stays writable by every uid that shares this volume. */
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
