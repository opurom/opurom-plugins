#!/usr/bin/env bash
# Build the reference plugins and place each executable next to its manifest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v cargo >/dev/null 2>&1; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

for name in camera geolocation bluetooth notification payment share storage; do
  cargo build --release --manifest-path "$ROOT/plugins/$name/Cargo.toml"
  mkdir -p "$ROOT/plugins/$name/bin"
  cp "$ROOT/plugins/$name/target/release/$name" "$ROOT/plugins/$name/bin/$name"
  chmod +x "$ROOT/plugins/$name/bin/$name"
  echo "built plugins/$name/bin/$name"
done
