// E4 waves D: the file browser. Renders BELOW the drop zone on `/` (D-1, D-93) - never above it, and
// never gating it: this component manages its own auth subscription independently of DropZone's, so an
// anonymous visitor's public browse (D-94) is never blocked behind DropZone's own signed-out gate.
//
// Three scopes share one endpoint (§1.4): "mine" (own things, Bearer required), "public" (the anonymous
// tree, D-94), "all" (the D-101 admin gate). A `mosni-tabs` switcher lives inside this section (D-93/D-102).
//
// E4.1 Wave B: the listing is a real `<table>` (D-108), one row per item; per-row actions (copy link,
// rename, protection, delete) live behind a trailing `<mosni-dropdown>` overflow menu (D-109) instead of
// always-expanded inline controls. Wave 0's write-through property setters (D-112) are what let
// `<mosni-tab>`/`<mosni-dropdown>` be written as ordinary JSX props below - see mosnicat.md.
//
// E4.1 Wave C (D-107 client half): mounted two ways now. On `/` with no `initialCollectionId`, this owns
// its own scope (mine/public/all) exactly as before. Mounted by pages/Preview.tsx on `/f/*`/`/t/:token`
// with a server-RESOLVED `initialCollectionId`, it shows that one collection under scope=public only (the
// scope E4.1 Wave C extended to also authorize an owner/superuser/ACL-grant/token viewer, not just a
// literally-public chain - see controllers/browse.ts) and never switches scope or drills via local state:
// every collection click is a REAL navigation (`useNavigate`), and `pages/Preview.tsx` remounts this
// component fresh (via `key`) once it re-resolves a different collection - see that file's comment.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { can, isSuperuser, isFilesAdmin, type Claims } from "../../../app/src/lib/roles.ts";
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

