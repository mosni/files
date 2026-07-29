// E4 waves D: the file browser. Renders BELOW the drop zone on `/` (D-1, D-93) - never above it, and
// never gating it: this component manages its own auth subscription independently of DropZone's, so an
// anonymous visitor's public browse (D-94) is never blocked behind DropZone's own signed-out gate.
//
// Three scopes share one endpoint (§1.4): "mine" (own things, Bearer required), "public" (the anonymous
// tree, D-94), "all" (the D-101 admin gate). A `mosni-tabs` switcher lives inside this section (D-93/D-102)
// - see the note above the tab bar for why `<mosni-tab>` children stay empty and the actual listing is
// rendered OUTSIDE them.

import { useEffect, useMemo, useRef, useState } from "react";
import { can, isSuperuser, isFilesAdmin, type Claims } from "../../../app/src/lib/roles.ts";
import type { Protection } from "../../../app/src/lib/protection.ts";
import type { BrowseCollection, BrowseFile, BrowseResponse, Scope } from "../../../app/src/lib/browseContext.ts";
import { humanSize } from "../../../app/src/lib/previewContext.ts";
import { CopyLink } from "./CopyLink.tsx";
import { ProtectionControl } from "./ProtectionControl.tsx";
import { VisibilityBadge } from "./VisibilityBadge.tsx";

type MosniUser = Claims | null;

// React 19's @types/react moved IntrinsicElements under React.JSX (see DropZone.tsx's identical note for
// mosni-login-button) - augment the "react" module's JSX namespace, not a bare global `JSX` namespace.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "mosni-tabs": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

const SCOPE_TABS: { scope: Scope; label: string }[] = [
  { scope: "mine", label: "My files" },
  { scope: "public", label: "Browse" },
  { scope: "all", label: "All files" },
];

function authHeaders(token: string | null): { headers: Record<string, string> } | undefined {
  return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
}

function jsonHeaders(token: string | null): Record<string, string> {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function browseUrl(scope: Scope, collectionId: string, offset: number): string {
  let url = `/api/browse?scope=${scope}`;
  if (collectionId !== "") url += `&collectionId=${encodeURIComponent(collectionId)}`;
  if (offset > 0) url += `&offset=${offset}`;
  return url;
}

function currentToken(): string | null {
  return typeof window.mosni !== "undefined" ? window.mosni.token() : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function canManage(reason: BrowseFile["reason"], user: MosniUser): boolean {
  return reason === "own" || (user !== null && isSuperuser(user));
}

// D-104: reused by both a file row and a collection row - `patchUrl` is the only thing that differs.
function RenameControl({ patchUrl, name, onRenamed }: { patchUrl: string; name: string; onRenamed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (value.trim().length === 0 || value === name) return;
    const res = await fetch(patchUrl, {
      method: "PATCH",
      headers: jsonHeaders(currentToken()),
      body: JSON.stringify({ name: value }),
    });
    if (res.ok) {
      setEditing(false);
      onRenamed();
    }
  }

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)}>
        Rename
      </button>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} style={{ display: "flex", gap: "0.35rem" }}>
      <input type="text" aria-label="New name" value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit">Save</button>
      <button type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

