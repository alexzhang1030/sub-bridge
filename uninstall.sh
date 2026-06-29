#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./uninstall.sh [options]

Stops sub-bridge services and removes the installed runtime from ~/.local.

By default keeps config (~/.config/sub-bridge) and encrypted secrets/state.

Options:
  --prefix DIR         Install prefix used by install.sh (default: ~/.local)
  --launch-agents      Unload and remove macOS LaunchAgents for cursor/codex
  --remove-config      Delete ~/.config/sub-bridge/config.json
  --purge-data         Delete secrets vault, pid/state, and logs under ~/.local/state/sub-bridge-cli
  --no-stop            Skip stopping running subscription services
  -h, --help           Show this help

Environment:
  SUB_BRIDGE_CONFIG              Config file path
  SUB_BRIDGE_INSTALL_SKIP_LAUNCHCTL=1   Skip launchctl during agent removal
USAGE
}

prefix="${PREFIX:-$HOME/.local}"
bin_dir="$prefix/bin"
lib_dir="$prefix/lib/sub-bridge"
install_bin="$bin_dir/sub-bridge"
config_path="${SUB_BRIDGE_CONFIG:-$HOME/.config/sub-bridge/config.json}"
state_root="${SUB_BRIDGE_STATE_ROOT:-$HOME/.local/state/sub-bridge-cli}"
secrets_dir="${SUB_BRIDGE_SECRETS_DIR:-$state_root/cursor-auth}"

remove_launch_agents=0
remove_config=0
purge_data=0
stop_services=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      prefix="${2:?missing value for --prefix}"
      bin_dir="$prefix/bin"
      lib_dir="$prefix/lib/sub-bridge"
      install_bin="$bin_dir/sub-bridge"
      shift 2
      ;;
    --launch-agents)
      remove_launch_agents=1
      shift
      ;;
    --remove-config)
      remove_config=1
      shift
      ;;
    --purge-data)
      purge_data=1
      shift
      ;;
    --no-stop)
      stop_services=0
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

run_installed() {
  if [ -x "$install_bin" ]; then
    "$install_bin" "$@"
    return
  fi
  if [ -f "$lib_dir/dist/cli.mjs" ]; then
    node "$lib_dir/dist/cli.mjs" "$@"
    return
  fi
  return 1
}

stop_subscription() {
  sub="$1"
  if [ "$stop_services" -eq 0 ]; then
    return 0
  fi
  run_installed --sub "$sub" stop >/dev/null 2>&1 || true
}

unload_launch_agent() {
  sub="$1"
  label="com.sub-bridge.$sub"
  plist_path="$HOME/Library/LaunchAgents/$label.plist"
  uid="$(id -u)"

  if [ "${SUB_BRIDGE_INSTALL_SKIP_LAUNCHCTL:-0}" = "1" ]; then
    echo "launchctl skipped for $label"
    return 0
  fi

  if [ "$(uname -s)" != "Darwin" ] || ! command -v launchctl >/dev/null 2>&1; then
    return 0
  fi

  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  if [ -f "$plist_path" ]; then
    rm -f "$plist_path"
    echo "removed launch agent: $plist_path"
  fi
}

if [ "$stop_services" -eq 1 ]; then
  if run_installed stop >/dev/null 2>&1; then
    echo "stopped all subscriptions"
  else
    stop_subscription cursor
    stop_subscription codex
  fi
fi

if [ "$remove_launch_agents" -eq 1 ]; then
  unload_launch_agent cursor
  unload_launch_agent codex
fi

removed=0
if [ -f "$install_bin" ]; then
  rm -f "$install_bin"
  echo "removed: $install_bin"
  removed=1
fi

if [ -d "$lib_dir" ]; then
  rm -rf "$lib_dir"
  echo "removed: $lib_dir"
  removed=1
fi

if [ "$remove_config" -eq 1 ] && [ -f "$config_path" ]; then
  rm -f "$config_path"
  echo "removed: $config_path"
  removed=1
fi

if [ "$purge_data" -eq 1 ]; then
  if [ -d "$secrets_dir" ]; then
    rm -rf "$secrets_dir"
    echo "removed secrets: $secrets_dir"
    removed=1
  fi
  if [ -d "$state_root" ]; then
    rm -rf "$state_root"
    echo "removed state: $state_root"
    removed=1
  fi
fi

if [ "$removed" -eq 0 ]; then
  echo "nothing to remove under prefix $prefix"
else
  echo "uninstall complete"
fi
