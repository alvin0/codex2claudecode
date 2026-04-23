export const LOG_BODY_PREVIEW_LIMIT = 4000

/** Maximum time (ms) to wait for the next SSE chunk from upstream before aborting. */
export const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 5 * 60_000)
