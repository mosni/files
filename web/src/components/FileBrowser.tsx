// E4 waves D: the file browser. Renders BELOW the drop zone on `/` (D-1, D-93) - never above it, and
// never gating it: this component manages its own auth subscription independently of DropZone's, so an
// anonymous visitor's browse (D-94) is never blocked behind DropZone's own signed-out gate.
//
// D-116 (E4.1 Wave E findings): two scopes share one endpoint (§1.1) - "mine" (own things, Bearer
// required) and "visible" (everything THIS VIEWER can see: public for anonymous, public ∪ own ∪ granted
// signed in, everything for an admin because they ARE an admin). This is ONE contract decided
// server-side; the client sends the same scope for every viewer and branches on role nowhere - there is
// no client-side isFilesAdmin check anywhere in this file. A `mosni-tabs` switcher lives inside this
// section (D-93/D-102).
//
// E4.1 Wave B: the listing is a real `<table>` (D-108), one row per item; per-row actions (copy link,
// rename, protection, delete) live behind a trailing `<mosni-dropdown>` overflow menu (D-109) instead of
// always-expanded inline controls. Wave 0's write-through property setters (D-112) are what let
// `<mosni-tab>`/`<mosni-dropdown>` be written as ordinary JSX props below - see mosnicat.md.
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
import { can, isSuperuser, type Claims } from "../../../app/src/lib/roles.ts";
import type { Protection, VisibilityReason } from "../../../app/src/lib/protection.ts";
import type { BrowseCollection, BrowseFile, BrowseResponse, Scope } from "../../../app/src/lib/browseContext.ts";
import { formatUploadDate, humanSize } from "../../../app/src/lib/previewContext.ts";
import { ProtectionControl } from "./ProtectionControl.tsx";
import { VisibilityIndicator } from "./VisibilityIndicator.tsx";

type MosniUser = Claims | null;

// React 19's @types/react moved IntrinsicElements under React.JSX (see DropZone.tsx's identical note for
// mosni-login-button) - augment the "react" module's JSX namespace, not a bare global `JSX` namespace.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "mosni-tabs": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "mosni-tab": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { label?: string; selected?: boolean },
        HTMLElement
      >;
      "mosni-icon": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { name?: string; size?: string | number },
        HTMLElement
      >;
      "mosni-dropdown": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { label?: string }, HTMLElement>;
      "mosni-dropdown-item": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { value?: string; variant?: string; disabled?: boolean },
        HTMLElement
      >;
      "mosni-modal": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { heading?: string; open?: boolean },
        HTMLElement
      >;
    }
  }
}

// D-116: exactly two tabs, always. "Browse" means scope=visible for every viewer - an admin sees more
// INSIDE it because the server knows they are an admin, never because a third tab exists.
const SCOPE_TABS: { scope: Scope; label: string }[] = [
  { scope: "mine", label: "My files" },
  { scope: "visible", label: "Browse" },
];

const TABLE_COLUMN_COUNT = 6; // icon, name, size, added, visibility, actions - the colSpan an expanded row panel needs

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

// D-100: the client never constructs a URL - this only ever extracts the PATHNAME from a `previewUrl`
// the server already built (a row's own, or a breadcrumb crumb's), for use with react-router's navigate().
function pathnameOf(absoluteUrl: string): string {
  return new URL(absoluteUrl).pathname;
}

// D-121 (E4.1 Wave E findings, C3): a modified or non-primary click is the browser's to handle -
// preventDefault() here would silently break open-in-new-tab, which is half the reason breadcrumb crumbs
// and a collection's name are real <a href>s at all. Used on every such link.
function isPlainLeftClick(event: React.MouseEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
}

function currentToken(): string | null {
  return typeof window.mosni !== "undefined" ? window.mosni.token() : null;
}

// D-104: rename/protection stay owner-or-superuser only. D-115 (closes BROWSE-ADMIN-DELETE): delete is
// ADDITIONALLY offered to a files:delete holder, with the same affordance and confirmation as an owner's -
// a strictly wider gate than manage, never a separate path.
function canManage(reason: VisibilityReason, user: MosniUser): boolean {
  return reason === "own" || (user !== null && isSuperuser(user));
}

function canDelete(reason: VisibilityReason, user: MosniUser): boolean {
  return canManage(reason, user) || (user !== null && can(user, "files:delete"));
}

