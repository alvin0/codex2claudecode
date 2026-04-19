export function claudeErrorResponse(message: string, status: number) {
  return Response.json(
    {
      type: "error",
      error: {
        type: status === 400 ? "invalid_request_error" : "api_error",
        message,
      },
    },
    { status },
  )
}
