// E7 Wave D2: the share dialog, one component behind both entry points (D-185) - the row overflow menu
// (FileBrowser.tsx) and the preview page's owner-only block (PreviewCard.tsx).
//
// Children are rendered UNCONDITIONALLY and only the `open` attribute is toggled (the D-8 class bug -
// technical-baseline.md §2): the Delete confirmation modal already mounted in FileBrowser.tsx is the
// pattern this copies. Internal branching on loading/shareable state is ordinary React re-rendering of
// content that is always part of the JSX tree, not children appended after the element has already
// connected - see that file's header comment for why the distinction matters.

import { useEffect, useState } from "react";
import type { Claims } from "../../../app/src/lib/roles.ts";
import type { DirectoryAccount, InviteMinted, ShareObjectType, ShareState } from "../../../app/src/lib/shareContext.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { createInvite, fetchAccounts, fetchShareState, grantShare, revokeShare } from "../lib/share.ts";
import { CopyLink } from "./CopyLink.tsx";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "mosni-modal": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { heading?: string; open?: boolean },
        HTMLElement
      >;
      "mosni-icon": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { name?: string; size?: string | number },
        HTMLElement
      >;
    }
  }
}

// Same subscribe-with-poll shape FileBrowser.tsx and lib/shareTarget.ts already use - the auth SDK's
// <script> tag loads independently of this module, so window.mosni may not exist on first mount yet.
function useCurrentUserSub(): string | null {
  const [sub, setSub] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    function subscribe() {
      if (typeof window.mosni === "undefined") {
        pollTimer = setTimeout(subscribe, 50);
        return;
      }
      window.mosni.onChange((user: Claims | null) => {
        if (!cancelled) setSub(user?.sub ?? null);
      });
    }
    subscribe();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);
  return sub;
}

