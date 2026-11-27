#!/usr/bin/env bash
# ==============================================================================
# Lançador Exclusivo do Pear Desktop (YouTube Music) - v3.0
# - Usa o single-instance lock nativo do Electron (`second-instance`):
#   * Se o Pear Desktop já estiver rodando oculto no tray ou minimizado,
#     chamar o binário restaura, exibe e foca a janela instantaneamente.
#   * Se estiver fechado, abre o aplicativo normalmente.
# - Nunca toca no Google Chrome nem no Antigravity.
# ==============================================================================
set -euo pipefail

# 0. Nosso app próprio minimalista e endurecido (ytmusic-mint-app)
if [[ -x "${HOME}/ytmusic-mint-player/desktop-app/run.sh" ]]; then
    "${HOME}/ytmusic-mint-player/desktop-app/run.sh"
    exit 0
fi

# 1. Fallback: binário oficial do Pear Desktop
if [[ -x "/opt/YouTube Music/youtube-music" ]]; then
    if command -v setsid >/dev/null 2>&1; then
        setsid -f "/opt/YouTube Music/youtube-music" </dev/null >/dev/null 2>&1
    else
        nohup "/opt/YouTube Music/youtube-music" </dev/null >/dev/null 2>&1 &
    fi
    exit 0
fi

# 2. Binário no PATH (/usr/bin/youtube-music ou pear-desktop)
if command -v youtube-music >/dev/null 2>&1; then
    nohup youtube-music >/dev/null 2>&1 &
    exit 0
fi

if command -v pear-desktop >/dev/null 2>&1; then
    nohup pear-desktop >/dev/null 2>&1 &
    exit 0
fi

# 3. Lançador .desktop oficial via gtk-launch
if command -v gtk-launch >/dev/null 2>&1; then
    for desk in "youtube-music.desktop" "com.github.th-ch.youtube-music.desktop" "io.github.pear_devs.pear_desktop.desktop"; do
        if [[ -f "/usr/share/applications/${desk}" ]] || [[ -f "${HOME}/.local/share/applications/${desk}" ]]; then
            nohup gtk-launch "${desk}" >/dev/null 2>&1 &
            exit 0
        fi
    done
fi

# 4. Flatpak fallback caso instalado via Flatpak
if command -v flatpak >/dev/null 2>&1; then
    if flatpak info io.github.pear_devs.pear_desktop >/dev/null 2>&1; then
        nohup flatpak run io.github.pear_devs.pear_desktop >/dev/null 2>&1 &
        exit 0
    fi
fi

exit 1