async function copyLinkToClipboard(url: string): Promise<void> {
  await navigator.clipboard.writeText(url);
  if (typeof window.mosni !== "undefined" && window.mosni.toast) {
    window.mosni.toast("Link copied", { variant: "success" });
  }
}

type RowPanel = "rename" | "protection" | null;

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// C8/C10 (E4.1 Wave E findings): the confirm/cancel pair for both inline rename and the new-collection
// placeholder row - same shape (two `btn-icon` buttons, check/x), different accessible names and,
// for the create case, a disabled state while the name is empty.
function IconConfirmCancel({
  onConfirm,
  onCancel,
  confirmDisabled,
  confirmLabel,
  cancelLabel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  confirmDisabled?: boolean;
  confirmLabel: string;
  cancelLabel: string;
}) {
  return (
    <>
      <button type="button" className="btn-icon" aria-label={confirmLabel} disabled={confirmDisabled} onClick={onConfirm}>
        <mosni-icon name="check" size="16" />
      </button>
      <button type="button" className="btn-icon" aria-label={cancelLabel} onClick={onCancel}>
        <mosni-icon name="x" size="16" />
      </button>
    </>
  );
}

// C8: the shared inline rename input - lives in the NAME cell while a row is being renamed. Value/onChange
// are lifted to the row component (FileRow/CollectionRow) so the confirm button in the ACTIONS cell can
// submit the same value. Enter submits, Escape cancels - there is no <form> spanning the two cells.
function RenameInput({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <input
        aria-label="New name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- opening rename should focus the field it just revealed
        autoFocus
      />
    </div>
  );
}

function RowActions({
  name,
  previewUrl,
  manage,
  mayDelete,
  onRename,
  onProtection,
  onDeleteSelected,
}: {
  name: string;
  previewUrl: string;
  manage: boolean;
  mayDelete: boolean;
  onRename: () => void;
  onProtection: () => void;
  onDeleteSelected: () => void;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onSelect(event: Event) {
      const value = (event as CustomEvent<{ value: string }>).detail.value;
      if (value === "copy") void copyLinkToClipboard(previewUrl);
      else if (value === "rename") onRename();
      else if (value === "protection") onProtection();
      else if (value === "delete") onDeleteSelected();
    }
    el.addEventListener("mosni-dropdown-select", onSelect);
    return () => el.removeEventListener("mosni-dropdown-select", onSelect);
  }, [previewUrl, onRename, onProtection, onDeleteSelected]);

  return (
    // E4.1 Wave E findings (C7, finding 3): icon-only (Wave 0.3) - just the ⋮ glyph, no visible text and
    // no chevron, so the trigger is no longer the second-widest thing in the row. `label` is no longer
    // visible text once icon-only is set, so it becomes the trigger's aria-label instead - safe to make
    // it per-row again ("Actions for <name>") since nothing renders it as literal button text anymore
    // (the old fixed "Actions" existed ONLY to avoid that - see D-79's phone-width finding).
    <mosni-dropdown ref={ref} icon-only="more-vertical" label={`Actions for ${name}`}>
      <mosni-dropdown-item value="copy">Copy link</mosni-dropdown-item>
      {manage && <mosni-dropdown-item value="rename">Rename</mosni-dropdown-item>}
      {manage && <mosni-dropdown-item value="protection">Protection</mosni-dropdown-item>}
      {mayDelete && (
        <mosni-dropdown-item value="delete" variant="danger">
          Delete
        </mosni-dropdown-item>
      )}
    </mosni-dropdown>
  );
}

