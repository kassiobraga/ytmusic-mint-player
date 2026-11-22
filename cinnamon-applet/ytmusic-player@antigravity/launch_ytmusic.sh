#!/usr/bin/env bash
# ==============================================================================
# Launcher & Focador Direto do YouTube Music PWA (Linux Mint Cinnamon)
# Acionado pelo botão "Abrir player" e pelo clique no ícone do YouTube Music.
# ==============================================================================
set -euo pipefail

YTM_APP_ID="cinhimbnkkaeohfgghhklpknlkffjgod"
HIDDEN_FILE="${XDG_RUNTIME_DIR:-/tmp}/ytmusic-mint-hidden-xids"

# 1. Se houver janelas ocultas (unmapped) no modo segundo plano, reexibe e ativa
if [[ -f "$HIDDEN_FILE" ]] && command -v xdotool >/dev/null 2>&1; then
    HIDDEN_XIDS="$(cat "$HIDDEN_FILE" 2>/dev/null || true)"
    if [[ -n "$HIDDEN_XIDS" ]]; then
        for xid in $HIDDEN_XIDS; do
            xdotool windowmap "$xid" 2>/dev/null || true
            xdotool windowactivate "$xid" 2>/dev/null || true
        done
        rm -f "$HIDDEN_FILE"
        exit 0
    fi
fi

# 2. Se a janela do YouTube Music já estiver aberta no X11, traz ela para frente na hora
if command -v xdotool >/dev/null 2>&1; then
    XIDS="$(xdotool search --classname "$YTM_APP_ID" 2>/dev/null || xdotool search --name "YouTube Music" 2>/dev/null || true)"
    if [[ -n "$XIDS" ]]; then
        for xid in $XIDS; do
            xdotool windowmap "$xid" 2>/dev/null || true
            xdotool windowactivate "$xid" 2>/dev/null || true
        done
        exit 0
    fi
fi

# 3. Se não estiver aberta, lança o App YouTube Music instalado no Linux Mint
if command -v gtk-launch >/dev/null 2>&1; then
    if [[ -f "${HOME}/.local/share/applications/chrome-${YTM_APP_ID}-Default.desktop" ]]; then
        nohup gtk-launch "chrome-${YTM_APP_ID}-Default.desktop" >/dev/null 2>&1 &
        exit 0
    elif [[ -f "${HOME}/.local/share/applications/chrome-${YTM_APP_ID}-Profile_3.desktop" ]]; then
        nohup gtk-launch "chrome-${YTM_APP_ID}-Profile_3.desktop" >/dev/null 2>&1 &
        exit 0
    fi
fi

if [[ -x "/opt/google/chrome/google-chrome" ]]; then
    nohup /opt/google/chrome/google-chrome --profile-directory=Default "--app-id=${YTM_APP_ID}" >/dev/null 2>&1 &
    exit 0
fi

nohup xdg-open "https://music.youtube.com" >/dev/null 2>&1 &