const SCOPE_TABS: { scope: Scope; label: string }[] = [
  { scope: "mine", label: "My files" },
  { scope: "public", label: "Browse" },
  { scope: "all", label: "All files" },
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

// D-104: reused by both a file row and a collection row - `patchUrl` is the only thing that differs. Now
// always rendered already in "editing" shape (Wave B4) - the dropdown's "Rename" item is what opens it;
// this component no longer owns its own open/closed toggle.
function RenameForm({
  patchUrl,
  name,
  onRenamed,
  onCancel,
}: {
  patchUrl: string;
  name: string;
  onRenamed: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(name);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (value.trim().length === 0 || value === name) return;
    const res = await fetch(patchUrl, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ name: value }),
    });
    if (res.ok) onRenamed();
  }

  return (
    <form onSubmit={(e) => void submit(e)} style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
      <label htmlFor="row-rename-input" className="little-link">
        New name
      </label>
      <input id="row-rename-input" type="text" aria-label="New name" value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="btn-sm">
        Save
      </button>
      <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

type RowPanel = "rename" | "protection" | null;

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function RowActions({
  previewUrl,
  manage,
  mayDelete,
  onRename,
  onProtection,
  onDeleteSelected,
}: {
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
    // E4.1 Wave E/D-79: `label` becomes the trigger's VISIBLE text (mosni-chrome's dropdown.ts appends it
    // as a text node, matching its own docs example, label="Actions") - it is not an aria-label-only
    // accessible-name slot. A per-row "Actions for <name>" here rendered the whole file/collection name as
    // literal button text, which is exactly what broke the phone-width table (D-79's overflow check caught
    // it on a long name). Every row already sits in a labeled table row, so a fixed "Actions" carries
    // enough context.
    <mosni-dropdown ref={ref} label="Actions">
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const manage = canManage(row.reason, user);
  const mayDelete = canDelete(row.reason, user);

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
          <a href={row.previewUrl}>{row.name}</a>
        </td>
        <td className="table-col-secondary">{humanSize(row.bytes)}</td>
        <td className="table-col-secondary">{formatUploadDate(row.createdAt)}</td>
        <td>
          <VisibilityIndicator reason={row.reason} />
        </td>
        <td>
          <RowActions
            previewUrl={row.previewUrl}
            manage={manage}
            mayDelete={mayDelete}
            onRename={() => setPanel("rename")}
            onProtection={() => setPanel("protection")}
            onDeleteSelected={() => setDeleteOpen(true)}
          />
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
      {panel === "rename" && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT}>
            <RenameForm
              patchUrl={`/api/files/${row.id}`}
              name={row.name}
              onRenamed={() => {
                setPanel(null);
                onReload();
              }}
              onCancel={() => setPanel(null)}
            />
          </td>
        </tr>
      )}
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
  const [pending, setPending] = useState<{ collectionCount: number; fileCount: number } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const manage = canManage(row.reason, user);
  const mayDelete = canDelete(row.reason, user);

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
          <button type="button" className="btn-ghost" onClick={() => onOpen(row)}>
            {row.name}
          </button>
        </td>
        <td className="table-col-secondary">{"—" /* D-110: collections are not files - no size to show */}</td>
        <td className="table-col-secondary">{"—" /* BrowseCollection carries no date */}</td>
        <td>
          <VisibilityIndicator reason={row.reason} />
        </td>
        <td>
          <RowActions
            previewUrl={row.previewUrl}
            manage={manage}
            mayDelete={mayDelete}
            onRename={() => setPanel("rename")}
            onProtection={() => setPanel("protection")}
            onDeleteSelected={() => void requestDelete()}
          />
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
      {panel === "rename" && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT}>
            <RenameForm
              patchUrl={`/api/collections/${row.id}`}
              name={row.name}
              onRenamed={() => {
                setPanel(null);
                onReload();
              }}
              onCancel={() => setPanel(null)}
            />
          </td>
        </tr>
      )}
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
  const [scope, setScope] = useState<Scope | null>(isCollectionRoute ? "public" : (initialScope ?? null));
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [newCollectionName, setNewCollectionName] = useState("");
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

  // Default scope, once we know who is looking: an anonymous visitor starts on the public tree (D-94);
  // anyone signed in starts on their own things. `initialScope` (used by tests, and available to a future
  // caller) skips this and is never overridden afterward.
  useEffect(() => {
    if (initialScope !== undefined || !authReady || scope !== null) return;
    setScope(user !== null ? "mine" : "public");
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

  const visibleTabs = useMemo(
    () => SCOPE_TABS.filter((t) => t.scope === "public" || (user !== null && (t.scope === "mine" || isFilesAdmin(user)))),
    [user],
  );

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

  async function submitCreateCollection(event: React.FormEvent) {
    event.preventDefault();
    const name = newCollectionName.trim();
    if (name.length === 0) return;
    const res = await fetch("/api/collections", {
      method: "POST",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ name, parentId: collectionId || undefined }),
    });
    if (res.ok) {
      setNewCollectionName("");
      reload();
    }
  }

  if (scope === null) {
    return <span className="spinner" role="status" aria-label="Loading" />;
  }

  const canCreateHere = scope === "mine" && user !== null && can(user, "files:write");

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {/* Scope switching only makes sense in root mode - a collection-route mount is a fixed, specific
          collection (see the header comment), not something to browse mine/public/all within. */}
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

      <h2>Files and collections</h2>

      {canCreateHere && (
        <form onSubmit={(e) => void submitCreateCollection(e)} className="panel" style={{ display: "flex", gap: "0.5rem" }}>
          <label htmlFor="new-collection-name-input" className="little-link">
            New collection name
          </label>
          <input
            id="new-collection-name-input"
            type="text"
            aria-label="New collection name"
            placeholder="New collection name"
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.target.value)}
          />
          <button type="submit" className="btn">
            Create collection
          </button>
        </form>
      )}

      {data === null ? (
        <span className="spinner" role="status" aria-label="Loading" />
      ) : (
        <>
          {/* C3: a PERMANENT root crumb (defect 8) - the old version gated the whole nav on
              breadcrumb.length > 0, so the Home control lived inside the element you needed it to escape,
              and the bar appeared/vanished as you moved, shifting the page. C4: ancestor crumbs are real
              links (`.btn-ghost`, never a filled `<button>`); the current location is plain text, not a
              control. previewUrl per crumb is server-built (D-100) - the client only ever extracts a
              pathname from it, never constructs one. */}
          <nav aria-label="Breadcrumb" style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", alignItems: "center" }}>
            {collectionId === "" ? (
              <span aria-current="location">Home</span>
            ) : (
              <a
                href="/"
                className="btn-ghost"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("/");
                }}
              >
                Home
              </a>
            )}
            {data.breadcrumb.map((crumb, i) => {
              const isCurrent = i === data.breadcrumb.length - 1;
              const href = pathnameOf(crumb.previewUrl);
              return (
                <span key={crumb.id} style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                  <span aria-hidden="true">/</span>
                  {isCurrent ? (
                    <span aria-current="location">{crumb.name}</span>
                  ) : (
                    <a
                      href={href}
                      className="btn-ghost"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(href);
                      }}
                    >
                      {crumb.name}
                    </a>
                  )}
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