function FileRow({ row, user, onReload }: { row: BrowseFile; user: MosniUser; onReload: () => void }) {
  const [confirming, setConfirming] = useState(false);

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
    if (res.ok) onReload();
  }

  return (
    <div className="panel" data-row-id={row.id} style={{ display: "grid", gap: "0.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
        <a href={row.previewUrl}>{row.name}</a>
        <VisibilityBadge reason={row.reason} />
      </div>
      <p className="little-link" style={{ margin: 0 }}>
        {humanSize(row.bytes)}
      </p>
      <CopyLink previewUrl={row.previewUrl} directUrl={row.directUrl} />
      {canManage(row.reason, user) && (
        <>
          <RenameControl patchUrl={`/api/files/${row.id}`} name={row.name} onRenamed={onReload} />
          <ProtectionControl id={row.id} protection={row.effectiveProtection} onChange={changeProtection} />
          {!confirming ? (
            <button type="button" onClick={() => setConfirming(true)}>
              Delete
            </button>
          ) : (
            <div role="alertdialog" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span>Delete &quot;{row.name}&quot;? This can&apos;t be undone.</span>
              <button type="button" onClick={() => void confirmDelete()}>
                Yes, delete
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          )}
        </>
      )}
    </div>
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
  onOpen: (id: string) => void;
  onReload: () => void;
}) {
  const [pending, setPending] = useState<{ collectionCount: number; fileCount: number } | null>(null);

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

  async function requestDelete() {
    const res = await fetch(`/api/collections/${row.id}?dryRun=true`, {
      method: "DELETE",
      headers: authHeaders(currentToken())?.headers,
    });
    if (!res.ok) return;
    setPending((await res.json()) as { collectionCount: number; fileCount: number });
  }

  async function confirmDelete() {
    const res = await fetch(`/api/collections/${row.id}`, { method: "DELETE", headers: authHeaders(currentToken())?.headers });
    if (res.ok) onReload();
  }

  return (
    <div className="panel" data-row-id={row.id} style={{ display: "grid", gap: "0.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
        <button type="button" onClick={() => onOpen(row.id)}>
          {row.name}
        </button>
        <VisibilityBadge reason={row.reason} />
      </div>
      <CopyLink previewUrl={row.previewUrl} />
      {canManage(row.reason, user) && (
        <>
          <RenameControl patchUrl={`/api/collections/${row.id}`} name={row.name} onRenamed={onReload} />
          <ProtectionControl id={row.id} protection={row.effectiveProtection} onChange={changeProtection} />
          {pending === null ? (
            <button type="button" onClick={() => void requestDelete()}>
              Delete
            </button>
          ) : (
            <div role="alertdialog" style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <span>
                Delete &quot;{row.name}&quot;
                {pending.collectionCount > 1 && ` and its ${pending.collectionCount - 1} nested collections`}
                {pending.fileCount > 0 && ` and ${pending.fileCount} files`}? This can&apos;t be undone.
              </span>
              <button type="button" onClick={() => void confirmDelete()}>
                Yes, delete
              </button>
              <button type="button" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function FileBrowser({ initialScope }: { initialScope?: Scope } = {}) {
  const [user, setUser] = useState<MosniUser>(null);
  const [authReady, setAuthReady] = useState(false);
  const [scope, setScope] = useState<Scope | null>(initialScope ?? null);
  const [collectionId, setCollectionId] = useState("");
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
    void fetch(browseUrl(scope, collectionId, 0), authHeaders(currentToken()))
      .then((res) => (res.ok ? (res.json() as Promise<BrowseResponse>) : null))
      .then((json) => {
        if (!cancelled) setData(json);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, collectionId, reloadKey]);

  const visibleTabs = useMemo(
    () => SCOPE_TABS.filter((t) => t.scope === "public" || (user !== null && (t.scope === "mine" || isFilesAdmin(user)))),
    [user],
  );

  // PRODUCTION INCIDENT, 2026-07-29: mosni-chrome's real MosniTab class declares `label` as a
  // getter-only accessor (no setter). React 19 sets a custom element's props by assigning them as JS
  // properties whenever a matching accessor exists on the element's prototype, so `<mosni-tab
  // label={...}>` made React execute `element.label = value` and throw, crashing the whole page for
  // every signed-in user - invisible in every test here because ui.mosni.dev/mosnicat.js (which defines
  // the real class) never actually loads in this sandbox's e2e tier or in jsdom, so <mosni-tab> stayed an
  // inert, unupgraded element with no such accessor everywhere it was tested. Building the markup as a
  // literal HTML string and letting the browser's own parser set real ATTRIBUTES (never touching the
  // property) sidesteps React's custom-element prop-assignment path entirely - the same reason
  // <mosni-header> lives in the static index.html shell rather than JSX. Deliberately keyed on
  // `visibleTabs` alone, not the live `scope`: MosniTabs.render() only ever reads `selected` at its own
  // one-time initial connect (see the comment below) - it tracks the ACTUAL highlighted tab itself
  // afterward, so recomputing this string on every scope change would need render() to run again
  // ordinarily, but if the string comes out byte-identical (deps unchanged), React never re-touches the
  // DOM (dangerouslySetInnerHTML compares by string value, not by object identity).
  const initialTabsHtml = useMemo(
    () =>
      visibleTabs
        .map((tab) => `<mosni-tab label="${escapeHtml(tab.label)}"${scope === tab.scope ? " selected" : ""}></mosni-tab>`)
        .join(""),
    [visibleTabs],
  );

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    function onTabChange(event: Event) {
      const index = (event as CustomEvent<{ index: number }>).detail.index;
      const next = visibleTabs[index];
      if (next) {
        setScope(next.scope);
        setCollectionId("");
      }
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
    const res = await fetch(browseUrl(scope, collectionId, data.nextOffset), authHeaders(currentToken()));
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
      {authReady && visibleTabs.length > 1 && (
        // The tab bar's own children are static and empty of REACT-rendered content (never touched again
        // after this component's first render) - MosniTabs.render() runs exactly once, on connect, and
        // physically MOVES whatever is inside each <mosni-tab> into a panel div it owns from then on.
        // Handing it React-controlled content would let a later re-render try to diff nodes the custom
        // element already relocated - the same custom-element reparenting hazard that keeps <mosni-header>
        // out of React entirely (see index.html). The actual listing lives OUTSIDE the tabs, driven by the
        // `mosni-tab-change` event this component listens for instead. `key` forces a fresh element (and so
        // a fresh one-time render) if the visible tab set itself changes, e.g. once auth resolves.
        //
        // dangerouslySetInnerHTML, not JSX props, for the <mosni-tab> children themselves - see the long
        // comment on `initialTabsHtml` above for why: React 19 would otherwise crash the whole page trying
        // to assign `label` as a JS property onto mosni-chrome's real MosniTab class.
        <mosni-tabs
          key={visibleTabs.map((t) => t.scope).join(",")}
          ref={tabsRef}
          dangerouslySetInnerHTML={{ __html: initialTabsHtml }}
        />
      )}

      {data && data.breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb" style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
          <button type="button" onClick={() => setCollectionId("")}>
            Home
          </button>
          {data.breadcrumb.map((crumb) => (
            <span key={crumb.id} style={{ display: "flex", gap: "0.35rem" }}>
              /
              <button type="button" onClick={() => setCollectionId(crumb.id)}>
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      )}

      {canCreateHere && (
        <form onSubmit={(e) => void submitCreateCollection(e)} className="panel" style={{ display: "flex", gap: "0.5rem" }}>
          <input
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
          {data.collections.map((row) => (
            <CollectionRow key={row.id} row={row} user={user} onOpen={setCollectionId} onReload={reload} />
          ))}
          {data.files.map((row) => (
            <FileRow key={row.id} row={row} user={user} onReload={reload} />
          ))}
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
