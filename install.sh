#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

Installs sub-bridge into ~/.local/bin, configures cursor/codex subscriptions,
and refreshes GitHub Copilot provider rows when ~/.copilot/data.db exists.

Options:
  --prefix DIR       Install command into DIR/bin (default: ~/.local)
  --no-subscriptions Install the command and init config only
  --no-copilot       Skip Copilot provider rows
  --start            Start configured subscription services after install
  --launch-agent     Install macOS LaunchAgents for cursor and codex
  -h, --help         Show this help

Environment:
  SUB_BRIDGE_CONFIG              Config file path
  SUB_BRIDGE_CURSOR_ACP_COMMAND  Cursor Agent command
  SUB_BRIDGE_CURSOR_WORKSPACE    Cursor workspace path
USAGE
}

prefix="${PREFIX:-$HOME/.local}"
configure_subscriptions=1
install_copilot=1
start_services=0
install_launch_agent=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      prefix="${2:?missing value for --prefix}"
      shift 2
      ;;
    --no-subscriptions)
      configure_subscriptions=0
      shift
      ;;
    --no-copilot)
      install_copilot=0
      shift
      ;;
    --start)
      start_services=1
      shift
      ;;
    --launch-agent)
      install_launch_agent=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$configure_subscriptions" -eq 0 ] && [ "$install_launch_agent" -eq 1 ]; then
  echo "--launch-agent uses subscription configuration" >&2
  exit 2
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing command: $1" >&2
    exit 1
  fi
}

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bin_dir="$prefix/bin"
install_bin="$bin_dir/sub-bridge"
config_path="${SUB_BRIDGE_CONFIG:-$HOME/.config/sub-bridge/config.json}"
copilot_db="${SUB_BRIDGE_COPILOT_DB:-$HOME/.copilot/data.db}"

require_command node
require_command npm

node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 20) { console.error(`Node >=20 required, found ${process.version}`); process.exit(1); }'

cd "$script_dir"
npm ci

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

write_launch_agent() {
  sub="$1"
  label="com.sub-bridge.$sub"
  launch_agent_dir="$HOME/Library/LaunchAgents"
  logs_dir="$HOME/Library/Logs"
  plist_path="$launch_agent_dir/$label.plist"

  mkdir -p "$launch_agent_dir" "$logs_dir"

  escaped_label="$(xml_escape "$label")"
  escaped_bin="$(xml_escape "$install_bin")"
  escaped_sub="$(xml_escape "$sub")"
  escaped_workdir="$(xml_escape "$script_dir")"
  escaped_home="$(xml_escape "$HOME")"
  escaped_path="$(xml_escape "${PATH:-/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin}")"
  escaped_stdout="$(xml_escape "$logs_dir/$label.out.log")"
  escaped_stderr="$(xml_escape "$logs_dir/$label.err.log")"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$escaped_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$escaped_bin</string>
    <string>--sub</string>
    <string>$escaped_sub</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$escaped_workdir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$escaped_home</string>
    <key>PATH</key>
    <string>$escaped_path</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$escaped_stdout</string>
  <key>StandardErrorPath</key>
  <string>$escaped_stderr</string>
</dict>
</plist>
PLIST

  chmod 0644 "$plist_path"
  echo "launch agent: $plist_path"
}

load_launch_agent() {
  sub="$1"
  label="com.sub-bridge.$sub"
  plist_path="$HOME/Library/LaunchAgents/$label.plist"
  uid="$(id -u)"

  if [ "${SUB_BRIDGE_INSTALL_SKIP_LAUNCHCTL:-0}" = "1" ]; then
    echo "launchctl skipped for $label"
    return
  fi

  if [ "$(uname -s)" != "Darwin" ]; then
    echo "launchctl skipped for $label"
    return
  fi

  if ! command -v launchctl >/dev/null 2>&1; then
    echo "launchctl skipped for $label"
    return
  fi

  port="$("$install_bin" --sub "$sub" config get port 2>/dev/null | tr -d '"[:space:]' || true)"

  wait_for_port_release() {
    if [ -z "$port" ] || ! command -v lsof >/dev/null 2>&1; then
      sleep 2
      return
    fi
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        return
      fi
      sleep 0.25
    done
  }

  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  wait_for_port_release

  load_output=""
  for attempt in 1 2 3; do
    if load_output="$(launchctl bootstrap "gui/$uid" "$plist_path" 2>&1)"; then
      sleep 0.5
      if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
        echo "launchctl loaded: $label"
        return
      fi
      load_output="service disappeared after bootstrap"
    fi

    if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$uid/$label" >/dev/null 2>&1 || true
      echo "launchctl loaded: $label"
      return
    fi

    if [ "$attempt" -lt 3 ]; then
      sleep 0.5
      launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
      wait_for_port_release
    fi
  done

  echo "launchctl load failed for $label" >&2
  printf '%s\n' "$load_output" >&2
  return 1
}

mkdir -p "$bin_dir"
{
  echo '#!/usr/bin/env bash'
  printf 'exec node %q "$@"\n' "$script_dir/src/cli.js"
} > "$install_bin"
chmod 0755 "$install_bin"

if [ ! -f "$config_path" ]; then
  "$install_bin" config init
fi

if [ "$configure_subscriptions" -eq 1 ]; then
  "$install_bin" --sub cursor config set type cursor-acp
  "$install_bin" --sub cursor config set port 17876
  "$install_bin" --sub cursor config set providerId codexsub-openai-codex
  "$install_bin" --sub cursor config set providerName SubBridge
  "$install_bin" --sub cursor config init

  "$install_bin" --sub codex config set type codex
  "$install_bin" --sub codex config set port 17877
  "$install_bin" --sub codex config set providerId subbridge-codex
  "$install_bin" --sub codex config set providerName "SubBridge Codex"
  "$install_bin" --sub codex config init

  if [ "$install_copilot" -eq 1 ]; then
    if command -v sqlite3 >/dev/null 2>&1 && [ -f "$copilot_db" ]; then
      "$install_bin" install copilot
    else
      echo "Copilot provider rows skipped: sqlite3 or $copilot_db missing"
    fi
  fi

  if [ "$install_launch_agent" -eq 1 ]; then
    "$install_bin" --sub cursor stop || true
    "$install_bin" --sub codex stop || true
    write_launch_agent cursor
    write_launch_agent codex
    load_launch_agent cursor
    load_launch_agent codex
  elif [ "$start_services" -eq 1 ]; then
    "$install_bin" enable
  fi
else
  if [ "$install_copilot" -eq 1 ]; then
    if command -v sqlite3 >/dev/null 2>&1 && [ -f "$copilot_db" ]; then
      "$install_bin" install copilot
    else
      echo "Copilot provider rows skipped: sqlite3 or $copilot_db missing"
    fi
  fi

  if [ "$start_services" -eq 1 ]; then
    "$install_bin" enable
  fi
fi

echo "installed: $install_bin"
echo "config: $config_path"