function FileRow({ row, user, onReload }: { row: BrowseFile; user: MosniUser; onReload: () => void }) {
  const [panel, setPanel] = useState<RowPanel>(null);
  const [renameValue, setRenameValue] = useState(row.name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const manage = canManage(row.reason, user);
  const mayDelete = canDelete(row.reason, user);

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
    }
  }

  async function changeProtection(next: Protection): Promise<boolean> {
    const res = await fetch(`/api/files/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ protection: next }),
    });
    if (!res.ok) return false;
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
          <mosni-icon name="file" size="18" />
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
              onDeleteSelected={() => setDeleteOpen(true)}
            />
          )}
          <mosni-modal heading={`Delete "${row.name}"?`} open={deleteOpen}>
            <p>This can&apos;t be undone.</p>
            <button slot="footer" type="button" className="btn-ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </button>
            <button slot="footer" type="button" className="btn-danger" onClick={() => void confirmDelete()}>
              Yes, delete
            </button>
          </mosni-modal>
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
  const manage = canManage(row.reason, user);
  const mayDelete = canDelete(row.reason, user);

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
    }
  }

  async function changeProtection(next: Protection): Promise<boolean> {
    const res = await fetch(`/api/collections/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ protection: next }),
    });
    if (!res.ok) return false;
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
          <mosni-icon name="folder" size="18" />
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
              onDeleteSelected={() => void requestDelete()}
            />
          )}
          <mosni-modal
            heading={`Delete "${row.name}"?`}
            open={deleteOpen}
          >
            <p>
              {pending !== null && pending.collectionCount > 1 && `${pluralize(pending.collectionCount - 1, "nested collection")} and `}
              {pending !== null && pending.fileCount > 0 && `${pluralize(pending.fileCount, "file")} will also be deleted. `}
              This can&apos;t be undone.
            </p>
            <button
              slot="footer"
              type="button"
              className="btn-ghost"
              onClick={() => {
                setDeleteOpen(false);
                setPending(null);
              }}
            >
              Cancel
            </button>
            <button slot="footer" type="button" className="btn-danger" onClick={() => void confirmDelete()}>
              Yes, delete
            </button>
          </mosni-modal>
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
  const tabsRef = useRef<HTMLElement>(null);

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
    if (scope === null) return;
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
  }, [scope, collectionId, reloadKey, initialToken]);

  // D-116: Browse is always shown; My files only once signed in. No isFilesAdmin branch, and no role
  // branch of any kind - an admin sees the exact same two tabs as everyone else and sees more INSIDE
  // Browse because the server, not this filter, knows they are an admin.
  const visibleTabs = useMemo(() => SCOPE_TABS.filter((t) => t.scope === "visible" || user !== null), [user]);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    function onTabChange(event: Event) {
      const index = (event as CustomEvent<{ index: number }>).detail.index;
      const next = visibleTabs[index];
      // Tabs only ever render in root mode (see the JSX below), where collectionId is always "" - no
      // collectionId reset needed here the way the pre-Wave-C version needed one.
      if (next) setScope(next.scope);
    }
    el.addEventListener("mosni-tab-change", onTabChange);
    return () => el.removeEventListener("mosni-tab-change", onTabChange);
    // `scope` is in the dep list even though it's not read in the body: `<mosni-tabs>` only actually
    // mounts once `scope` leaves its initial `null` (the component returns just a spinner until then), so
    // without this the ref is still empty the one time `visibleTabs` settles to its post-auth value, and
    // this effect would never fire again to pick up the real node once it exists.
  }, [visibleTabs, scope]);

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
    }
  }

  function cancelCreateCollection() {
    setNewCollectionName("");
    setCreatingCollection(false);
  }

  if (scope === null) {
    return <span className="spinner" role="status" aria-label="Loading" />;
  }

  const canCreateHere = scope === "mine" && user !== null && can(user, "files:write");

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {/* Scope switching only makes sense in root mode - a collection-route mount is a fixed, specific
          collection (see the header comment), not something to browse mine/visible within. */}
      {!isCollectionRoute && authReady && visibleTabs.length > 1 && (
        // D-112 (Wave 0) gave `<mosni-tab>` a write-through `label` setter, so this is ordinary JSX now -
        // no more building an HTML string for dangerouslySetInnerHTML. `key` still forces a fresh element
        // (and so a fresh one-time render() call) when the visible tab set itself changes, e.g. once auth
        // resolves: MosniTabs.render() only runs once at connect and physically relocates its `<mosni-tab>`
        // children from then on (see session-021's log), so a later prop-only update wouldn't re-run it.
        <mosni-tabs key={visibleTabs.map((t) => t.scope).join(",")} ref={tabsRef}>
          {visibleTabs.map((tab) => (
            <mosni-tab key={tab.scope} label={tab.label} selected={scope === tab.scope} />
          ))}
        </mosni-tabs>
      )}

      {/* C9/D-117: the "Files and collections" heading is removed entirely, not moved. */}

      {canCreateHere && (
        <button
          type="button"
          className="btn-sm"
          disabled={creatingCollection}
          onClick={() => {
            setNewCollectionName("");
            setCreatingCollection(true);
          }}
        >
          <mosni-icon name="plus" size="16" /> New collection
        </button>
      )}

      {data === null ? (
        <span className="spinner" role="status" aria-label="Loading" />
      ) : (
        <>
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
                      <mosni-icon name="folder" size="18" />
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
