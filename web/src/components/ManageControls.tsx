// D-89: per-file management, owner-only. The full form (rename + protection + delete) lives on the
// preview page; the compact upload-completion card gets the protection selector alone (F3) - rename and
// delete belong on the file's own page, not the drop zone. D-1 is untouched: these controls only ever
// render for `context.isOwner`, so the fast path (open → drop → copy) never grows a step.

import { useState } from "react";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import type { Protection } from "../../../app/src/lib/protection.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { IconConfirmCancel, RenameInput } from "./InlineRename.tsx";
import { ProtectionControl } from "./ProtectionControl.tsx";

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
  // G2 (E5.1 Wave D, finding 8): rename parity with the collection page's C8 interaction - a pencil
  // trigger (`editingName`) reveals the shared InlineRename control, instead of an always-visible
  // input+button form. `name`/`renaming`/`renameError` keep their existing meaning and D-128 mutation-error
  // surface unchanged.
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(context.name);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function startRename() {
    setName(context.name);
    setRenameError(null);
    setEditingName(true);
  }

  function cancelRename() {
    setName(context.name);
    setRenameError(null);
    setEditingName(false);
  }

  async function submitRename() {
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
      setEditingName(false);
    } finally {
      setRenaming(false);
    }
  }

  async function changeProtection(next: Protection): Promise<boolean> {
    const res = await patchFile(context.id, { protection: next });
    if (!res.ok) {
      await toastMutationFailure(res);
      return false;
    }
    onUpdate?.(await updatedContext(res, { ...context, protection: next }));
    return true;
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
    <ProtectionControl id={context.id} protection={context.protection} onChange={changeProtection} />
  );

  if (compact) {
    return <div className="panel">{protectionSelector}</div>;
  }

  return (
    <div className="panel" style={{ display: "grid", gap: "0.85rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        {editingName ? (
          <>
            <RenameInput
              value={name}
              onChange={setName}
              onSubmit={() => void submitRename()}
              onCancel={cancelRename}
              ariaLabel="File name"
            />
            <IconConfirmCancel
              onConfirm={() => void submitRename()}
              onCancel={cancelRename}
              confirmDisabled={renaming || name === context.name}
              confirmLabel="Save name"
              cancelLabel="Cancel rename"
            />
          </>
        ) : (
          <>
            <span>{context.name}</span>
            {/* D-111: btn-icon, never a bare <button> - mosni-chrome's _button.scss styles the bare
                `button` element as a filled purple primary with no opt-out. */}
            <button type="button" className="btn-icon" aria-label="Rename" onClick={startRename}>
              <mosni-icon name="pencil" size="16" />
            </button>
          </>
        )}
      </div>
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
