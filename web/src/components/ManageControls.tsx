// D-89: per-file management, owner-only. The full form (rename + protection + delete) lives on the
// preview page; the compact upload-completion card gets the protection selector alone (F3) - rename and
// delete belong on the file's own page, not the drop zone. D-1 is untouched: these controls only ever
// render for `context.isOwner`, so the fast path (open → drop → copy) never grows a step.

import { useState } from "react";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import type { Protection } from "../../../app/src/lib/protection.ts";

const PROTECTION_LEVELS: readonly Protection[] = ["public", "unlisted", "secret", "private"];

// F2: mosni-chrome ships no select component - a native <select> inside the existing `.panel` (which
// already styles the inputs it contains) is the F2-sanctioned choice; a reusable control is an upstream
// mosni-chrome change under D-31, deliberately out of scope here.
const PROTECTION_EXPLANATION: Record<Protection, string> = {
  public: "Listed and visible to anyone, including search engines.",
  unlisted: "Not listed, but the link works for anyone who has it.",
  secret: "The readable link doesn't work - only the short token link does.",
  private: "Only you, and anyone you've granted access, can open it - even with a link.",
};

function authHeaders(): Record<string, string> {
  const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function patchFile(id: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`/api/files/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
}

// A rename or a protection change retires the file's previewUrl/directUrl - `secret` moves both links
// onto /t/<token>, and `private` needs a freshly signed directUrl for its bytes to keep rendering. The
// client cannot recompute either (it never sees the link_token), so the PATCH response carries the whole
// updated context and it is applied wholesale. Patching only the field we sent would leave the copy
// control offering the URL the change just retired.
async function updatedContext(res: Response, fallback: PreviewContext): Promise<PreviewContext> {
  try {
    return (await res.json()) as PreviewContext;
  } catch {
    return fallback; // a body we can't read must not wipe the rendered state
  }
}

export function ManageControls({
  context,
  onUpdate,
  compact = false,
}: {
  context: PreviewContext;
  onUpdate?: (context: PreviewContext) => void;
  compact?: boolean;
}) {
  const [name, setName] = useState(context.name);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [protection, setProtection] = useState<Protection>(context.protection);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function submitRename(event: React.FormEvent) {
    event.preventDefault();
    if (name === context.name || renaming) return;

    setRenaming(true);
    setRenameError(null);
    try {
      const res = await patchFile(context.id, { name });
      if (res.status === 409) {
        setRenameError(`"${name}" is already used here - choose another name.`);
        return;
      }
      // The server validates a display name exactly as it validates an uploaded filename (it becomes a
      // URL segment), so say which shapes are rejected rather than the generic failure.
      if (res.status === 400) {
        setRenameError("That name can't be used - no slashes, and no leading or trailing spaces.");
        return;
      }
      if (!res.ok) {
        setRenameError("Rename failed.");
        return;
      }
      onUpdate?.(await updatedContext(res, { ...context, name }));
    } finally {
      setRenaming(false);
    }
  }

  async function changeProtection(next: Protection) {
    const previous = protection;
    setProtection(next);
    const res = await patchFile(context.id, { protection: next });
    if (!res.ok) {
      setProtection(previous); // the request failed - don't leave the control lying about the real state
      return;
    }
    onUpdate?.(await updatedContext(res, { ...context, protection: next }));
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/files/${context.id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        window.location.assign("/");
      }
    } finally {
      setDeleting(false);
    }
  }

  const protectionSelector = (
    <div>
      <label
        htmlFor={`protection-select-${context.id}`}
        style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.35rem", color: "var(--mosni-text-muted)" }}
      >
        Who can access this
      </label>
      <select
        id={`protection-select-${context.id}`}
        value={protection}
        onChange={(event) => void changeProtection(event.target.value as Protection)}
      >
        {PROTECTION_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <p className="little-link" style={{ margin: "0.35rem 0 0" }}>
        {PROTECTION_EXPLANATION[protection]}
      </p>
    </div>
  );

  if (compact) {
    return <div className="panel">{protectionSelector}</div>;
  }

  return (
    <div className="panel" style={{ display: "grid", gap: "0.85rem" }}>
      <form
        onSubmit={(event) => void submitRename(event)}
        style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
      >
        <input
          type="text"
          value={name}
          aria-label="File name"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="btn" disabled={renaming || name === context.name}>
          Rename
        </button>
      </form>
      {renameError !== null && <p role="alert">{renameError}</p>}

      {protectionSelector}

      {!confirmingDelete ? (
        <button type="button" className="btn" onClick={() => setConfirmingDelete(true)}>
          Delete file
        </button>
      ) : (
        <div role="alertdialog" style={{ display: "grid", gap: "0.5rem" }}>
          <p>Delete this file permanently? This can&apos;t be undone.</p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" className="btn" disabled={deleting} onClick={() => void confirmDelete()}>
              Yes, delete
            </button>
            <button type="button" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
