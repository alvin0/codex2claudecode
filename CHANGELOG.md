# Changelog

## Unreleased

### Breaking Changes

- codex2claudecode now runs the application with Bun and requires Bun `>=1.3.0` at runtime.
- The npm/npx binary is a compatibility launcher that checks for Bun, falls back to `npx --yes bun@latest` when no local Bun is available, and prints install instructions when no usable Bun can be started.

### Migration Notes

- Install Bun before upgrading existing Node-only environments:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```

- Windows PowerShell:

  ```powershell
  powershell -c "irm bun.sh/install.ps1 | iex"
  ```
