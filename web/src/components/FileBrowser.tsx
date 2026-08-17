// E4 waves D: the file browser. Renders BELOW the drop zone on `/` (D-1, D-93) - never above it, and
// never gating it: this component manages its own auth subscription independently of DropZone's, so an
// anonymous visitor's browse (D-94) is never blocked behind DropZone's own signed-out gate.
//
// D-116 (E4.1 Wave E findings): two scopes share one endpoint (§1.1) - "mine" (own things, Bearer
// required) and "visible" (everything THIS VIEWER can see: public for anonymous, public ∪ own ∪ granted
// signed in, everything for an admin because they ARE an admin). This is ONE contract decided
// server-side; the client sends the same scope for every viewer and branches on role nowhere - there is
// no client-side isFilesAdmin check anywhere in this file. A `<Tabs>` switcher (@mosni/react, E7.5 Wave C)
// lives inside this section (D-93/D-102).
//
// E4.1 Wave B: the listing is a real `<table>` (D-108), one row per item; per-row actions (copy link,
// rename, protection, delete) live behind a trailing `<Dropdown>` overflow menu (D-109) instead of
// always-expanded inline controls.
//
// E4.1 Wave C (D-107 client half): mounted two ways now. On `/` with no `initialCollectionId`, this owns
// its own scope (mine/visible) exactly as before. Mounted by pages/Preview.tsx on `/f/*`/`/t/:token` with
// a server-RESOLVED `initialCollectionId`, it shows that one collection under scope=visible only (the
// scope that also authorizes an owner/superuser/admin/ACL-grant/token viewer, not just a literally-public
// chain - see controllers/browse.ts) and never switches scope or drills via local state: every collection
// click is a REAL navigation (`useNavigate`), and `pages/Preview.tsx` remounts this component fresh (via
// `key`) once it re-resolves a different collection - see that file's comment.
//
// E4.1 Wave E findings, Wave C: breadcrumb crumbs (including the current location) and a collection's
// name are real `<a href>`s, never a control with no href (D-121) - copy-link-address, open-in-new-tab
// and refresh only work on a real anchor. `isPlainLeftClick` below guards every one of them so a
// modifier/middle click is left to the browser instead of being swallowed by `preventDefault()`. Rename
// is inline name-cell editing (C8) instead of an expanded row; "New collection" is a button that inserts
// a client-side-only placeholder row (C10, D-118) instead of a permanent form.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Dropdown, DropdownItem, Modal, Tab, Tabs } from "@mosni/react";
import { can, isSuperuser, type Claims } from "../../../app/src/lib/roles.ts";
import type { Protection, VisibilityReason } from "../../../app/src/lib/protection.ts";
import type { BrowseCollection, BrowseFile, BrowseResponse, Scope } from "../../../app/src/lib/browseContext.ts";
import type { FileKind } from "../../../app/src/lib/fileKind.ts";
import { formatUploadDate, humanSize } from "../../../app/src/lib/previewContext.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { fetchCollections, type CollectionOption } from "../lib/collections.ts";
import { collectArchiveEntries, downloadArchive, isArchiveSupported, type ArchiveWalkLevel } from "../lib/archive.ts";
import { pluralize } from "../lib/format.ts";
import { isPlainLeftClick, pathnameOf, tokenOf } from "../lib/links.ts";
import { upsertJob, useReloadSignal } from "../lib/jobs.ts";
import { DropZone } from "./DropZone.tsx";
import { IconConfirmCancel, RenameInput } from "./InlineRename.tsx";
import { ProtectionControl } from "./ProtectionControl.tsx";
import { ShareDialog } from "./ShareDialog.tsx";
import { VisibilityIndicator } from "./VisibilityIndicator.tsx";

type MosniUser = Claims | null;

// D-116: exactly two tabs, always. "Browse" means scope=visible for every viewer - an admin sees more
// INSIDE it because the server knows they are an admin, never because a third tab exists.
const SCOPE_TABS: { scope: Scope; label: string }[] = [
  { scope: "mine", label: "My files" },
  { scope: "visible", label: "Browse" },
];

const TABLE_COLUMN_COUNT = 6; // icon, name, size, added, visibility, actions - the colSpan an expanded row panel needs

let nextArchiveId = 0; // E5.1 Wave E: mirrors DropZone.tsx's nextUploadId - a simple, testable job-id source

function authHeaders(token: string | null): { headers: Record<string, string> } | undefined {
  return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
}

