#!/usr/bin/env bash
#
# LACT WebUI installer.
#
# Installs the LACT daemon and the web UI, then creates the first administrator account.
# Everything before the account step runs as root: the script elevates itself with sudo (you will
# be asked for your password once) so the service files and the account database stay root-owned
# with mode 0600.
#
#   ./scripts/install.sh                 # build from source, then install
#   ./scripts/install.sh --prefix /usr   # custom prefix (default /usr)
#   ./scripts/install.sh --no-build      # use an existing target/release build
#   ./scripts/install.sh --listen 0.0.0.0:12800
#   ./scripts/install.sh --skip-account  # create the admin account later
#
set -euo pipefail

PREFIX=/usr
LISTEN=0.0.0.0:12800
BUILD=1
CREATE_ACCOUNT=1
USERS_FILE=/etc/lact/webui-users.yaml
CONFIG_FILE=/etc/lact/webui.yaml

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --listen) LISTEN="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --skip-account) CREATE_ACCOUNT=0; shift ;;
    --users-file) USERS_FILE="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# 1. Elevation
# ---------------------------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null || die "root is required and sudo is not available"
  info "root is required to install services and create the account database"
  echo "    (you will be asked for your sudo password)"
  exec sudo --preserve-env=PATH "$0" "$@"
fi

# ---------------------------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------------------------
if [[ $BUILD -eq 1 ]]; then
  command -v cargo >/dev/null || die "cargo not found — install Rust or rerun with --no-build"
  info "building lactd launcher and lact-webui (release)"
  ( cd "$REPO_ROOT" && cargo build --release -p lact-webui -p lact --no-default-features --features webui )
fi

BIN_DIR="$REPO_ROOT/target/release"
[[ -x "$BIN_DIR/lact-webui" ]] || die "missing $BIN_DIR/lact-webui (build first, or drop --no-build)"
[[ -x "$BIN_DIR/lact" ]] || die "missing $BIN_DIR/lact (build first, or drop --no-build)"

# ---------------------------------------------------------------------------------------------
# 3. Files
# ---------------------------------------------------------------------------------------------
info "installing binaries into $PREFIX/bin"
install -Dm755 "$BIN_DIR/lact"         "$PREFIX/bin/lact"
install -Dm755 "$BIN_DIR/lact-webui"   "$PREFIX/bin/lact-webui"

info "installing systemd units"
install -Dm644 "$REPO_ROOT/res/lactd.service"      "/lib/systemd/system/lactd.service"
install -Dm644 "$REPO_ROOT/res/lact-webui.service" "/lib/systemd/system/lact-webui.service"

install -d -m 0755 /etc/lact

if [[ ! -f "$CONFIG_FILE" ]]; then
  info "writing $CONFIG_FILE"
  cat >"$CONFIG_FILE" <<EOF
# LACT WebUI configuration. See docs/WEBUI.md for every option.
listen: $LISTEN

auth:
  users_file: $USERS_FILE
  # Failed logins per IP before the client is blocked.
  max_attempts: 5
  attempt_window_secs: 60

session_timeout_hours: 12
refresh_interval_ms: 1000
EOF
  chmod 0644 "$CONFIG_FILE"
else
  info "keeping existing $CONFIG_FILE"
fi

# ---------------------------------------------------------------------------------------------
# 4. First administrator
# ---------------------------------------------------------------------------------------------
if [[ $CREATE_ACCOUNT -eq 1 ]]; then
  if lact-webui --list-users --users-file "$USERS_FILE" 2>/dev/null | grep -q 'admin'; then
    info "an administrator already exists in $USERS_FILE — not touching it"
  else
    echo
    info "create the first administrator account"
    read -r -p "    username [admin]: " ADMIN_USER
    ADMIN_USER="${ADMIN_USER:-admin}"
    # `lact-webui --add-user` prompts for the password twice, without echoing it.
    lact-webui --add-user "$ADMIN_USER" --role admin --users-file "$USERS_FILE"
    chmod 0600 "$USERS_FILE"
  fi
fi

# ---------------------------------------------------------------------------------------------
# 5. Services
# ---------------------------------------------------------------------------------------------
info "enabling lactd and lact-webui"
systemctl daemon-reload
systemctl enable --now lactd.service
systemctl enable --now lact-webui.service

sleep 1
if systemctl is-active --quiet lactd.service; then
  info "lactd is running"
else
  warn "lactd is not running — check: journalctl -u lactd -n 40"
fi

if systemctl is-active --quiet lact-webui.service; then
  info "lact-webui is running"
else
  warn "lact-webui is not running — check: journalctl -u lact-webui -n 40"
fi

HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
PORT="${LISTEN##*:}"
echo
info "done. Open:  http://${HOSTNAME_SHORT}:${PORT}"
echo "    Accounts:  lact-webui --list-users"
echo "    Roles:     admin (full control) · operator (monitoring only)"
echo "    Docs:      $REPO_ROOT/docs/WEBUI.md"
