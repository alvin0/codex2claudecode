export function claudeErrorResponse(message: string, status: number) {
  return Response.json(claudeErrorBody(message, status), { status })
}

export function claudeStreamErrorEvent(message: string, status = 500) {
  return `event: error\ndata: ${JSON.stringify(claudeErrorBody(message, status))}\n\n`
}

export function claudeErrorBody(message: string, status: number) {
  return {
    type: "error",
    error: {
      type: claudeErrorType(status),
      message,
    },
  }
}

function claudeErrorType(status: number) {
  if (status === 400) return "invalid_request_error"
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 413) return "request_too_large"
  if (status === 429) return "rate_limit_error"
  if (status === 529) return "overloaded_error"
  return "api_error"
}
