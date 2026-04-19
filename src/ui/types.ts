export interface AccountView {
  key: string
  name: string
  email?: string
  accountId?: string
  plan?: string
}

export type RuntimeState =
  | { status: "starting" }
  | { status: "running"; server: ReturnType<typeof Bun.serve>; startedAt: number }
  | { status: "error"; error: string }
