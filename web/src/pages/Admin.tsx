// E8 (D-217 … D-221): the admin panel - a Usage section and an Access section, reached from the
// header's admin-only icon button (web/src/lib/headerIdentity.tsx). Gate: isFilesAdmin (D-68), enforced
// server-side (controllers/admin.ts, 404 never 403). This page's own "not admin" render matches
// app/src/views/NotFound.tsx's copy verbatim - the cosmetic half of reveal-nothing, so a non-admin who
// navigates here directly sees nothing distinguishing it from a mistyped link.

import { useEffect, useState } from "react";
import { Modal, Panel } from "@mosni/react";
import { humanSize } from "../../../app/src/lib/previewContext.ts";
import { DISK_CRITICAL_FREE_BYTES, DISK_WARN_FREE_BYTES } from "../../../app/src/lib/diskUsage.ts";
import type { AdminGrantRow, AdminUsageResponse } from "../../../app/src/lib/adminContext.ts";
import { fetchGrants, fetchUsage, revokeGrant } from "../lib/admin.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";

type LoadState = "loading" | "not-admin" | "error" | "ready";

function formatDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${date} ${time}`;
}

// D-222: the same truncate-with-ellipsis-and-full-title treatment ShareDialog's two lists and
// PreviewCard's byline already give a raw sub - nothing here parses it (invariant 6), it is displayed
// exactly as granted.
const IDENTITY_TEXT: React.CSSProperties = {
  display: "inline-block",
  maxWidth: "16rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  verticalAlign: "bottom",
};

// The Access table carries TWO identity columns side by side (owner and grantee) plus a date pair, and at
// 1280px that is wide enough to push the Revoke button off the panel's edge - review session 059 added the
// owner column, looked at the screenshot, and found exactly that. A tighter cap here and non-wrapping
// timestamps buy the room back; `.table-scroll` still handles genuinely narrow viewports.
const ACCESS_IDENTITY_TEXT: React.CSSProperties = { ...IDENTITY_TEXT, maxWidth: "11rem" };
const TIMESTAMP_CELL: React.CSSProperties = { whiteSpace: "nowrap" };

function freeSpaceColor(freeBytes: number): string | undefined {
  if (freeBytes <= DISK_CRITICAL_FREE_BYTES) return "var(--color-danger, #c0392b)";
  if (freeBytes <= DISK_WARN_FREE_BYTES) return "var(--color-warning, #b8860b)";
  return undefined;
}

function UsageSection({ usage }: { usage: AdminUsageResponse }) {
  return (
    <Panel heading="Usage">
      {usage.volume === null ? (
        <p>Volume figures are unavailable right now.</p>
      ) : (
        <p>
          <strong style={{ color: freeSpaceColor(usage.volume.freeBytes) }}>{humanSize(usage.volume.freeBytes)} free</strong>
          {" of "}
          {humanSize(usage.volume.totalBytes)} ({humanSize(usage.volume.usedBytes)} used) on the storage volume.
        </p>
      )}
      <p>
        Tracked by the app: {humanSize(usage.tracked.bytes)} across {usage.tracked.fileCount} file
        {usage.tracked.fileCount === 1 ? "" : "s"}.
      </p>
      {/* Two numbers that disagree with no explanation is how this panel gets read as broken - this line
          names what the delta is, in words, rather than leaving it implicit.

          Review session 059 corrected what those words SAY. The volume is the box's own disk, shared with
          every other app on it (current-context.md: Foundry, dscan, tracks, auth, TeamSpeak and others),
          and `usedBytes` is total-minus-available, so it also counts the blocks reserved for root. The
          delta is therefore dominated by things that are not this app at all - listing only this app's own
          untracked bytes made a mostly-other-apps figure read as "the app has lost 900 GB of files". */}
      <p>
        {usage.untrackedBytes === null
          ? "Everything else on the volume: unknown (volume figures are unavailable)."
          : `Everything else on the volume: ${humanSize(usage.untrackedBytes)}. This disk is shared with the rest of the box, so most of that belongs to other apps; it also covers space reserved for root and this app's own untracked bytes (thumbnails, in-flight uploads, files left on disk before migration 002).`}
      </p>

      <h3>By owner</h3>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Owner</th>
              <th scope="col">Files</th>
              <th scope="col">Bytes</th>
            </tr>
          </thead>
          <tbody>
            {usage.byOwner.map((row) => (
              <tr key={row.ownerSub}>
                <td>
                  <span style={IDENTITY_TEXT} title={row.ownerSub}>{row.ownerSub}</span>
                </td>
                <td>{row.fileCount}</td>
                <td>{humanSize(row.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Top collections</h3>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Collection</th>
              <th scope="col">Owner</th>
              <th scope="col">Files</th>
              <th scope="col">Bytes</th>
            </tr>
          </thead>
          <tbody>
            {usage.topCollections.map((row) => (
              <tr key={row.collectionId}>
                <td>{row.name}</td>
                <td>
                  <span style={IDENTITY_TEXT} title={row.ownerSub}>{row.ownerSub}</span>
                </td>
                <td>{row.fileCount}</td>
                <td>{humanSize(row.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function AccessSection({
  grants,
  onRevoke,
}: {
  grants: AdminGrantRow[];
  onRevoke: (grant: AdminGrantRow) => void;
}) {
  return (
    <Panel heading="Access">
      {/* D-218's accepted consequence, stated plainly rather than implying completeness. */}
      <p>
        Lists accounts granted access. Files shared by link are not listed here — a link works for anyone
        who has it.
      </p>
      <div className="table-scroll">
        <table className="table interactive">
          <thead>
            <tr>
              <th scope="col">Object</th>
              {/* Review session 059: the owner is joined by listAllGrants and was on the wire from the
                  start, but the table dropped it - so two grants on two different files both called
                  "photo.jpg" rendered as indistinguishable rows, in the one panel whose entire job is
                  answering "who has access to what". */}
              <th scope="col">Owner</th>
              <th scope="col">Grantee</th>
              <th scope="col">Upload</th>
              <th scope="col">Granted</th>
              <th scope="col">Expires</th>
              <th scope="col">Status</th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {grants.map((grant) => (
              <tr key={`${grant.targetType}-${grant.targetId}-${grant.sub}`} style={grant.status === "expired" ? { opacity: 0.5 } : undefined}>
                <td>
                  {grant.targetName} <span style={{ opacity: 0.65 }}>({grant.targetType})</span>
                </td>
                <td>
                  {grant.ownerSub === null ? (
                    "—"
                  ) : (
                    <span style={ACCESS_IDENTITY_TEXT} title={grant.ownerSub}>{grant.ownerSub}</span>
                  )}
                </td>
                <td>
                  <span style={ACCESS_IDENTITY_TEXT} title={grant.sub}>{grant.sub}</span>
                </td>
                <td>{grant.targetType === "collection" && grant.canUpload ? "Yes" : "—"}</td>
                <td style={TIMESTAMP_CELL}>{formatDateTimeLocal(grant.grantedAt)}</td>
                <td style={TIMESTAMP_CELL}>
                  {grant.expiresAt === null ? "Permanent" : formatDateTimeLocal(grant.expiresAt)}
                </td>
                <td>{grant.status === "expired" ? "Expired" : "Active"}</td>
                <td>
                  <button type="button" className="btn-ghost" onClick={() => onRevoke(grant)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function AdminPage() {
  const [state, setState] = useState<LoadState>("loading");
  const [usage, setUsage] = useState<AdminUsageResponse | null>(null);
  const [grants, setGrants] = useState<AdminGrantRow[]>([]);
  const [confirmTarget, setConfirmTarget] = useState<AdminGrantRow | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    setState("loading");
    const [usageRes, grantsRes] = await Promise.all([fetchUsage(), fetchGrants()]);
    // D1: a 404 from either means "not an admin" - a single terminal state, never a retry.
    if (usageRes.status === 404 || grantsRes.status === 404) {
      setState("not-admin");
      return;
    }
    if (!usageRes.ok || !grantsRes.ok) {
      setState("error");
      return;
    }
    setUsage((await usageRes.json()) as AdminUsageResponse);
    setGrants(((await grantsRes.json()) as { grants: AdminGrantRow[] }).grants);
    setState("ready");
  }

  async function confirmRevoke(): Promise<void> {
    const target = confirmTarget;
    if (target === null) return;
    setBusy(true);
    try {
      const res = await revokeGrant(target.targetType, target.targetId, target.sub);
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setGrants((prev) =>
        prev.filter((g) => !(g.targetType === target.targetType && g.targetId === target.targetId && g.sub === target.sub)),
      );
    } finally {
      setBusy(false);
      setConfirmTarget(null);
    }
  }

  if (state === "loading") return null;

  if (state === "not-admin") {
    // Matches app/src/views/NotFound.tsx's copy verbatim - the client-side half of reveal-nothing.
    return (
      <div className="panel">
        <h1>Not found</h1>
        <p>There is nothing at this address. The link may be wrong, or the file may have been deleted.</p>
        <a className="btn" href="/">
          Go to Hannah&rsquo;s File Drop
        </a>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="panel">
        <p>Something went wrong loading the admin panel.</p>
      </div>
    );
  }

  return (
    <>
      {usage !== null && <UsageSection usage={usage} />}
      <AccessSection grants={grants} onRevoke={setConfirmTarget} />
      {/* D-8 class: the direct child list stays structurally constant across open/closed - only content
          INSIDE this wrapper changes, never the modal's own children shape. */}
      <Modal
        open={confirmTarget !== null}
        heading={confirmTarget === null ? "" : `Revoke access to "${confirmTarget.targetName}"?`}
        onClose={() => setConfirmTarget(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setConfirmTarget(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-danger" onClick={() => void confirmRevoke()} disabled={busy}>
              Yes, revoke
            </button>
          </>
        }
      >
        {/* D-23: revocation ends access, files already uploaded stay - stated plainly since it is
            genuinely surprising. */}
        <p>
          Access ends now for <strong>{confirmTarget?.sub}</strong>. Files already uploaded stay.
        </p>
      </Modal>
    </>
  );
}
