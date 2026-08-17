export const CODEX_CLI_PROVIDER_ID = "codex2claude"
export const CODEX_CLI_API_KEY_ENV = "CODEX2CLAUDECODE_API_KEY"
export const CODEX_CLI_CONFIG_FILE = "~/.codex/config.toml"

const SELECTION_START = "# >>> codex2claudecode: provider selection >>>"
const SELECTION_END = "# <<< codex2claudecode: provider selection <<<"
const PROVIDER_START = "# >>> codex2claudecode: provider >>>"
const PROVIDER_END = "# <<< codex2claudecode: provider <<<"
const REPLACED_PREFIX = "# codex2claudecode replaced: "

export interface ExportConfigCodexStatic {
  base_url: string
  wire_api: string
  env_key: string
}

export const config: ExportConfigCodexStatic = {
  base_url: "http://127.0.0.1:8787/codex/v1",
  wire_api: "responses",
  env_key: CODEX_CLI_API_KEY_ENV,
}

/**
 * Codex gets its own base path. On the bare `/v1` the model list has to be told
 * apart from the Anthropic one by a header; under `/codex/v1` there is nothing to
 * disambiguate, so any OpenAI client works there too.
 */
export function codexGatewayBaseUrl(origin: string) {
  return `${origin.replace(/\/+$/, "")}/codex/v1`
}

export interface CodexCliConfigOptions {
  baseUrl?: string
  /**
   * Whether plain `codex` should route through the gateway.
   *
   * Codex binds one provider per session (`model_provider_id` lives on the thread,
   * not on a catalog entry), so the stock model names and the `codex2claude-` ones
   * cannot coexist in a single picker. Leaving this off keeps `codex` on the real
   * Codex provider and puts the gateway one command away.
   */
  makeDefault?: boolean
}

/** Top-level key that makes the gateway the provider Codex uses by default. */
export function codexCliSelectionBlock() {
  return [SELECTION_START, `model_provider = "${CODEX_CLI_PROVIDER_ID}"`, SELECTION_END].join("\n")
}

/** The provider definition itself, appended as a table at the end of the file. */
export function codexCliProviderBlock(options: CodexCliConfigOptions = {}) {
  return [
    PROVIDER_START,
    `[model_providers.${CODEX_CLI_PROVIDER_ID}]`,
    `name = "codex2claudecode"`,
    `base_url = "${options.baseUrl ?? config.base_url}"`,
    `wire_api = "${config.wire_api}"`,
    `env_key = "${config.env_key}"`,
    PROVIDER_END,
  ].join("\n")
}

/** What the setup adds to `config.toml`, for showing before it is written. */
export function codexCliConfigPreview(options: CodexCliConfigOptions = {}) {
  return options.makeDefault
    ? `${codexCliSelectionBlock()}\n\n${codexCliProviderBlock(options)}\n`
    : `${codexCliProviderBlock(options)}\n`
}

/**
 * Merges the managed blocks into an existing `config.toml`.
 *
 * `model_provider` is a top-level key, so it has to land before the first table —
 * appending it would produce invalid TOML or silently become part of the last
 * table. A previous run's blocks are replaced rather than stacked, and any
 * hand-written `model_provider` is commented out so it can be restored by hand.
 */
export function mergeCodexCliConfig(existing: string, options: CodexCliConfigOptions = {}) {
  const lines = stripManagedBlocks(existing)
    .split("\n")
    .map((line) => (line.startsWith(REPLACED_PREFIX) ? line.slice(REPLACED_PREFIX.length) : line))

  if (!options.makeDefault) {
    return `${trimTrailingBlanks(lines).join("\n")}\n\n${codexCliProviderBlock(options)}\n`
  }

  const firstTable = lines.findIndex((line) => line.trimStart().startsWith("["))
  const boundary = firstTable === -1 ? lines.length : firstTable

  const head = lines.slice(0, boundary).map((line) => (isModelProviderKey(line) ? `${REPLACED_PREFIX}${line}` : line))
  const tail = lines.slice(boundary)

  const merged = [
    ...trimTrailingBlanks(head),
    "",
    codexCliSelectionBlock(),
    "",
    ...tail,
  ].join("\n")

  return `${trimTrailingBlanks(merged.split("\n")).join("\n")}\n\n${codexCliProviderBlock(options)}\n`
}

/** Removes the managed blocks and restores whatever `model_provider` they replaced. */
export function unmergeCodexCliConfig(existing: string) {
  const lines = stripManagedBlocks(existing)
    .split("\n")
    .map((line) => (line.startsWith(REPLACED_PREFIX) ? line.slice(REPLACED_PREFIX.length) : line))
  return `${trimTrailingBlanks(lines).join("\n")}\n`
}

function stripManagedBlocks(existing: string) {
  return stripBlock(stripBlock(existing, SELECTION_START, SELECTION_END), PROVIDER_START, PROVIDER_END)
}

function stripBlock(existing: string, start: string, end: string) {
  const from = existing.indexOf(start)
  if (from === -1) return existing
  const to = existing.indexOf(end, from)
  if (to === -1) return existing
  return `${existing.slice(0, from).replace(/\n+$/, "\n")}${existing.slice(to + end.length).replace(/^\n+/, "")}`
}

function isModelProviderKey(line: string) {
  return /^\s*model_provider\s*=/.test(line)
}

function trimTrailingBlanks(lines: string[]) {
  const copy = [...lines]
  while (copy.length > 0 && copy[copy.length - 1]!.trim() === "") copy.pop()
  return copy
}
