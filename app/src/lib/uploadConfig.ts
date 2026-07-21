// Single source of truth for the upload chunk size, owned by the server and read by the client at
// runtime via GET /api/config (and imported directly as a compile-time fallback). This exists because the
// chunk size and the tus rate-limit budget are coupled - a smaller chunk means more PATCH requests per
// upload, so the dedicated 600/min limit in routes/upload.ts is sized against exactly this value. Keeping
// the number in one server-owned place stops the client and the rate limit from silently drifting apart
// (preliminary-review P10).

// 5 MB. A 5 GB upload is then ~1000 PATCH requests, which is what routes/upload.ts's 600/min dedicated
// limiter is budgeted for. Change it HERE and the rate-limit comment there is the one place to re-check.
export const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;
