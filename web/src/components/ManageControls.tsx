// D-89: per-file management, owner-only. The full form (protection + delete) lives on the preview page;
// the compact upload-completion card gets the protection selector alone (F3). D-1 is untouched: these
// controls only ever render for `context.isOwner`, so the fast path (open → drop → copy) never grows a
// step.
//
// E5.1 live-testing round 2 ("we do not need to show the filename twice"): rename moved OUT of this
// component entirely, into PreviewCard.tsx's own header, alongside the `<h1>` it edits - see that file.
// This component's job shrank to exactly its remaining two: protection and delete.

import { useState } from "react";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import type { Protection } from "../../../app/src/lib/protection.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { authHeaders, patchFile, updatedContext } from "../lib/filePatch.ts";
import { IconConfirmCancel } from "./InlineRename.tsx";
import { ProtectionControl } from "./ProtectionControl.tsx";

export function ManageControls({
  context,
  onUpdate,
  compact = false,
}: {
  context: PreviewContext;
  onUpdate?: (context: PreviewContext) => void;
  compact?: boolean;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 auto", minWidth: "12rem" }}>{protectionSelector}</div>

        {/* E5.1 live-testing round 2 ("bottom panel should be reworked to be more icon based"): the
            delete trigger is now a bare trash icon, not a full-width labelled button - same
            confirm/cancel icon pair the rename control uses (InlineRename.tsx), for one consistent
            "icon reveals a confirm step" interaction across the page rather than two different ones. */}
        {!confirmingDelete ? (
          <button
            type="button"
            className="btn-icon"
            aria-label="Delete file"
            onClick={() => setConfirmingDelete(true)}
          >
            <mosni-icon name="trash-2" size="16" />
          </button>
        ) : (
          <div role="alertdialog" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className="little-link" style={{ marginLeft: 0 }}>
              Delete permanently?
            </span>
            <IconConfirmCancel
              onConfirm={() => void confirmDelete()}
              onCancel={() => setConfirmingDelete(false)}
              confirmDisabled={deleting}
              confirmLabel="Yes, delete"
              cancelLabel="Cancel delete"
            />
          </div>
        )}
      </div>
    </div>
  );
}
