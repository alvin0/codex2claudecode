import type { Route_Descriptor } from "../../core/interfaces"

export interface ClaudeProxyRoute {
  family: "claude"
  endpoint: "messages" | "count_tokens"
  label: string
  path: string
  method: Route_Descriptor["method"]
  routes: Route_Descriptor[]
}

export const CLAUDE_PROXY_ROUTES: ClaudeProxyRoute[] = [
  {
    family: "claude",
    endpoint: "messages",
    label: "Messages",
    path: "/v1/messages",
    method: "POST",
    routes: [
      { path: "/v1/messages", method: "POST" },
      { path: "/v1/message", method: "POST" },
    ],
  },
  {
    family: "claude",
    endpoint: "count_tokens",
    label: "Count tokens",
    path: "/v1/messages/count_tokens",
    method: "POST",
    routes: [{ path: "/v1/messages/count_tokens", method: "POST" }],
  },
]

export const CLAUDE_MODEL_ROUTES: Route_Descriptor[] = [
  { path: "/v1/models", method: "GET" },
  { path: "/v1/models/:model_id", method: "GET" },
]
