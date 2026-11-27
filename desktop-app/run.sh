#!/usr/bin/env bash
# Lançador oficial do ytmusic-mint-app (nosso app próprio endurecido)
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_BIN="${APP_DIR}/node_modules/.bin/electron"

if [[ ! -x "${ELECTRON_BIN}" ]]; then
    echo "Erro: Electron não encontrado em ${ELECTRON_BIN}. Rode 'npm install' em ${APP_DIR}." >&2
    exit 1
fi

if command -v setsid >/dev/null 2>&1; then
    setsid -f "${ELECTRON_BIN}" "${APP_DIR}" "$@" </dev/null >/dev/null 2>&1
else
    nohup "${ELECTRON_BIN}" "${APP_DIR}" "$@" </dev/null >/dev/null 2>&1 &
fi
