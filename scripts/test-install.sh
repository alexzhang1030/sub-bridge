#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
tmp_home="$(mktemp -d)"
tmp_prefix="$(mktemp -d)"

cleanup() {
  rm -rf "$tmp_home" "$tmp_prefix"
}
trap cleanup EXIT

HOME="$tmp_home" \
PREFIX="$tmp_prefix" \
SUB_BRIDGE_OFFLINE=1 \
SUB_BRIDGE_INSTALL_SKIP_LAUNCHCTL=1 \
"$repo_dir/install.sh" --launch-agent --no-copilot

installed_bin="$tmp_prefix/bin/sub-bridge"
cursor_plist="$tmp_home/Library/LaunchAgents/com.sub-bridge.cursor.plist"
codex_plist="$tmp_home/Library/LaunchAgents/com.sub-bridge.codex.plist"

test -x "$installed_bin"
test -f "$cursor_plist"
test -f "$codex_plist"

root_keys="$(HOME="$tmp_home" "$installed_bin" config show | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => console.log(Object.keys(JSON.parse(s).file).join(",")));')"
cursor_type="$(HOME="$tmp_home" "$installed_bin" --sub cursor config get type)"
codex_type="$(HOME="$tmp_home" "$installed_bin" --sub codex config get type)"
cursor_provider_id="$(HOME="$tmp_home" "$installed_bin" --sub cursor config get providerId)"
codex_provider_id="$(HOME="$tmp_home" "$installed_bin" --sub codex config get providerId)"
cursor_keys="$(HOME="$tmp_home" "$installed_bin" --sub cursor config show | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => console.log(Object.keys(JSON.parse(s).file.subscriptions.cursor).join(",")));')"

test "$root_keys" = '$schema,version,subscriptions'
test "$cursor_type" = '"cursor-acp"'
test "$codex_type" = '"codex"'
test "$cursor_provider_id" = '"codexsub-openai-codex"'
test "$codex_provider_id" = '"subbridge-codex"'
test "$cursor_keys" = 'type,host,port,models,providerId,providerName'

HOME="$tmp_home" "$installed_bin" --sub cursor config get models | grep -q '"id": "gpt-5.5"'
HOME="$tmp_home" "$installed_bin" --sub codex config get models | grep -q '"id": "gpt-5.5"'

grep -q '<string>cursor</string>' "$cursor_plist"
grep -q '<string>codex</string>' "$codex_plist"

echo "install smoke passed"
