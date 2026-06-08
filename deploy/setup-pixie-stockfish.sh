#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root: sudo bash deploy/setup-pixie-stockfish.sh" >&2
  exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/dieutx/pixie-fen-auto.git}"
REPO_DIR="${REPO_DIR:-/root/claude/pixie-fen-auto}"
SERVICE_NAME="${SERVICE_NAME:-pixie-stockfish}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8777}"
ENGINE_THREADS="${ENGINE_THREADS:-20}"
ENGINE_THREADS_FAST="${ENGINE_THREADS_FAST:-$ENGINE_THREADS}"
ENGINE_THREADS_STRONG="${ENGINE_THREADS_STRONG:-$ENGINE_THREADS}"
ENGINE_THREADS_MAX="${ENGINE_THREADS_MAX:-$ENGINE_THREADS}"
ENGINE_HASH_MB="${ENGINE_HASH_MB:-1024}"
ENGINE_POOL_SIZE="${ENGINE_POOL_SIZE:-1}"
MAX_ENGINE_QUEUE="${MAX_ENGINE_QUEUE:-1}"
MAX_MOVETIME="${MAX_MOVETIME:-5000}"
MAX_MULTIPV="${MAX_MULTIPV:-1}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-9000}"
SYZYGY_PATH="${SYZYGY_PATH:-/opt/syzygy/3-4-5:/opt/syzygy/6-man}"
SERVER_NAME="${SERVER_NAME:-_}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
NODE_MAJOR="${NODE_MAJOR:-24}"
INSTALL_NGINX="${INSTALL_NGINX:-1}"
INSTALL_NODE="${INSTALL_NODE:-1}"
INSTALL_STOCKFISH="${INSTALL_STOCKFISH:-1}"
STOCKFISH_PATH="${STOCKFISH_PATH:-}"
NODE_PATH="${NODE_PATH:-}"

export REPO_DIR SERVICE_NAME HOST PORT STOCKFISH_PATH NODE_PATH
export ENGINE_THREADS ENGINE_THREADS_FAST ENGINE_THREADS_STRONG ENGINE_THREADS_MAX
export ENGINE_HASH_MB ENGINE_POOL_SIZE MAX_ENGINE_QUEUE MAX_MOVETIME MAX_MULTIPV REQUEST_TIMEOUT SYZYGY_PATH

