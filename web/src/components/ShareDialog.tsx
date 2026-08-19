// E7 Wave D2: the share dialog, one component behind both entry points (D-185) - the row overflow menu
// (FileBrowser.tsx) and the preview page's owner-only block (PreviewCard.tsx).
//
// E7.5 Wave D: mounts @mosni/react's <Modal>, a real <dialog> React itself owns and portals to
// document.body - the D-8 class hazard this component used to be the textbook case of (review session
// 045: a real mosni-modal TAKES its light-DOM children on connect, so React's own parent references go
// stale and swapping a direct child crashes the whole root) no longer applies here. See technical-
// baseline.md's "the variant that is a WHITE SCREEN" for the mechanism and D-214 for the narrowed
// invariant that now binds only elements still given React children (none, after this epic).

import { useEffect, useState } from "react";
import { Modal, Slider, Switch } from "@mosni/react";
import type { Claims } from "../../../app/src/lib/roles.ts";
import { DEFAULT_INVITE_DURATION_INDEX, INVITE_DURATION_STOPS } from "../../../app/src/lib/inviteDuration.ts";
import type { DirectoryAccount, InviteMinted, ShareObjectType, ShareState } from "../../../app/src/lib/shareContext.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { IdentityChip } from "./Identity.tsx";
import { createInvite, fetchAccounts, fetchShareState, grantShare, revokeShare } from "../lib/share.ts";
import { CopyLink } from "./CopyLink.tsx";

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

