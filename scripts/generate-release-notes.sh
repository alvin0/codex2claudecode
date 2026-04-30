#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/generate-release-notes.sh <tag> <repo> <output-file>
# Example: ./scripts/generate-release-notes.sh 0.2.3 alvin0/codex2claudecode release-notes.md

TAG="${1:?Usage: $0 <tag> <repo> <output-file>}"
REPO="${2:?Usage: $0 <tag> <repo> <output-file>}"
OUTPUT="${3:?Usage: $0 <tag> <repo> <output-file>}"
VERSION="${TAG#v}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

cat > "${OUTPUT}" <<EOF
## Standalone Binaries

Pre-built binaries that run without any runtime dependencies (no Bun, Node.js, npx, or bunx required).

### Quick Install

**macOS (Apple Silicon)**
\`\`\`bash
curl -fsSL ${BASE}/codex2claudecode-darwin-arm64.tar.gz | tar xz
chmod +x codex2claudecode-darwin-arm64
./codex2claudecode-darwin-arm64
\`\`\`

**macOS (Intel)**
\`\`\`bash
curl -fsSL ${BASE}/codex2claudecode-darwin-x64.tar.gz | tar xz
chmod +x codex2claudecode-darwin-x64
./codex2claudecode-darwin-x64
\`\`\`

**Linux (x64)**
\`\`\`bash
curl -fsSL ${BASE}/codex2claudecode-linux-x64.tar.gz | tar xz
chmod +x codex2claudecode-linux-x64
./codex2claudecode-linux-x64
\`\`\`

**Linux (ARM64)**
\`\`\`bash
curl -fsSL ${BASE}/codex2claudecode-linux-arm64.tar.gz | tar xz
chmod +x codex2claudecode-linux-arm64
./codex2claudecode-linux-arm64
\`\`\`

**Windows (x64, PowerShell)**
\`\`\`powershell
Invoke-WebRequest -Uri "${BASE}/codex2claudecode-windows-x64.exe.zip" -OutFile codex2claudecode.zip
Expand-Archive codex2claudecode.zip -DestinationPath .
.\codex2claudecode-windows-x64.exe
\`\`\`

### One-liner Install to /usr/local/bin (Linux/macOS)

\`\`\`bash
curl -fsSL ${BASE}/codex2claudecode-\$(uname -s | tr '[:upper:]' '[:lower:]')-\$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/').tar.gz | sudo tar xz -C /usr/local/bin
\`\`\`

### Verify Download

\`\`\`bash
# Linux
sha256sum -c SHA256SUMS.txt

# macOS
shasum -a 256 -c SHA256SUMS.txt
\`\`\`

### npm Install (requires Bun runtime)

\`\`\`bash
npm install -g codex2claudecode@${VERSION}
\`\`\`
EOF

echo "Release notes written to ${OUTPUT}"