log() {
  printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

install_base_packages() {
  log "Installing base packages"
  apt-get update
  apt-get install -y git curl ca-certificates gnupg build-essential nginx
}

install_node_if_needed() {
  if [[ -n "$NODE_PATH" && -x "$NODE_PATH" ]]; then
    log "Using provided NODE_PATH=$NODE_PATH"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    NODE_PATH="$(command -v node)"
    log "Found node at $NODE_PATH"
    return
  fi

  if [[ "$INSTALL_NODE" != "1" ]]; then
    echo "node is not installed and INSTALL_NODE=0" >&2
    exit 1
  fi

  log "Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  NODE_PATH="$(command -v node)"
  log "Installed node at $NODE_PATH"
}

clone_or_update_repo() {
  log "Cloning/updating repo in $REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  if [[ -d "$REPO_DIR/.git" ]]; then
    git -C "$REPO_DIR" fetch origin
    git -C "$REPO_DIR" checkout main
    git -C "$REPO_DIR" pull --ff-only origin main
  else
    git clone "$REPO_URL" "$REPO_DIR"
  fi
  (cd "$REPO_DIR" && npm install)
}

resolve_stockfish_path() {
  if [[ -n "$STOCKFISH_PATH" && -x "$STOCKFISH_PATH" ]]; then
    log "Using provided STOCKFISH_PATH=$STOCKFISH_PATH"
    return
  fi

  for candidate in /usr/local/bin/stockfish /usr/games/stockfish /usr/local/bin/stockfish-optimal; do
    if [[ -x "$candidate" ]]; then
      STOCKFISH_PATH="$candidate"
      log "Found Stockfish at $STOCKFISH_PATH"
      return
    fi
  done

  if command -v stockfish >/dev/null 2>&1; then
    STOCKFISH_PATH="$(command -v stockfish)"
    log "Found Stockfish on PATH at $STOCKFISH_PATH"
    return
  fi

  if [[ "$INSTALL_STOCKFISH" != "1" ]]; then
    echo "Stockfish not found and INSTALL_STOCKFISH=0" >&2
    exit 1
  fi

  log "Installing distro stockfish package"
  apt-get install -y stockfish

  if command -v stockfish >/dev/null 2>&1; then
    STOCKFISH_PATH="$(command -v stockfish)"
  elif [[ -x /usr/games/stockfish ]]; then
    STOCKFISH_PATH=/usr/games/stockfish
  else
    echo "Stockfish install finished but binary not found" >&2
    exit 1
  fi

  log "Installed Stockfish at $STOCKFISH_PATH"
}

prepare_syzygy_dirs() {
  log "Preparing Syzygy directories"
  IFS=':' read -r -a dirs <<< "$SYZYGY_PATH"
  for dir in "${dirs[@]}"; do
    [[ -n "$dir" ]] || continue
    mkdir -p "$dir"
  done
}

install_systemd_unit() {
  local template="$REPO_DIR/deploy/pixie-stockfish.service"
  local target="/etc/systemd/system/${SERVICE_NAME}.service"

  log "Installing systemd unit to $target"
  cp "$template" "$target"

  python3 - "$target" <<'PY'
from pathlib import Path
import os
path = Path(__import__('sys').argv[1])
text = path.read_text()
replacements = {
    'WorkingDirectory=/root/claude/pixie-fen-auto': f"WorkingDirectory={os.environ['REPO_DIR']}",
    'Environment=HOST=127.0.0.1': f"Environment=HOST={os.environ['HOST']}",
    'Environment=PORT=8777': f"Environment=PORT={os.environ['PORT']}",
    'Environment=STOCKFISH_PATH=/usr/local/bin/stockfish': f"Environment=STOCKFISH_PATH={os.environ['STOCKFISH_PATH']}",
    'Environment=ENGINE_THREADS=20': f"Environment=ENGINE_THREADS={os.environ['ENGINE_THREADS']}",
    'Environment=ENGINE_THREADS_FAST=20': f"Environment=ENGINE_THREADS_FAST={os.environ['ENGINE_THREADS_FAST']}",
    'Environment=ENGINE_THREADS_STRONG=20': f"Environment=ENGINE_THREADS_STRONG={os.environ['ENGINE_THREADS_STRONG']}",
    'Environment=ENGINE_THREADS_MAX=20': f"Environment=ENGINE_THREADS_MAX={os.environ['ENGINE_THREADS_MAX']}",
    'Environment=ENGINE_HASH_MB=1024': f"Environment=ENGINE_HASH_MB={os.environ['ENGINE_HASH_MB']}",
    'Environment=ENGINE_POOL_SIZE=1': f"Environment=ENGINE_POOL_SIZE={os.environ['ENGINE_POOL_SIZE']}",
    'Environment=MAX_ENGINE_QUEUE=1': f"Environment=MAX_ENGINE_QUEUE={os.environ['MAX_ENGINE_QUEUE']}",
    'Environment=SYZYGY_PATH=/opt/syzygy/3-4-5:/opt/syzygy/6-man': f"Environment=SYZYGY_PATH={os.environ['SYZYGY_PATH']}",
    'Environment=MAX_MOVETIME=5000': f"Environment=MAX_MOVETIME={os.environ['MAX_MOVETIME']}",
    'Environment=MAX_MULTIPV=1': f"Environment=MAX_MULTIPV={os.environ['MAX_MULTIPV']}",
    'Environment=REQUEST_TIMEOUT=9000': f"Environment=REQUEST_TIMEOUT={os.environ['REQUEST_TIMEOUT']}",
    'ExecStart=/root/.nvm/versions/node/v24.9.0/bin/node server/stockfish-server.js': f"ExecStart={os.environ['NODE_PATH']} server/stockfish-server.js",
}
for old, new in replacements.items():
    if old not in text:
        raise SystemExit(f'missing template line: {old}')
    text = text.replace(old, new, 1)
path.write_text(text)
PY

  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
}

install_nginx_config() {
  [[ "$INSTALL_NGINX" == "1" ]] || return 0

  local snippet_src="$REPO_DIR/deploy/nginx-pixie-stockfish.conf"
  local snippet_dst="/etc/nginx/snippets/pixie-stockfish.conf"
  local conf_dst="/etc/nginx/conf.d/${SERVICE_NAME}.conf"

  log "Installing nginx config"
  mkdir -p /etc/nginx/snippets
  cp "$snippet_src" "$snippet_dst"
  cat > "$conf_dst" <<EOF
server {
  listen 80;
  server_name ${SERVER_NAME};

  include /etc/nginx/snippets/pixie-stockfish.conf;
}
EOF

  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
}

verify_local_service() {
  log "Verifying local service"
  curl -fsS "http://${HOST}:${PORT}/health"
  printf '\n'
  curl -fsS -X POST "http://${HOST}:${PORT}/bestmove" \
    -H 'Content-Type: application/json' \
    --data '{"fen":"r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 2 3","movetime":3000,"multipv":1}'
  printf '\n'
}

verify_public_paths() {
  [[ "$INSTALL_NGINX" == "1" ]] || return 0
  log "Verifying local nginx reverse-proxy paths"
  curl -fsSI "http://127.0.0.1/pixie-stockfish/pixie-fen-auto.user.js" >/dev/null
  curl -fsSI "http://127.0.0.1/pixie-stockfish/pixie-fen-auto-autoplay.user.js" >/dev/null
  curl -fsS "http://127.0.0.1/pixie-stockfish/health"
  printf '\n'

  if [[ -n "$PUBLIC_BASE_URL" ]]; then
    log "Verifying public endpoint $PUBLIC_BASE_URL"
    curl -fsS "$PUBLIC_BASE_URL/health"
    printf '\n'
    curl -fsS -X POST "$PUBLIC_BASE_URL/bestmove" \
      -H 'Content-Type: application/json' \
      --data '{"fen":"r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 2 3","movetime":3000,"multipv":1}'
    printf '\n'
  fi
}

print_summary() {
  cat <<EOF

Setup complete.

Service:
  systemctl status ${SERVICE_NAME} --no-pager

Config summary:
  REPO_DIR=$REPO_DIR
  NODE_PATH=$NODE_PATH
  STOCKFISH_PATH=$STOCKFISH_PATH
  HOST=$HOST
  PORT=$PORT
  ENGINE_THREADS=$ENGINE_THREADS
  ENGINE_THREADS_FAST=$ENGINE_THREADS_FAST
  ENGINE_THREADS_STRONG=$ENGINE_THREADS_STRONG
  ENGINE_THREADS_MAX=$ENGINE_THREADS_MAX
  ENGINE_HASH_MB=$ENGINE_HASH_MB
  MAX_ENGINE_QUEUE=$MAX_ENGINE_QUEUE
  MAX_MOVETIME=$MAX_MOVETIME
  MAX_MULTIPV=$MAX_MULTIPV
  SYZYGY_PATH=$SYZYGY_PATH

Autoplay/userscript preservation:
  - reverse-proxy path kept at /pixie-stockfish/
  - userscript URLs served by the same Node service
  - bestmove endpoint kept at /pixie-stockfish/bestmove
  - autoplay userscript can keep following Stockfish suggestions as long as clients use the same public URL

If your public domain changed, update clients with:
  localStorage.setItem("pixie-stockfish-server-url", "https://YOUR-DOMAIN/pixie-stockfish/bestmove");
EOF
}

main() {
  install_base_packages
  install_node_if_needed
  need_cmd npm
  need_cmd python3
  clone_or_update_repo
  resolve_stockfish_path
  prepare_syzygy_dirs
  install_systemd_unit
  install_nginx_config
  verify_local_service
  verify_public_paths
  print_summary
}

main "$@"
