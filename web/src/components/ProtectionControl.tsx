// D-89's protection selector, extracted so D-104's browse rows can reuse it verbatim rather than
// FileBrowser.tsx growing a second one. `onChange` does the actual PATCH (a file's own /api/files/:id,
// a collection's /api/collections/:id, or - for a browse row - a PATCH followed by a listing reload) and
// reports whether it was applied; this component only ever renders and reverts, it never picks the URL.

import { useEffect, useState } from "react";
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

export function ProtectionControl({
  id,
  protection,
  onChange,
}: {
  id: string;
  protection: Protection;
  onChange: (next: Protection) => Promise<boolean>;
}) {
  const [value, setValue] = useState<Protection>(protection);

  // A reload (FileBrowser refetches the whole listing after any mutation) hands this component a fresh
  // `protection` prop rather than mutating this one in place - sync local state to it so the control keeps
  // reflecting the server's actual current value, not a stale render's.
  useEffect(() => {
    setValue(protection);
  }, [protection]);

  async function apply(next: Protection) {
    const previous = value;
    setValue(next);
    const applied = await onChange(next);
    if (!applied) setValue(previous); // the request failed - don't leave the control lying about the real state
  }

  return (
    <div>
      <label
        htmlFor={`protection-select-${id}`}
        style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.35rem", color: "var(--mosni-text-muted)" }}
      >
        Who can access this
      </label>
      <select
        id={`protection-select-${id}`}
        value={value}
        onChange={(event) => void apply(event.target.value as Protection)}
      >
        {PROTECTION_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <p className="little-link" style={{ margin: "0.35rem 0 0" }}>
        {PROTECTION_EXPLANATION[value]}
      </p>
    </div>
  );
}
