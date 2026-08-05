// Tiny, shared display-string helpers with no natural home in a single component - extracted so
// UploadStack.tsx (the archive stack item, E5.1 Wave E/F) and FileBrowser.tsx (collection-delete
// confirmation, archive "N files could not be included") say the same thing the same way instead of each
// carrying its own copy.

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