export function ShareDialog({
  type,
  id,
  objectLabel,
  open,
  onClose,
}: {
  type: ShareObjectType;
  id: string;
  objectLabel: string;
  open: boolean;
  onClose: () => void;
}) {
  const viewerSub = useCurrentUserSub();
  const [state, setState] = useState<ShareState | null>(null);
  const [accounts, setAccounts] = useState<DirectoryAccount[] | null>(null);
  const [filterText, setFilterText] = useState("");
  const [canUpload, setCanUpload] = useState(false);
  const [invite, setInvite] = useState<InviteMinted | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset to a fresh load every time the dialog is opened - the dialog is never re-fetchable stale state
  // across separate opens (matches the invite URL's own "gone once closed" rule below).
  useEffect(() => {
    if (!open) return;
    setState(null);
    setAccounts(null);
    setInvite(null);
    setFilterText("");
    setCanUpload(false);
    void fetchShareState(type, id).then(async (res) => {
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setState((await res.json()) as ShareState);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on open/type/id
  }, [open, type, id]);

  useEffect(() => {
    if (!open || state === null || !state.shareable || accounts !== null) return;
    void fetchAccounts().then(async (res) => {
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setAccounts((await res.json()) as DirectoryAccount[]);
    });
  }, [open, state, accounts]);

  async function refreshState(): Promise<void> {
    const res = await fetchShareState(type, id);
    if (res.ok) setState((await res.json()) as ShareState);
  }

  async function grant(sub: string): Promise<void> {
    setBusy(true);
    try {
      const res = await grantShare(type, id, sub, type === "collection" ? canUpload : undefined);
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setState((await res.json()) as ShareState);
    } finally {
      setBusy(false);
    }
  }

  async function remove(sub: string): Promise<void> {
    setBusy(true);
    try {
      const res = await revokeShare(type, id, sub);
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setState((await res.json()) as ShareState);
    } finally {
      setBusy(false);
    }
  }

  async function sendInvite(): Promise<void> {
    setInviting(true);
    try {
      const res = await createInvite(type, id, type === "collection" ? canUpload : undefined);
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setInvite((await res.json()) as InviteMinted);
      void refreshState();
    } finally {
      setInviting(false);
    }
  }

  const grantedSubs = new Set(state?.grants.map((g) => g.sub) ?? []);
  const needle = filterText.trim().toLowerCase();
  const candidates =
    accounts?.filter((account) => {
      if (account.sub === viewerSub) return false;
      if (grantedSubs.has(account.sub)) return false;
      if (needle.length === 0) return true;
      return account.sub.toLowerCase().includes(needle) || (account.name ?? "").toLowerCase().includes(needle);
    }) ?? [];

  const objectKindWord = type === "file" ? "files" : "collections";

  return (
    <mosni-modal heading={`Share "${objectLabel}"`} open={open}>
      {/* This wrapper is load-bearing, not layout (review session 045, a crash Hannah hit live). A real
          mosni-modal MOVES its light-DOM children on connect - `takeSlot`/`takeDefault` call
          `child.remove()` and re-parent everything into a <dialog> it builds. React does not know that, so
          it still believes these nodes are direct children of <mosni-modal>. Swapping one of them later
          makes React call removeChild/insertBefore on the wrong parent, the DOM throws NotFoundError in
          the commit phase, and the ENTIRE React root unmounts - a white screen, not a broken dialog.
          Keeping <mosni-modal>'s own child list structurally constant ([this div, the footer button]) is
          what makes the branching below safe: everything inside this div is under the relocated boundary,
          where React's parent references are still correct. This is the same D-8 class as the Move and
          Delete modals, but those only ever mutate content INSIDE a stable child, which is why they never
          hit it. Do not "simplify" this div away. */}
      <div>
      {state === null ? (
        <span className="spinner" role="status" aria-label="Loading" />
      ) : !state.shareable ? (
        // D-186: the refusal state offers no one-click switch and no picker - just the current level and
        // a plain pointer to the protection control (the preview page's ManageControls, or the row menu's
        // own Protection item).
        <p>
          This {type} is <strong>{state.effectiveProtection}</strong>. Only private {objectKindWord} can be
          shared with specific people — change the protection level to private first.
        </p>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {state.grants.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
              {state.grants.map((grant) => (
                <li key={grant.sub} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  {grant.picture !== null && (
                    <img src={grant.picture} alt="" width={20} height={20} style={{ borderRadius: "50%" }} />
                  )}
                  <span style={{ flex: 1 }}>{grant.name ?? grant.sub}</span>
                  {grant.canUpload && <span className="badge">Upload</span>}
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void remove(grant.sub)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`share-picker-filter-${id}`}>Add people</label>
            <input
              id={`share-picker-filter-${id}`}
              type="text"
              placeholder="Search by name"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>

          {type === "collection" && (
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <input type="checkbox" checked={canUpload} onChange={(e) => setCanUpload(e.target.checked)} />
              Can upload into this collection
            </label>
          )}

          {accounts !== null && (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                maxHeight: "12rem",
                overflowY: "auto",
                display: "grid",
                gap: "0.35rem",
              }}
            >
              {candidates.length === 0 ? (
                <li style={{ color: "var(--mosni-text-muted)" }}>No matching accounts.</li>
              ) : (
                candidates.map((account) => (
                  <li key={account.sub} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <img src={account.picture} alt="" width={20} height={20} style={{ borderRadius: "50%" }} />
                    <span style={{ flex: 1 }}>{account.name ?? account.sub}</span>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => void grant(account.sub)}
                    >
                      Add
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}

          <hr />

          {invite === null ? (
            <button
              type="button"
              className="btn-ghost btn-sm"
              style={{ justifySelf: "start", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
              disabled={inviting}
              onClick={() => void sendInvite()}
            >
              <mosni-icon name="user-plus" size="16" /> Invite someone without an account
            </button>
          ) : (
            // The URL is shown ONCE - it is never re-fetchable; closing the dialog loses it and a new one
            // must be minted (auth stores only its hash). D-23's consequence-at-the-point-of-choice rule.
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <CopyLink previewUrl={invite.url} />
              <p className="little-link">Anyone who opens this link gets access. The first person to sign up keeps it.</p>
            </div>
          )}
        </div>
      )}
      </div>
      <button slot="footer" type="button" className="btn-ghost" onClick={onClose}>
        Close
      </button>
    </mosni-modal>
  );
}
