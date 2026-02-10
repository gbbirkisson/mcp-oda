#!/usr/bin/env sh

cd $(dirname "$0")

LOG="/tmp/oda-mcp.log"

log() {
  if [ "$MCP_ODA_LOG" = "1" ]; then
    echo "[$(date -Iseconds)] $*" >>"$LOG"
  fi
}

# Bootstrap: install deps / build if needed
if [ ! -d node_modules ]; then
  log "node_modules missing, running npm install"
  if [ "$MCP_ODA_LOG" = "1" ]; then
    npm install 2>>"$LOG" >>"$LOG"
  else
    npm install >/dev/null 2>&1
  fi
fi

if [ ! -f dist/index.js ]; then
  log "dist/index.js missing, running npm run build"
  if [ "$MCP_ODA_LOG" = "1" ]; then
    npm run build 2>>"$LOG" >>"$LOG"
  else
    npm run build >/dev/null 2>&1
  fi
fi

log "=== MCP startup ==="
log "PWD=$PWD"
log "args=$*"
log "node=$(node --version 2>&1 || echo '<not found>')"
log "npx=$(npx --version 2>&1 || echo '<not found>')"
log "PATH=$PATH"

trap 'log "=== MCP exit code=$? ==="' EXIT

if [ "$MCP_ODA_LOG" = "1" ]; then
  if [ "$MCP_ODA_VERBOSE" = "1" ]; then
    npx -y "$PWD" mcp 2>>"$LOG" | tee -a "$LOG"
  else
    npx -y "$PWD" mcp 2>>"$LOG"
  fi
else
  npx -y "$PWD" mcp
fi