function jsonHeaders(token: string | null): Record<string, string> {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function browseUrl(scope: Scope, collectionId: string, offset: number, token?: string): string {
  let url = `/api/browse?scope=${scope}`;
  if (collectionId !== "") url += `&collectionId=${encodeURIComponent(collectionId)}`;
  if (offset > 0) url += `&offset=${offset}`;
  // D-98: a collection's own token, when the caller has one (mounted via /t/<token> - see
  // pages/Preview.tsx), is what lets an otherwise-unauthorized anonymous viewer list a secret/private
  // collection reached that way - controllers/browse.ts's isAuthorizedForTarget checks it.
  if (token !== undefined) url += `&token=${encodeURIComponent(token)}`;
  return url;
}

function currentToken(): string | null {
  return typeof window.mosni !== "undefined" ? window.mosni.token() : null;
}

// E5.1 Wave F5: the archive walk multiplies request count (one browse call per node, on top of the one
// delivery request per file the archive already made) against the same global 100/min per-IP limiter
// (E5-DELIVERY-RATE-LIMIT). Reusing review session 034's own rule for the per-file delivery fetches
// (sw.ts's fetchWithRetries/isRetryableStatus) rather than inventing a second one: 429/5xx are transient
// and worth a bounded retry with backoff, any other non-2xx (401/403/404) is the server's SETTLED answer -
// most often a node the viewer may not browse - and retrying it would only delay the rest of the walk.
const ARCHIVE_WALK_MAX_ATTEMPTS = 3;

function isRetryableBrowseStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// D-104: rename/protection stay owner-or-superuser only. D-115 (closes BROWSE-ADMIN-DELETE): delete is
// ADDITIONALLY offered to a files:delete holder, with the same affordance and confirmation as an owner's -
// a strictly wider gate than manage, never a separate path. D-190 (E7) widens delete once more: the
// containing collection's owner may delete a file hosted there - `canManage` is deliberately UNCHANGED, so
// a hosted row gets Delete and nothing else (share included - D-187: only the file's own owner shares it).
function canManage(reason: VisibilityReason, user: MosniUser): boolean {
  return reason === "own" || (user !== null && isSuperuser(user));
}

function canDelete(reason: VisibilityReason, user: MosniUser): boolean {
  return canManage(reason, user) || (user !== null && can(user, "files:delete")) || reason === "hosted";
}

async function copyLinkToClipboard(url: string): Promise<void> {
  await navigator.clipboard.writeText(url);
  if (typeof window.mosni !== "undefined" && window.mosni.toast) {
    window.mosni.toast("Link copied", { variant: "success" });
  }
}

type RowPanel = "rename" | "protection" | null;

// G3 (E4.1 live-testing findings, Wave G): move, shared between a file row (PATCH .../collectionId) and a
// collection row (PATCH .../parentId) - the modal itself doesn't care which. Options are Root plus the
// caller's own collections (GET /api/collections, extracted to web/src/lib/collections.ts). For a
// collection row, the destination list is NOT filtered client-side to exclude the row itself or its
// descendants - the server already rejects that (Wave C3's 400 invalid_destination), surfaced through
// toastMutationFailure, rather than a client-side tree walk duplicating that check. Not drag-and-drop (Q6).
function MoveModal({
  itemName,
  open,
  destination,
  onDestinationChange,
  collections,
  onConfirm,
  onCancel,
}: {
  itemName: string;
  open: boolean;
  destination: string;
  onDestinationChange: (id: string) => void;
  collections: CollectionOption[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // E7.5 Wave D: <Modal> (@mosni/react) - a real <dialog> React owns and portals to document.body, closing
  // both hazards this used to guard against: the D-8 class (a real mosni-modal took its light-DOM children
  // on connect, so React's stale parent references crashed the whole root on any later child swap) and the
  // self-close desync (E7-QA1 §C2/F7: a real mosni-modal could close itself - backdrop/ESC/its own control
  // - without React knowing, leaving `open` stuck true). <Modal>'s own `onClose` fires from the dialog's
  // native `close` event, so `onCancel` wired there covers both a Cancel click and a self-close identically.
  return (
    <Modal
      open={open}
      heading={`Move "${itemName}"`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={onConfirm}>
            Move
          </button>
        </>
      }
    >
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`move-destination-${itemName}`}>Destination</label>
        <select
          id={`move-destination-${itemName}`}
          value={destination}
          onChange={(event) => onDestinationChange(event.target.value)}
        >
          <option value="">Root</option>
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}

// C8/C10 (E4.1 Wave E findings): the confirm/cancel pair for both inline rename and the new-collection
// placeholder row - same shape (two `btn-icon` buttons, check/x), different accessible names and,
// for the create case, a disabled state while the name is empty. Extracted to InlineRename.tsx (E5.1 Wave
// G, finding 8) so the file-detail page can reuse the exact same interaction.

function RowActions({
  name,
  previewUrl,
  manage,
  mayDelete,
  onRename,
  onProtection,
  onMove,
  onShare,
  onDeleteSelected,
}: {
  name: string;
  previewUrl: string;
  manage: boolean;
  mayDelete: boolean;
  onRename: () => void;
  onProtection: () => void;
  onMove: () => void;
  onShare: () => void;
  onDeleteSelected: () => void;
}) {
  function onSelect(value: string) {
    if (value === "copy") void copyLinkToClipboard(previewUrl);
    else if (value === "rename") onRename();
    else if (value === "protection") onProtection();
    else if (value === "move") onMove();
    else if (value === "share") onShare();
    else if (value === "delete") onDeleteSelected();
  }

  return (
    // E4.1 Wave E findings (C7, finding 3): icon-only (Wave 0.3) - just the ⋮ glyph, no visible text and
    // no chevron, so the trigger is no longer the second-widest thing in the row. `label` is no longer
    // visible text once icon-only is set, so it becomes the trigger's aria-label instead - safe to make
    // it per-row again ("Actions for <name>") since nothing renders it as literal button text anymore
    // (the old fixed "Actions" existed ONLY to avoid that - see D-79's phone-width finding).
    <Dropdown iconOnly="more-vertical" label={`Actions for ${name}`} onSelect={onSelect}>
      <DropdownItem value="copy">Copy link</DropdownItem>
      {manage && <DropdownItem value="rename">Rename</DropdownItem>}
      {manage && <DropdownItem value="protection">Protection</DropdownItem>}
      {/* G3 (E4.1 live-testing findings): gated on `manage`, same as rename/protection. */}
      {manage && <DropdownItem value="move">Move</DropdownItem>}
      {/* E7: gated on `manage` too - only the object's own owner (or a superuser) may share it (D-187),
          exactly the same population that may rename/change protection/move it. */}
      {manage && <DropdownItem value="share">Share</DropdownItem>}
      {mayDelete && (
        <DropdownItem value="delete" variant="danger">
          Delete
        </DropdownItem>
      )}
    </Dropdown>
  );
}

// Live-testing addition (2026-08-06, Hannah): "for files that we preview, let's show a different lucide
// icon in the file browser list - for example, an audio file without cover art gets a music note symbol,
// a code text file gets code-text icon, etc."
//
// The kind -> icon map lives HERE, not on the server: `BrowseFile.kind` is a semantic kind, so the API
// never hardcodes design-system vocabulary and a future icon-set change stays a client-only edit.
//
// ⚠ Every name below was verified to exist in lucide 1.23 (the version mosni-chrome pins), because
// <mosni-icon> renders NOTHING at all for a name lucide does not know - icons-all/index.ts's create()
// returns null and the element paints empty. A typo here is therefore an invisible blank cell, not an
// error, which is exactly the kind of failure this project keeps getting bitten by.
const ICON_BY_KIND: Record<FileKind, string> = {
  image: "file-image",
  video: "file-video",
  audio: "file-music", // Hannah's "music note symbol"
  pdf: "file-text",
  code: "file-code", // her "code-text icon"
  text: "file-text",
  archive: "file-archive",
  other: "file", // the previous behaviour for everything, now only the genuine fallback
};

function iconForKind(kind: FileKind | undefined): string {
  // `kind` is undefined for a response from a server predating this field - fall back to what every row
  // used to show rather than rendering an empty cell.
  return kind === undefined ? "file" : (ICON_BY_KIND[kind] ?? "file");
}

function FileRow({ row, user, onReload }: { row: BrowseFile; user: MosniUser; onReload: () => void }) {
  const [panel, setPanel] = useState<RowPanel>(null);
  const [renameValue, setRenameValue] = useState(row.name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [moveDestination, setMoveDestination] = useState("");
  const [moveCollections, setMoveCollections] = useState<CollectionOption[]>([]);
  const [moveCollectionsLoaded, setMoveCollectionsLoaded] = useState(false);
  const manage = canManage(row.reason, user);
  const mayDelete = canDelete(row.reason, user);

  function openMove() {
    setMoveDestination("");
    setMoveOpen(true);
    if (!moveCollectionsLoaded) {
      setMoveCollectionsLoaded(true);
      void fetchCollections(currentToken()).then(setMoveCollections);
    }
  }

  // G3: the destination list is not filtered client-side (a file has no descendants to worry about, but
  // consistency with CollectionRow's move matters more than the extra few bytes of unfiltered options).
  async function submitMove() {
    const res = await fetch(`/api/files/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ collectionId: moveDestination }),
    });
    if (res.ok) {
      setMoveOpen(false);
      onReload();
    } else {
      await toastMutationFailure(res);
    }
  }

  function startRename() {
    setRenameValue(row.name);
    setPanel("rename");
  }

  function cancelRename() {
    setPanel(null);
  }

  // C8: unchanged guard from the old RenameForm - empty, whitespace-only, or unchanged is a no-op.
  async function submitRename() {
    if (renameValue.trim().length === 0 || renameValue === row.name) return;
    const res = await fetch(`/api/files/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ name: renameValue }),
    });
    if (res.ok) {
      setPanel(null);
      onReload();
    } else {
      await toastMutationFailure(res);
    }
  }

  async function changeProtection(next: Protection): Promise<boolean> {
    const res = await fetch(`/api/files/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ protection: next }),
    });
    if (!res.ok) {
      await toastMutationFailure(res);
      return false;
    }
    onReload();
    return true;
  }

  async function confirmDelete() {
    const res = await fetch(`/api/files/${row.id}`, { method: "DELETE", headers: authHeaders(currentToken())?.headers });
    if (res.ok) {
      setDeleteOpen(false);
      onReload();
    }
  }

  return (
    <>
      <tr data-row-id={row.id}>
        <td>
          {/* D-137: a thumbnail is a display nicety, not a security boundary - the server already gated
              row.thumbUrl identically to the file itself, so the client just renders whatever it was
              handed. alt="" - the adjacent name link already names the file; a screen reader does not need
              this image announced twice. */}
          {row.thumbUrl !== null ? (
            <img
              src={row.thumbUrl}
              alt=""
              width={18}
              height={18}
              loading="lazy"
              style={{ objectFit: "cover", borderRadius: 2 }}
            />
          ) : (
            <mosni-icon name={iconForKind(row.kind)} size={18} />
          )}
        </td>
        <td>
          {/* Hannah's call: leave a FILE's name as a full-page link - opening a file is a full page load,
              unlike a collection's client-side navigation (C4). Do not "align" the two. */}
          {panel === "rename" ? (
            <RenameInput value={renameValue} onChange={setRenameValue} onSubmit={() => void submitRename()} onCancel={cancelRename} />
          ) : (
            <a href={row.previewUrl}>{row.name}</a>
          )}
        </td>
        <td className="table-col-secondary">{humanSize(row.bytes)}</td>
        <td className="table-col-secondary">{formatUploadDate(row.createdAt)}</td>
        <td>
          <VisibilityIndicator reason={row.reason} />
        </td>
        <td>
          {panel === "rename" ? (
            <IconConfirmCancel
              onConfirm={() => void submitRename()}
              onCancel={cancelRename}
              confirmLabel="Save name"
              cancelLabel="Cancel rename"
            />
          ) : (
            <RowActions
              name={row.name}
              previewUrl={row.previewUrl}
              manage={manage}
              mayDelete={mayDelete}
              onRename={startRename}
              onProtection={() => setPanel("protection")}
              onMove={openMove}
              onShare={() => setShareOpen(true)}
              onDeleteSelected={() => setDeleteOpen(true)}
            />
          )}
          <Modal
            open={deleteOpen}
            heading={`Delete "${row.name}"?`}
            onClose={() => setDeleteOpen(false)}
            footer={
              <>
                <button type="button" className="btn-ghost" onClick={() => setDeleteOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="btn-danger" onClick={() => void confirmDelete()}>
                  Yes, delete
                </button>
              </>
            }
          >
            <p>This can&apos;t be undone.</p>
          </Modal>
          <MoveModal
            itemName={row.name}
            open={moveOpen}
            destination={moveDestination}
            onDestinationChange={setMoveDestination}
            collections={moveCollections}
            onConfirm={() => void submitMove()}
            onCancel={() => setMoveOpen(false)}
          />
          <ShareDialog
            type="file"
            id={row.id}
            objectLabel={row.name}
            open={shareOpen}
            onClose={() => setShareOpen(false)}
          />
        </td>
      </tr>
      {panel === "protection" && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT}>
            <ProtectionControl id={row.id} protection={row.effectiveProtection} onChange={changeProtection} />
          </td>
        </tr>
      )}
    </>
  );
}

function CollectionRow({
  row,
  user,
  onOpen,
  onReload,
}: {
  row: BrowseCollection;
  user: MosniUser;
  onOpen: (row: BrowseCollection) => void;
  onReload: () => void;
}) {
  const [panel, setPanel] = useState<RowPanel>(null);
  const [renameValue, setRenameValue] = useState(row.name);
  const [pending, setPending] = useState<{ collectionCount: number; fileCount: number } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [moveDestination, setMoveDestination] = useState("");
  const [moveCollections, setMoveCollections] = useState<CollectionOption[]>([]);
  const [moveCollectionsLoaded, setMoveCollectionsLoaded] = useState(false);
  // E7-QA1 §C2 (F7): shared by <Modal>'s onClose and the Cancel button below - resets deleteOpen AND the
  // dry-run pending count together, whether dismissed by the button, backdrop, or ESC.
  function closeDeleteModal() {
    setDeleteOpen(false);
    setPending(null);
  }
  const manage = canManage(row.reason, user);
  const mayDelete = canDelete(row.reason, user);

  function openMove() {
    setMoveDestination("");
    setMoveOpen(true);
    if (!moveCollectionsLoaded) {
      setMoveCollectionsLoaded(true);
      void fetchCollections(currentToken()).then(setMoveCollections);
    }
  }

  // G3: the destination list is NOT filtered client-side to exclude this collection's own descendants -
  // the server rejects that (Wave C3's 400 invalid_destination), surfaced through toastMutationFailure,
  // rather than a client-side tree walk duplicating the server's own check.
  async function submitMove() {
    const res = await fetch(`/api/collections/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ parentId: moveDestination }),
    });
    if (res.ok) {
      setMoveOpen(false);
      onReload();
    } else {
      await toastMutationFailure(res);
    }
  }

  function startRename() {
    setRenameValue(row.name);
    setPanel("rename");
  }

  function cancelRename() {
    setPanel(null);
  }

  async function submitRename() {
    if (renameValue.trim().length === 0 || renameValue === row.name) return;
    const res = await fetch(`/api/collections/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ name: renameValue }),
    });
    if (res.ok) {
      setPanel(null);
      onReload();
    } else {
      await toastMutationFailure(res);
    }
  }

  async function changeProtection(next: Protection): Promise<boolean> {
    const res = await fetch(`/api/collections/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ protection: next }),
    });
    if (!res.ok) {
      await toastMutationFailure(res);
      return false;
    }
    onReload();
    return true;
  }

  // D-88/D-104: the descendant count is fetched (dry run) BEFORE the modal opens, so its confirmation
  // text can name what will actually be removed.
  async function requestDelete() {
    const res = await fetch(`/api/collections/${row.id}?dryRun=true`, {
      method: "DELETE",
      headers: authHeaders(currentToken())?.headers,
    });
    if (!res.ok) return;
    setPending((await res.json()) as { collectionCount: number; fileCount: number });
    setDeleteOpen(true);
  }

  async function confirmDelete() {
    const res = await fetch(`/api/collections/${row.id}`, { method: "DELETE", headers: authHeaders(currentToken())?.headers });
    if (res.ok) {
      setDeleteOpen(false);
      setPending(null);
      onReload();
    }
  }

  return (
    <>
      <tr data-row-id={row.id}>
        <td>
          <mosni-icon name="folder" size={18} />
        </td>
        <td>
          {panel === "rename" ? (
            <RenameInput value={renameValue} onChange={setRenameValue} onSubmit={() => void submitRename()} onCancel={cancelRename} />
          ) : (
            // C4 (D-121): a real <a href>, not a <button> - copy-link-address, open-in-new-tab and
            // refresh only work on a real anchor. No .btn-ghost: a bare <a> renders plain purple already
            // (matching the breadcrumbs and FileRow's own name link).
            <a
              href={pathnameOf(row.previewUrl)}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                onOpen(row);
              }}
            >
              {row.name}
            </a>
          )}
        </td>
        <td className="table-col-secondary">{"—" /* D-110: collections are not files - no size to show */}</td>
        <td className="table-col-secondary">{"—" /* BrowseCollection carries no date */}</td>
        <td>
          <VisibilityIndicator reason={row.reason} />
        </td>
        <td>
          {panel === "rename" ? (
            <IconConfirmCancel
              onConfirm={() => void submitRename()}
              onCancel={cancelRename}
              confirmLabel="Save name"
              cancelLabel="Cancel rename"
            />
          ) : (
            <RowActions
              name={row.name}
              previewUrl={row.previewUrl}
              manage={manage}
              mayDelete={mayDelete}
              onRename={startRename}
              onProtection={() => setPanel("protection")}
              onMove={openMove}
              onShare={() => setShareOpen(true)}
              onDeleteSelected={() => void requestDelete()}
            />
          )}
          <Modal
            open={deleteOpen}
            heading={`Delete "${row.name}"?`}
            onClose={closeDeleteModal}
            footer={
              <>
                <button type="button" className="btn-ghost" onClick={closeDeleteModal}>
                  Cancel
                </button>
                <button type="button" className="btn-danger" onClick={() => void confirmDelete()}>
                  Yes, delete
                </button>
              </>
            }
          >
            <p>
              {pending !== null && pending.collectionCount > 1 && `${pluralize(pending.collectionCount - 1, "nested collection")} and `}
              {pending !== null && pending.fileCount > 0 && `${pluralize(pending.fileCount, "file")} will also be deleted. `}
              This can&apos;t be undone.
            </p>
          </Modal>
          <MoveModal
            itemName={row.name}
            open={moveOpen}
            destination={moveDestination}
            onDestinationChange={setMoveDestination}
            collections={moveCollections}
            onConfirm={() => void submitMove()}
            onCancel={() => setMoveOpen(false)}
          />
          <ShareDialog
            type="collection"
            id={row.id}
            objectLabel={row.name}
            open={shareOpen}
            onClose={() => setShareOpen(false)}
          />
        </td>
      </tr>
      {panel === "protection" && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT}>
            <ProtectionControl id={row.id} protection={row.effectiveProtection} onChange={changeProtection} />
          </td>
        </tr>
      )}
    </>
  );
}

