// Single source of truth for the upload chunk size, owned by the server and read by the client at
// runtime via GET /api/config (and imported directly as a compile-time fallback). This exists because the
// chunk size and the tus rate-limit budget are coupled - a smaller chunk means more PATCH requests per
// upload, so the dedicated 600/min limit in routes/upload.ts is sized against exactly this value. Keeping
// the number in one server-owned place stops the client and the rate limit from silently drifting apart
// (preliminary-review P10).

// 5 MB. A 5 GB upload is then ~1000 PATCH requests, which is what routes/upload.ts's 600/min dedicated
// limiter is budgeted for. Change it HERE and the rate-limit comment there is the one place to re-check
// - and now also UPLOAD_MAX_CONCURRENT below, since concurrent uploads multiply the PATCH rate too.
export const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;

// E6 (D-174): how long a partial upload survives in STORAGE_ROOT/.tus before @tus/server's own sweep
// removes it. 7 days - long enough that a paused upload someone forgot about for a weekend still resumes,
// short enough that abandoned partials do not accumulate forever on the box.
export const UPLOAD_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// E6 Wave C: at most this many tus uploads run at once per batch: the rest sit as `queued` jobs and start
// as slots free. Bounds how hard a big folder drop hits the box at once.
export const UPLOAD_MAX_CONCURRENT = 3;

// E6 Wave B (D-173): retry backoff for a dropped connection, summing to ~103s across five attempts - the
// "~2 minutes" Hannah asked for ("retry sounds like it's starting fresh" - the control stays labelled
// Resume, never Retry), without a sixth attempt pushing past two minutes.
export const UPLOAD_RETRY_DELAYS = [0, 3_000, 10_000, 30_000, 60_000] as const;
