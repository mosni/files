// D-89: per-file management, owner-only. Lives on the preview page. D-1 is untouched: this only ever
// renders for `context.isOwner`, so the fast path (open → drop → copy) never grows a step.
//
// E5.1 live-testing round 2: rename moved OUT of this component into PreviewCard.tsx's own header,
// alongside the `<h1>` it edits ("we do not need to show the filename twice") - and delete followed it
// ("move trash next to pencil"), so this component's job shrank to exactly one thing: protection. The
// `compact` variant (the protection selector alone, with no rename/delete) is gone too - it has had no
// caller since rename/delete left, since a bare protection selector is now this component's ONLY output
// either way.

import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import type { Protection } from "../../../app/src/lib/protection.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { patchFile, updatedContext } from "../lib/filePatch.ts";
import { ProtectionControl } from "./ProtectionControl.tsx";

export function ManageControls({
  context,
  onUpdate,
}: {
  context: PreviewContext;
  onUpdate?: (context: PreviewContext) => void;
}) {
  async function changeProtection(next: Protection): Promise<boolean> {
    const res = await patchFile(context.id, { protection: next });
    if (!res.ok) {
      await toastMutationFailure(res);
      return false;
    }
    onUpdate?.(await updatedContext(res, { ...context, protection: next }));
    return true;
  }

  return (
    <div className="panel">
      <ProtectionControl id={context.id} protection={context.protection} onChange={changeProtection} />
    </div>
  );
}
