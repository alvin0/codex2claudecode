export const LOG_BODY_PREVIEW_LIMIT = Number(process.env.LOG_BODY_PREVIEW_LIMIT || 1_000_000)

/** Maximum time (ms) to wait for the next SSE chunk from upstream before aborting. */
export const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 5 * 60_000)
