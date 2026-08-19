// E8 (D-217 … D-221): the admin panel - a Usage section and an Access section, reached from the
// header's admin-only icon button (web/src/lib/headerIdentity.tsx). Gate: isFilesAdmin (D-68), enforced
// server-side (controllers/admin.ts, 404 never 403). This page's own "not admin" render matches
// app/src/views/NotFound.tsx's copy verbatim - the cosmetic half of reveal-nothing, so a non-admin who
// navigates here directly sees nothing distinguishing it from a mistyped link.
//
// Live-testing round, 2026-08-19 (Hannah): Usage was *"too yappy, too much prose"* and is now a grid of
// bordered metric tiles - *"maybe bordered boxes with just 'metric: value'"* - followed by two top-ten
// tables whose rows are real links; every identity is the picture+name combo (components/Identity.tsx)
// with the sub in the tooltip; the status is a badge and Revoke is danger-styled.
//
// FIVE tiles, one desktop row, and no prose explaining the gap between "volume used" and "tracked by the
// app". The standalone untracked figure went with the explanation - Hannah: *"the gap is obvious to
// literally anyone, why do you think it needs explaining?"* The bug review 059 fixed was a label making a
// WRONG claim (it named 231 GB of a shared disk as this app's own thumbnails); deleting the claim is the
// whole fix, and a tooltip restating the arithmetic would be the same yappiness in a smaller font.

import { useEffect, useState } from "react";
import { Modal, Panel } from "@mosni/react";
import { humanSize } from "../../../app/src/lib/previewContext.ts";
import { DISK_CRITICAL_FREE_BYTES, DISK_WARN_FREE_BYTES } from "../../../app/src/lib/diskUsage.ts";
import type { AdminGrantRow, AdminUsageResponse } from "../../../app/src/lib/adminContext.ts";
import type { DirectoryAccount } from "../../../app/src/lib/shareContext.ts";
import { fetchGrants, fetchUsage, revokeGrant } from "../lib/admin.ts";
import { fetchAccounts } from "../lib/share.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { IdentityChip } from "../components/Identity.tsx";

type LoadState = "loading" | "not-admin" | "error" | "ready";

// A sub -> display name lookup, from the same directory the share dialog's people picker uses
// (GET /api/accounts, D-188). A Map lookup, never a parse (security invariant 6). Anyone the directory
// does not know - a link-bound account, which auth excludes by design, or a sub that was typo'd when it
// was granted - has no name, and IdentityChip falls back to the raw sub exactly as D-222 requires.
type NameLookup = (sub: string | null) => string | null;

function formatDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${date} ${time}`;
}

const TIMESTAMP_CELL: React.CSSProperties = { whiteSpace: "nowrap" };
const NUMERIC_CELL: React.CSSProperties = { whiteSpace: "nowrap", textAlign: "right" };

// ⚠ mosni-chrome exposes --mosni-error and --mosni-success but has NO warning token (read out of the
// served mosnicat.js, 2026-08-19). The amber below is therefore a deliberate local literal, not a token
// that failed to resolve - which is what the previous `var(--color-danger, …)`/`var(--color-warning, …)`
// pair actually was: neither name exists anywhere in the design system, so both always fell through to
// their hardcoded fallback. A warning token would be a reasonable upstream addition (D-31) if this
// treatment spreads beyond one tile.
function freeSpaceTone(freeBytes: number): string | undefined {
  if (freeBytes <= DISK_CRITICAL_FREE_BYTES) return "var(--mosni-error)";
  if (freeBytes <= DISK_WARN_FREE_BYTES) return "#d79a2b";
  return undefined;
}

// "metric: value" in a bordered box, per Hannah's own description of what she wanted instead of prose.
// `hint` is a tooltip, so the one genuinely load-bearing caveat (the volume is shared with the rest of
// the box) stays reachable without becoming a paragraph again.
function Metric({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div
      title={hint}
      style={{
        border: "1px solid var(--mosni-border-muted)",
        borderRadius: "0.5rem",
        padding: "0.6rem 0.8rem",
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: "0.7rem", letterSpacing: "0.02em", color: "var(--mosni-text-muted)" }}>{label}</div>
      <div style={{ fontSize: "1.15rem", fontWeight: 600, color: tone, overflowWrap: "anywhere" }}>{value}</div>
    </div>
  );
}

function MetricGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
        gap: "0.75rem",
        marginBottom: "1.25rem",
      }}
    >
      {children}
    </div>
  );
}

// A top-list row's own link, or a plain label when the object went away between the aggregate and the URL
// resolution (controllers/admin.ts explains why that is possible and why it is not an error).
function ObjectLink({ name, url, sub }: { name: string; url: string | null; sub?: string | null }) {
  const label = (
    <>
      {name}
      {sub !== undefined && sub !== null && (
        <span style={{ display: "block", fontSize: "0.75rem", color: "var(--mosni-text-muted)" }}>{sub}</span>
      )}
    </>
  );
  if (url === null) return <span title={name}>{label}</span>;
  return (
    <a href={url} title={name}>
      {label}
    </a>
  );
}

function UsageSection({ usage, nameFor }: { usage: AdminUsageResponse; nameFor: NameLookup }) {
  return (
    <Panel heading="Usage">
      <MetricGrid>
        {usage.volume === null ? (
          <Metric label="Volume" value="unavailable" hint="statfs on the storage root failed - see the container log." />
        ) : (
          <>
            <Metric label="Volume total" value={humanSize(usage.volume.totalBytes)} />
            <Metric
              label="Volume free"
              value={humanSize(usage.volume.freeBytes)}
              tone={freeSpaceTone(usage.volume.freeBytes)}
              hint={`Warns below ${humanSize(DISK_WARN_FREE_BYTES)}, critical below ${humanSize(DISK_CRITICAL_FREE_BYTES)} (D-35).`}
            />
            <Metric label="Volume used" value={humanSize(usage.volume.usedBytes)} />
          </>
        )}
        <Metric label="Tracked by the app" value={humanSize(usage.tracked.bytes)} />
        <Metric label="Files" value={String(usage.tracked.fileCount)} />
      </MetricGrid>

      <h3>Top collections</h3>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Collection</th>
              <th scope="col">Owner</th>
              <th scope="col" style={NUMERIC_CELL}>Files</th>
              <th scope="col" style={NUMERIC_CELL}>Size</th>
            </tr>
          </thead>
          <tbody>
            {usage.topCollections.map((row) => (
              <tr key={row.collectionId}>
                <td>
                  <ObjectLink name={row.name} url={row.url} />
                </td>
                <td>
                  <IdentityChip sub={row.ownerSub} name={nameFor(row.ownerSub)} maxWidth="11rem" />
                </td>
                <td style={NUMERIC_CELL}>{row.fileCount}</td>
                <td style={NUMERIC_CELL}>{humanSize(row.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Top files</h3>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Owner</th>
              <th scope="col" style={NUMERIC_CELL}>Size</th>
            </tr>
          </thead>
          <tbody>
            {usage.topFiles.map((row) => (
              <tr key={row.fileId}>
                <td>
                  <ObjectLink name={row.name} url={row.url} sub={row.collectionName} />
                </td>
                <td>
                  {row.ownerSub === null ? (
                    "—"
                  ) : (
                    <IdentityChip sub={row.ownerSub} name={nameFor(row.ownerSub)} maxWidth="11rem" />
                  )}
                </td>
                <td style={NUMERIC_CELL}>{humanSize(row.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>By owner</h3>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Owner</th>
              <th scope="col" style={NUMERIC_CELL}>Files</th>
              <th scope="col" style={NUMERIC_CELL}>Size</th>
            </tr>
          </thead>
          <tbody>
            {usage.byOwner.map((row) => (
              <tr key={row.ownerSub}>
                <td>
                  <IdentityChip sub={row.ownerSub} name={nameFor(row.ownerSub)} />
                </td>
                <td style={NUMERIC_CELL}>{row.fileCount}</td>
                <td style={NUMERIC_CELL}>{humanSize(row.bytes)}</td>
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
  nameFor,
  onRevoke,
}: {
  grants: AdminGrantRow[];
  nameFor: NameLookup;
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
                    <IdentityChip sub={grant.ownerSub} name={nameFor(grant.ownerSub)} maxWidth="10rem" />
                  )}
                </td>
                <td>
                  <IdentityChip sub={grant.sub} name={nameFor(grant.sub)} maxWidth="10rem" />
                </td>
                <td>{grant.targetType === "collection" && grant.canUpload ? "Yes" : "—"}</td>
                <td style={TIMESTAMP_CELL}>{formatDateTimeLocal(grant.grantedAt)}</td>
                <td style={TIMESTAMP_CELL}>
                  {grant.expiresAt === null ? "Permanent" : formatDateTimeLocal(grant.expiresAt)}
                </td>
                <td>
                  {/* `.badge` takes `success`/`error` modifiers (read out of the served mosnicat.js) - the
                      only two states a grant has. */}
                  <span className={grant.status === "expired" ? "badge error" : "badge success"}>
                    {grant.status === "expired" ? "Expired" : "Active"}
                  </span>
                </td>
                <td>
                  <button type="button" className="btn-danger btn-sm" onClick={() => onRevoke(grant)}>
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
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [confirmTarget, setConfirmTarget] = useState<AdminGrantRow | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  const nameFor: NameLookup = (sub) => (sub === null ? null : (names.get(sub) ?? null));

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
    // The directory is decoration, not data: a name makes a row readable, its absence never hides one.
    // Fetched after the panel is already `ready` and swallowed entirely on failure, so an unreachable auth
    // degrades to raw subs instead of an empty page.
    void loadNames();
  }

  async function loadNames(): Promise<void> {
    try {
      const res = await fetchAccounts();
      if (!res.ok) return;
      // GET /api/accounts answers a bare array (lib/shareContext.ts's DirectoryAccount[]), the same shape
      // ShareDialog reads. Guarded anyway: internalApi's "never throws" rule was broken once by an
      // unguarded res.json() on a 2xx (review 045's F2), and this call is decoration - it must never take
      // the panel down.
      const accounts = (await res.json()) as DirectoryAccount[];
      if (!Array.isArray(accounts)) return;
      setNames(new Map(accounts.filter((a) => a.name !== null).map((a) => [a.sub, a.name!])));
    } catch {
      // Names are optional; a raw sub is a correct, if less friendly, answer.
    }
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
      {usage !== null && <UsageSection usage={usage} nameFor={nameFor} />}
      <AccessSection grants={grants} nameFor={nameFor} onRevoke={setConfirmTarget} />
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
          Access ends now for <strong>{confirmTarget === null ? "" : (nameFor(confirmTarget.sub) ?? confirmTarget.sub)}</strong>.
          Files already uploaded stay.
        </p>
      </Modal>
    </>
  );
}
