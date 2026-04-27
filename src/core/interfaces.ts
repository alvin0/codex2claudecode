import type {
  Canonical_ErrorResponse,
  Canonical_PassthroughResponse,
  Canonical_Request,
  Canonical_Response,
  Canonical_StreamResponse,
} from "./canonical"
import type { HealthStatus, RequestOptions, RequestProxyLog } from "./types"

export type UpstreamResult =
  | Canonical_Response
  | Canonical_StreamResponse
  | Canonical_ErrorResponse
  | Canonical_PassthroughResponse

export type UpstreamProviderKind = "codex" | "kiro"

export interface Upstream_Provider {
  readonly providerKind?: UpstreamProviderKind
  proxy(request: Canonical_Request, options?: RequestOptions): Promise<UpstreamResult>
  checkHealth(timeoutMs: number): Promise<HealthStatus>
  inputTokens?(request: Canonical_Request, options?: RequestOptions): Promise<Response>
  usage?(options?: RequestOptions): Promise<Response>
  environments?(options?: RequestOptions): Promise<Response>
}

export interface TokenCredentialProvider<T = unknown> {
  refresh(): Promise<T>
  readonly tokens: T
}

export interface Route_Descriptor {
  path: string
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  basePath?: string
  headerDiscriminator?: {
    name: string
    mode: "presence" | "exact"
    value?: string
  }
}

export interface Inbound_Provider {
  readonly name: string
  routes(): Route_Descriptor[]
  handle(
    request: Request,
    route: Route_Descriptor,
    upstream: Upstream_Provider,
    context: RequestHandlerContext,
  ): Promise<Response>
}

export interface RequestHandlerContext {
  requestId: string
  authFile?: string
  logBody: boolean
  quiet: boolean
  onProxy?: (entry: RequestProxyLog) => void
}

export interface Credential_Store {
  read(): Promise<unknown>
  write(credentials: unknown): Promise<void>
}