export function FileBrowser({
  initialScope,
  initialCollectionId,
  initialToken,
}: { initialScope?: Scope; initialCollectionId?: string; initialToken?: string } = {}) {
  const navigate = useNavigate();
  // A collection-route mount (pages/Preview.tsx) never switches scope or drills via local state - see
  // this file's header comment. `collectionId`/`scope` are therefore fixed for the component's whole
  // lifetime in that mode; a DIFFERENT resolved collection remounts a fresh instance (`key`) instead.
  const isCollectionRoute = initialCollectionId !== undefined;
  const collectionId = initialCollectionId ?? "";
  const [user, setUser] = useState<MosniUser>(null);
  const [authReady, setAuthReady] = useState(false);
  const [scope, setScope] = useState<Scope | null>(isCollectionRoute ? "visible" : (initialScope ?? null));
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [newCollectionName, setNewCollectionName] = useState("");
  // C10/D-118: the "New collection" button inserts this CLIENT-SIDE-ONLY placeholder row; no server call
  // happens until confirm, and cancel touches nothing.
  const [creatingCollection, setCreatingCollection] = useState(false);
  // E5.1 Wave E (D-161): "Download all" progress now lives in the SHARED job stack (web/src/lib/jobs.ts),
  // same as upload progress - this is only a local "is one of MY archives currently in flight" flag, so
  // the button can disable itself without this component reading the store back.
  const [archiveInFlight, setArchiveInFlight] = useState(false);
  // E7-QA1 §C1 (F6): the collection page's own Share control - owner/superuser only (data.canManage).
  const [shareOpen, setShareOpen] = useState(false);

  // E5.1 Wave E (finding 4): a completed upload - root-mounted OR compact on a collection page, via the
  // SAME signal (see jobs.ts's header comment) - refreshes whatever listing is mounted here. Skips the
  // very first value on mount: `useReloadSignal()`'s snapshot is whatever the shared counter already
  // happens to be (e.g. left over from an archive/upload elsewhere on the page before this instance
  // mounted), not a fresh "something just finished" event.
  const externalReloadSignal = useReloadSignal();
  const isFirstReloadSignal = useRef(true);
  useEffect(() => {
    if (isFirstReloadSignal.current) {
      isFirstReloadSignal.current = false;
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reload` is a stable closure over setState;
    // this effect's only real dependency is the signal itself.
  }, [externalReloadSignal]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    function subscribe() {
      if (typeof window.mosni === "undefined") {
        pollTimer = setTimeout(subscribe, 50);
        return;
      }
      window.mosni.onChange((nextUser) => {
        if (cancelled) return;
        setUser(nextUser);
        setAuthReady(true);
      });
    }
    subscribe();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  // Default scope, once we know who is looking: an anonymous visitor starts on Browse (D-94/D-116);
  // anyone signed in starts on their own things. `initialScope` (used by tests, and available to a future
  // caller) skips this and is never overridden afterward.
  useEffect(() => {
    if (initialScope !== undefined || !authReady || scope !== null) return;
    setScope(user !== null ? "mine" : "visible");
  }, [initialScope, authReady, user, scope]);

  useEffect(() => {
    // D-123 (E4.1 live-testing findings, Wave D, finding 5): gated on authReady too, not just `scope !==
    // null`. On a collection-route mount `scope` is `"visible"` from the very first render (see the
    // header comment), so without this gate the fetch fired before auth existed and its anonymous result
    // was never replaced - "Browse is empty until you switch tabs and back" was exactly that: switching
    // tabs changes `scope` twice, forcing the refetch this gate now makes unnecessary. `authReady` is a
    // monotonic boolean, unlike `user` (a fresh reference on every SDK callback) - adding `user` itself
    // instead would refetch the whole listing repeatedly rather than exactly once when auth resolves.
    if (scope === null || !authReady) return;
    let cancelled = false;
    void fetch(browseUrl(scope, collectionId, 0, initialToken), authHeaders(currentToken()))
      .then((res) => (res.ok ? (res.json() as Promise<BrowseResponse>) : null))
      .then((json) => {
        if (!cancelled) setData(json);
      });
    return () => {
      cancelled = true;
    };
    // collectionId/initialToken are fixed for this component's lifetime in collection-route mode (see the
    // header comment) but are still real dependencies for the root-mounted case's own lint correctness.
    // Finding 2 (A1): `user?.sub` - a STABLE IDENTITY STRING, not `user` itself - is also a dependency.
    // `authReady` flips true on the FIRST onChange, which fires anonymous; on a root-mounted browser a
    // later sign-in also flips `scope` (mine/visible), so the effect already re-runs there, but a
    // collection-route mount fixes `scope` at "visible" for its whole lifetime (see the header comment),
    // so without this a sign-in after a cold anonymous load left the listing on its anonymous snapshot
    // forever, with nothing left to trigger a refetch. `user?.sub` changes exactly when identity changes;
    // `user` itself is a fresh reference on every SDK callback and would refetch on every single one.
  }, [scope, collectionId, reloadKey, initialToken, authReady, user?.sub]);

  // D-116: Browse is always shown; My files only once signed in. No isFilesAdmin branch, and no role
  // branch of any kind - an admin sees the exact same two tabs as everyone else and sees more INSIDE
  // Browse because the server, not this filter, knows they are an admin.
  const visibleTabs = useMemo(() => SCOPE_TABS.filter((t) => t.scope === "visible" || user !== null), [user]);

  function reload() {
    setReloadKey((k) => k + 1);
  }

  async function loadMore() {
    if (data === null || data.nextOffset === null || scope === null) return;
    const res = await fetch(browseUrl(scope, collectionId, data.nextOffset, initialToken), authHeaders(currentToken()));
    if (!res.ok) return;
    const next = (await res.json()) as BrowseResponse;
    setData((prev) =>
      prev === null
        ? next
        : {
            breadcrumb: next.breadcrumb,
            collections: [...prev.collections, ...next.collections],
            files: [...prev.files, ...next.files],
            nextOffset: next.nextOffset,
            canUpload: next.canUpload,
            canManage: next.canManage,
          },
    );
  }

  // C10/D-118: no name reaches the API empty - the confirm button is disabled while trimmed is empty
  // (below), and this guard is the same one belt-and-braces check submitRename() etc. already use.
  async function submitCreateCollection() {
    const name = newCollectionName.trim();
    if (name.length === 0) return;
    const res = await fetch("/api/collections", {
      method: "POST",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ name, parentId: collectionId || undefined }),
    });
    if (res.ok) {
      setNewCollectionName("");
      setCreatingCollection(false);
      reload();
    } else {
      await toastMutationFailure(res);
    }
  }

  function cancelCreateCollection() {
    setNewCollectionName("");
    setCreatingCollection(false);
  }

  // E5.1 Wave F (finding 10, D-159): each level of the walk goes through the EXACT SAME GET /api/browse
  // call the rest of this component already uses (browseUrl/authHeaders/currentToken) - §1.5 binds: this
  // is not a second, wider authorization path, just the walk driving the same endpoint level by level.
  // A node is reached purely by what ITS PARENT's browse response already returned - the root by this
  // page's own `initialToken` (D-98's anonymous secret-collection bypass), a deeper node by the token the
  // parent's listing carried for it in its `/t/<token>` previewUrl (links.ts's tokenOf). The root's token
  // never rides down into a collection it does not belong to; it would not work if it did, since a `secret`
  // collection matches only its OWN linkToken. Session 039 (review) found the walk was passing NO token
  // below the root, so every nested level of a link-shared collection 404d and vanished from the zip with
  // nothing in the omitted tail to say so.
  async function fetchArchiveLevel(id: string, offset: number, token: string | null): Promise<ArchiveWalkLevel | null> {
    if (scope === null) return null;
    const url = browseUrl(scope, id, offset, token ?? undefined);
    for (let attempt = 0; attempt < ARCHIVE_WALK_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await delay(2 ** (attempt - 1) * 500); // exponential backoff, same shape as sw.ts's
      const res = await fetch(url, authHeaders(currentToken()));
      if (res.ok) {
        const json = (await res.json()) as BrowseResponse;
        return {
          collections: json.collections.map((c) => ({ id: c.id, name: c.name, token: tokenOf(c.previewUrl) })),
          files: json.files.map((f) => ({ name: f.name, directUrl: f.directUrl })),
          nextOffset: json.nextOffset,
        };
      }
      if (!isRetryableBrowseStatus(res.status)) return null; // settled - §1.5: not authorized/gone, contributes nothing
    }
    return null; // exhausted retries - the observation belongs to E5-DELIVERY-RATE-LIMIT, not a crash here
  }

  // E5 Wave G (D-133), amended E5.1 Wave E+F (D-161/D-159): walks the full subtree from this collection
  // down, preserving each nested collection as a real zip directory - never flattened - and publishes
  // progress to the SHARED job stack instead of local component state, so it renders alongside upload
  // progress in the one stack main.tsx mounts.
  async function handleDownloadAll() {
    if (data === null) return;
    const archiveName = data.breadcrumb.at(-1)?.name ?? "archive";
    const jobId = `archive-${nextArchiveId++}`;
    setArchiveInFlight(true);
    let lastTotal = 0;
    let lastFailed: string[] = [];
    upsertJob({ id: jobId, kind: "archive", name: archiveName, status: "archiving", completed: 0, total: 0, failed: [] });
    try {
      // F1: the walk starts at THIS collection and paginates every level itself - it does not reuse
      // `data.files`/`data.collections`, so a top level with more than one page is fully covered too, not
      // just its nested children.
      const { entries, omitted } = await collectArchiveEntries(
        collectionId,
        fetchArchiveLevel,
        {},
        initialToken ?? null,
      );
      lastTotal = entries.length + omitted.length;
      lastFailed = [...omitted];
      // E5.1 Wave H found this by executing (not in the original hand-off): downloadArchive()'s own
      // promise resolves as soon as the manifest is posted and the download is TRIGGERED - it does not
      // wait for the service worker to actually finish fetching every file. Marking the job "done"
      // immediately after that await raced a still-arriving onProgress message, which then flipped the
      // job back to "archiving" after the premature "done" had already rendered. `finished` tracks the
      // SW's own completion signal (completed >= total) instead, and archives with nothing to fetch at
      // all (every entry omitted by a guard) resolve it immediately, since the worker never posts a
      // progress message for an empty manifest (its per-file loop never runs).
      let resolveFinished: () => void;
      let rejectFinished: (err: Error) => void;
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
      });
      // E6 Wave H (D-181): handleDownloadAll's wait on the service worker's completed >= total signal used
      // to be unbounded (issues.md -> ARCHIVE-STALL-NO-TIMEOUT) - a worker that stops posting progress
      // (a crashed/evicted worker, a network path that goes fully silent) left this awaiting forever with
      // "Download all" stuck disabled. Bounded on time SINCE THE LAST progress message, not total elapsed
      // - a multi-GB archive is legitimately slow, that must not itself count as a stall.
      const STALL_TIMEOUT_MS = 60_000;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const armStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          rejectFinished(new Error("Archive stalled — nothing received for 60s"));
        }, STALL_TIMEOUT_MS);
      };
      const clearStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
      };
      const report = (completed: number, failed: string[]) => {
        // H2: reset on EVERY progress message, not just one that advances `completed` - a run of
        // failed-but-still-arriving messages is not silence.
        armStallTimer();
        lastFailed = [...omitted, ...failed];
        const completedTotal = omitted.length + completed;
        upsertJob({
          id: jobId,
          kind: "archive",
          name: archiveName,
          status: "archiving",
          completed: completedTotal,
          total: lastTotal,
          failed: lastFailed,
        });
        if (completedTotal >= lastTotal) {
          clearStallTimer();
          resolveFinished();
        }
      };
      report(0, []); // the walk's own guard omissions (F3/F5) are visible immediately, before any fetch starts
      await downloadArchive(archiveName, entries, (progress) => report(progress.completed, progress.failed));
      await finished;
      upsertJob({ id: jobId, kind: "archive", name: archiveName, status: "done", completed: lastTotal, total: lastTotal, failed: lastFailed });
    } catch (err) {
      upsertJob({ id: jobId, kind: "archive", name: archiveName, status: "error", completed: 0, total: lastTotal, failed: lastFailed });
      if (typeof window.mosni !== "undefined" && window.mosni.toast) {
        window.mosni.toast(err instanceof Error ? err.message : "Could not start the download", {
          variant: "error",
        });
      }
    } finally {
      setArchiveInFlight(false);
    }
  }

  if (scope === null) {
    return <span className="spinner" role="status" aria-label="Loading" />;
  }

  // Finding 9 (A3): line ~704 forces `scope` to "visible" for every collection route, so the old
  // `scope === "mine"` gate could never hold there and the button never rendered inside a collection at
  // all, even for its own owner. The server already computes canUpload for THAT specific collection
  // (Wave C4/G2's compact upload box uses the same field) - a collection route gates on it directly
  // instead of the tab scope, which does not exist in that mode.
  const canCreateHere = isCollectionRoute
    ? (data?.canUpload ?? false)
    : scope === "mine" && user !== null && can(user, "files:write");

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {/* Scope switching only makes sense in root mode - a collection-route mount is a fixed, specific
          collection (see the header comment), not something to browse mine/visible within. */}
      {!isCollectionRoute && authReady && visibleTabs.length > 1 && (
        // E7.5 Wave C: <Tabs>/<Tab> (@mosni/react) render real DOM and own selection themselves - no ref,
        // no mosni-tab-change listener, no key-based remount hack (all three existed only because the old
        // custom element mounted once and physically relocated its children thereafter). `selectedIndex`
        // must never be -1: `findIndex` returns that while `scope` is momentarily not among `visibleTabs`
        // (reachable while auth resolves), so it is floored at 0.
        <Tabs
          selectedIndex={Math.max(0, visibleTabs.findIndex((t) => t.scope === scope))}
          onChange={(index: number) => {
            const next = visibleTabs[index];
            if (next) setScope(next.scope);
          }}
        >
          {visibleTabs.map((tab) => (
            <Tab key={tab.scope} label={tab.label} />
          ))}
        </Tabs>
      )}

      {/* C9/D-117: the "Files and collections" heading is removed entirely, not moved. */}

      {canCreateHere && (
        // D-118 asks for a MINIMAL button. Two things are load-bearing here and both were wrong in the
        // first pass (caught by the D-79 check, not by any test - it rendered as a full-width filled
        // purple bar, the loudest element on the page, i.e. the exact opposite of the decision):
        //   - `btn-ghost` is required, not just `btn-sm`. mosni-chrome's `_button.scss` styles the BARE
        //     `button` element selector, so a `<button>` with no variant is a filled purple primary with
        //     no opt-out (D-111's root cause). `btn-sm` only shrinks the padding; it does not un-fill it.
        //   - `justifySelf: "start"` is required because this element's parent is `display: grid`, whose
        //     default `justify-items: stretch` makes any child span the full column width.
        <button
          type="button"
          className="btn-ghost btn-sm"
          style={{ justifySelf: "start", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
          disabled={creatingCollection}
          onClick={() => {
            setNewCollectionName("");
            setCreatingCollection(true);
          }}
        >
          <mosni-icon name="plus" size={16} /> New collection
        </button>
      )}

      {data === null ? (
        <span className="spinner" role="status" aria-label="Loading" />
      ) : (
        <>
          {/* G2 (E4.1 live-testing findings, Wave G, finding 11): a minimal upload box on a collection
              page - ONLY when the server said this viewer may upload here (`canUpload`, Wave C4). The
              client never infers upload rights from the user object (D-116's lesson: the server decides).
              D-107 originally made collection routes view-only by design; D-129 changes that deliberately
              - noted here so a future session does not "restore" the read-only rule. */}
          {/* E5.1 Wave E (D-161): no `onUploadComplete` prop any more - DropZone bumps the SHARED reload
              signal on every completed upload, and the effect above reacts to it the same way whether this
              instance is root-mounted or, as here, a collection page's compact mount. Wiring a second,
              component-specific callback here would just be a second path to the same refresh. */}
          {isCollectionRoute && data.canUpload && <DropZone compact fixedCollectionId={collectionId} />}
          {/* C2/C3 (D-121): a PERMANENT root crumb (defect 8) - the old version gated the whole nav on
              breadcrumb.length > 0, so the Home control lived inside the element you needed it to escape,
              and the bar appeared/vanished as you moved, shifting the page. EVERY crumb, including the
              current location, is now a real <a href> (no .btn-ghost - a bare <a> already renders plain
              purple with no border, per mosni-chrome's base link rule) so copy-link-address, open-in-
              new-tab and refresh all work; `isPlainLeftClick` guards every one of them so a modifier or
              middle click is left to the browser instead of being swallowed. previewUrl per crumb is
              server-built (D-100) - the client only ever extracts a pathname from it, never constructs
              one. */}
          <nav aria-label="Breadcrumb" style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", alignItems: "center" }}>
            <a
              href="/"
              aria-current={collectionId === "" ? "location" : undefined}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                navigate("/");
              }}
            >
              Home
            </a>
            {data.breadcrumb.map((crumb, i) => {
              const isCurrent = i === data.breadcrumb.length - 1;
              const href = pathnameOf(crumb.previewUrl);
              return (
                <span key={crumb.id} style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                  <span aria-hidden="true">/</span>
                  <a
                    href={href}
                    aria-current={isCurrent ? "location" : undefined}
                    onClick={(event) => {
                      if (!isPlainLeftClick(event)) return;
                      event.preventDefault();
                      navigate(href);
                    }}
                  >
                    {crumb.name}
                  </a>
                </span>
              );
            })}
          </nav>

          {/* E5 Wave G (D-133), amended E5.1 Wave E+F: "Download all" - only on a collection's own page,
              only when there is at least something to archive (a file OR a nested collection - Wave F
              walks the whole subtree, so a collection holding only sub-collections must offer this too),
              and only when this browser can even run the service worker the archive depends on
              (isArchiveSupported/G1's defensive registration). Progress and the failed[] tail now live on
              the shared job stack (D-161) - not a bare text span here any more. */}
          {isCollectionRoute && (data.files.length > 0 || data.collections.length > 0) && isArchiveSupported() && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              style={{ justifySelf: "start", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
              disabled={archiveInFlight}
              onClick={() => void handleDownloadAll()}
            >
              <mosni-icon name="download" size={16} /> Download all
            </button>
          )}

          {/* E7-QA1 §C1 (F6): the collection page's own Share control - owner or superuser only
              (data.canManage, D-187: a grantee never shares). Never on the root-mounted browser - the
              root is not a collection and holds no ACL rows (D-126), and data.canManage is structurally
              false there regardless. */}
          {isCollectionRoute && data.canManage && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              style={{ justifySelf: "start", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
              onClick={() => setShareOpen(true)}
            >
              <mosni-icon name="user-plus" size={16} /> Share
            </button>
          )}
          {isCollectionRoute && (
            <ShareDialog
              type="collection"
              id={collectionId}
              objectLabel={data.breadcrumb.at(-1)?.name ?? "this collection"}
              open={shareOpen}
              onClose={() => setShareOpen(false)}
            />
          )}

          {/* E4.1 Wave E/D-79: hiding .table-col-secondary columns (mosni-chrome) still left this
              specific row (icon + name + visibility indicator + the Actions dropdown) ~46px over a
              390px viewport - tighter padding closes that gap without touching mosni-chrome's default
              (a first attempt at fixing this generically in mosni-chrome, by shrinking .table's own
              default padding, was reverted: it changed default appearance for every consumer, not just
              this table - see mosni-chrome's history). Scoped to .browse-table only. .table-scroll
              (mosni-chrome, wrapping the table below) is the actual guarantee that this page can never
              widen because of the table regardless of content - the padding here is just the common-case
              polish that avoids a scrollbar existing at all for what this page currently shows. */}
          <style>{`
            .browse-table td { white-space: nowrap; }
            @media (max-width: 480px) {
              .browse-table th, .browse-table td { padding-left: 0.4rem; padding-right: 0.4rem; }
            }
          `}</style>
          <div className="table-scroll">
            <table className="table interactive browse-table">
              <thead>
                <tr>
                  <th scope="col" aria-label="Type" />
                  <th scope="col">Name</th>
                  <th scope="col" className="table-col-secondary">Size</th>
                  <th scope="col" className="table-col-secondary">Added</th>
                  <th scope="col" aria-label="Visibility" />
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {creatingCollection && (
                  <tr>
                    <td>
                      <mosni-icon name="folder" size={18} />
                    </td>
                    <td>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <input
                          aria-label="New collection name"
                          placeholder="New collection"
                          value={newCollectionName}
                          onChange={(e) => setNewCollectionName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void submitCreateCollection();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelCreateCollection();
                            }
                          }}
                          // eslint-disable-next-line jsx-a11y/no-autofocus -- opening the row should focus the field it just revealed
                          autoFocus
                        />
                      </div>
                    </td>
                    <td className="table-col-secondary">—</td>
                    <td className="table-col-secondary">—</td>
                    <td />
                    <td>
                      <IconConfirmCancel
                        onConfirm={() => void submitCreateCollection()}
                        onCancel={cancelCreateCollection}
                        confirmDisabled={newCollectionName.trim().length === 0}
                        confirmLabel="Create collection"
                        cancelLabel="Cancel new collection"
                      />
                    </td>
                  </tr>
                )}
                {data.collections.map((row) => (
                  <CollectionRow
                    key={row.id}
                    row={row}
                    user={user}
                    onOpen={(opened) => navigate(pathnameOf(opened.previewUrl))}
                    onReload={reload}
                  />
                ))}
                {data.files.map((row) => (
                  <FileRow key={row.id} row={row} user={user} onReload={reload} />
                ))}
              </tbody>
            </table>
          </div>
          {data.collections.length === 0 && data.files.length === 0 && <p>Nothing here yet.</p>}
          {data.nextOffset !== null && (
            <button type="button" onClick={() => void loadMore()}>
              Load more
            </button>
          )}
        </>
      )}
    </div>
  );
}