// The avatar + name combo lives in components/Identity.tsx now (Hannah, 2026-08-19) - one definition
// instead of the three near-copies this file, headerIdentity.tsx and the admin panel were carrying. The
// tooltip gained the sub alongside the name in the same change.

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
  // F13/D-198: defaults ON, per D-23's requirement that the shared-identity consequence be visible and
  // the safer default chosen - an upgradeable link lets its claimant become a real, distinct account.
  const [allowRegister, setAllowRegister] = useState(true);
  // E7-QA2 D-205: the default is 1h (index into INVITE_DURATION_STOPS), not a config-driven constant -
  // INVITE_TTL_SECONDS is retired.
  const [durationIndex, setDurationIndex] = useState(DEFAULT_INVITE_DURATION_INDEX);
  // Review session 052 - defence in depth, not paranoia. `<Slider>` is GENERIC: it is handed a `stops`
  // array and reports the selected INDEX, so the component's stop count and this array are two separate
  // things that must agree forever. A bare `INVITE_DURATION_STOPS[durationIndex]` is `undefined` for any
  // out-of-range index, and the `.label`/`.seconds` read below would then throw in React's RENDER phase -
  // which unmounts the entire root, not just this dialog (D-8, session 021's mosni-tab, session 045's F0:
  // three times already). E7.5: `<Slider>`'s own `clampIndex` refuses to report a garbage index in the
  // first place (its `onChange` never fires with one); this is the second lock, because the cost of being
  // wrong here is the whole app disappearing.
  const durationStop = INVITE_DURATION_STOPS[durationIndex] ?? INVITE_DURATION_STOPS[DEFAULT_INVITE_DURATION_INDEX];
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
    setAllowRegister(true);
    setDurationIndex(DEFAULT_INVITE_DURATION_INDEX);
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
    // D-195: no longer gated on shareable (removed) - the account directory is needed at every protection
    // level now, since a grant is always writable.
    if (!open || state === null || accounts !== null) return;
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
      const res = await createInvite(
        type,
        id,
        type === "collection" ? canUpload : undefined,
        allowRegister,
        durationStop.seconds,
      );
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

  return (
    <Modal
      open={open}
      heading={`Share "${objectLabel}"`}
      onClose={onClose}
      footer={
        <button type="button" className="btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {/* E7.5 Wave D: <Modal> (@mosni/react) renders a real <dialog> that REACT ITSELF owns and portals to
          document.body - so the white-screen hazard this wrapper div used to guard against (review session
          045: a real mosni-modal TAKES its light-DOM children on connect and re-parents them into a
          <dialog> it builds, leaving React's own parent references stale) no longer applies to this call
          site at all. Two of this div's three original reasons are retired with it:
            - the structural-constancy reason (children must never vary directly under the element) is gone
            - `whiteSpace: "normal"` is gone too - the dialog now portals to document.body, so it is no
              longer a DOM descendant of the file-browser row's `<td>` and cannot inherit its
              `white-space: nowrap` (this closes `issues.md` → CHROME-MODAL-INHERITS-NOWRAP project-side)
          What survives: `overflowWrap: "anywhere"` still constrains a raw `link:<uuid>` sub, which is one
          long unbreakable word, and `minWidth: 0` is still needed on every flex child below that holds
          text (a flex item's default `min-width: auto` is what actually prevents wrapping - overflowWrap
          alone does nothing without it). */}
      <div style={{ maxWidth: "100%", overflowWrap: "anywhere" }}>
      {state === null ? (
        <span className="spinner" role="status" aria-label="Loading" />
      ) : (
        <div style={{ display: "grid", gap: "1rem", minWidth: 0 }}>
          {/* D-195: the refusal state is gone (sharing succeeds at every level now) - this is an
              INFORMATIONAL note instead, shown only when a VIEW grant would be inert (the object is
              already readable by anyone with the link; only the upload half of a grant does anything
              here). The picker below is never hidden - §0.4.2's accepted consequence, stated plainly
              rather than pretended away. */}
          {state.effectiveProtection !== "private" && (
            <p className="little-link" style={{ minWidth: 0 }}>
              {type === "file" ? (
                <>
                  This file is <strong>{state.effectiveProtection}</strong>, so anyone with the link can
                  already open it. Sharing it with specific people adds nothing.
                </>
              ) : (
                <>
                  This collection is <strong>{state.effectiveProtection}</strong>, so anyone with the link
                  can already open it. Sharing here only controls who can upload.
                </>
              )}
            </p>
          )}

          {state.grants.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
              {state.grants.map((grant) => (
                <li key={grant.sub} style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                  <IdentityChip sub={grant.sub} name={grant.name} grow />
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

          {/* F5: normal .field spacing - the outer grid's own gap separates this from its neighbours,
              so the inner marginBottom:0 override that collapsed it is removed. E7-QA1 live-testing round
              2: the label-to-input gap itself lives in mosni-chrome's `.field-label` class (margin-bottom,
              confirmed by reading the served mosnicat.js CSS directly), never on a bare `.field > label` -
              ProtectionControl.tsx already gets this right; this label was just missing the class. */}
          <div className="field">
            <label htmlFor={`share-picker-filter-${id}`} className="field-label">
              Add people
            </label>
            <input
              id={`share-picker-filter-${id}`}
              type="text"
              placeholder="Search by name"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>

          {type === "collection" && (
            // F4: a real <Switch> (@mosni/react), not a plain checkbox styled to look like one.
            <Switch
              checked={canUpload}
              label="Can upload into this collection"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCanUpload(e.target.checked)}
            />
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
                  <li key={account.sub} style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                    <IdentityChip sub={account.sub} name={account.name} grow />
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
            // `minWidth: 0` is B1.1's rule applied to a grid item (a grid item defaults to
            // `min-width: auto` exactly as a flex item does). Defensive only - it was NOT what fixed
            // D-23's clipped consequence line below; see the wrapper's comment above for what actually
            // was, and do not let this line's presence suggest otherwise to the next reader.
            <div style={{ display: "grid", gap: "0.5rem", minWidth: 0 }}>
              {/* F13/D-198: the upgradeable switch, pulled forward from E8 - a real <Switch>. */}
              <Switch
                checked={allowRegister}
                label="Let the recipient turn this into their own account"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAllowRegister(e.target.checked)}
              />
              {/* E7-QA2 D-204/D-207: a real <Slider> over the ten D-204 stops (30m -> 90d), defaulting to
                  1h (D-205). Generic component - it knows about stops, not about time; this app supplies
                  the duration labels and reads back the selected INDEX. This closes a live defect class
                  (review 052): the deleted useSliderChange hook read an unvalidated string attribute where
                  Number(null)/Number("") were both a VALID index 0, so a missing attribute silently
                  selected the shortest link. <Slider>'s own clampIndex makes that state unrepresentable -
                  no defensive index validation belongs at this call site any more, that is now the
                  component's job. */}
              <Slider
                stops={INVITE_DURATION_STOPS.map((stop) => stop.label)}
                value={durationIndex}
                label="Link expires after"
                onChange={setDurationIndex}
              />
              {/* D-208: this sentence renders in BOTH switch positions - today's default path said nothing
                  about expiry at all. No hardcoded "24 hours": it names the SELECTED stop. */}
              <p className="little-link" style={{ minWidth: 0 }}>
                This link expires after {durationStop.label}.
              </p>
              {/* D-23's requirement, sharpened by D-196: a non-upgradeable link carrying upload rights is
                  a shared WRITE identity, not just a shared read. Shown plainly at the point of choice -
                  not a tooltip, not behind a disclosure - whenever the switch is off. D-208: the duration
                  half of this sentence moved to the paragraph above, which is why it no longer mentions a
                  lifetime. */}
              {!allowRegister && (
                <p className="little-link" role="alert" style={{ minWidth: 0 }}>
                  Everyone who opens this link shares one identity.
                  {type === "collection" && canUpload
                    ? " Uploads will not be attributable to a person, and anyone with the link can delete anyone else's files."
                    : ""}
                </p>
              )}
              <button
                type="button"
                className="btn-ghost btn-sm"
                style={{ justifySelf: "start", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
                disabled={inviting}
                onClick={() => void sendInvite()}
              >
                <mosni-icon name="user-plus" size={16} /> Invite someone without an account
              </button>
            </div>
          ) : (
            // The URL is shown ONCE - it is never re-fetchable; closing the dialog loses it and a new one
            // must be minted (auth stores only its hash). D-23's consequence-at-the-point-of-choice rule.
            // `minWidth: 0` for the same defensive reason as the sibling branch above - this block holds
            // a minted URL, the longest unbroken string the dialog ever renders.
            <div style={{ display: "grid", gap: "0.5rem", minWidth: 0 }}>
              <CopyLink previewUrl={invite.url} />
              <p className="little-link" style={{ minWidth: 0 }}>
                Anyone who opens this link gets access. The first person to sign up keeps it.
              </p>
              {/* E7-QA2 §B4/D-208: expiresAt was already on InviteMinted (auth's real expires_at) and
                  rendered nowhere. Formatted in the viewer's own locale via the platform Intl machinery -
                  no new dependency. */}
              <p className="little-link" style={{ minWidth: 0 }}>
                Expires {new Date(invite.expiresAt).toLocaleString()}.
              </p>
            </div>
          )}
        </div>
      )}
      </div>
    </Modal>
  );
}
