export function responseHeaders(input: Headers) {
  const headers = new Headers(input)
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.delete("connection")
  headers.delete("keep-alive")
  headers.delete("set-cookie")
  headers.delete("set-cookie2")
  headers.delete("transfer-encoding")
  return headers
}

export function cors(response: Response) {
  response.headers.set("access-control-allow-origin", "*")
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS")
  response.headers.set("access-control-allow-headers", "*")
  return response
}
