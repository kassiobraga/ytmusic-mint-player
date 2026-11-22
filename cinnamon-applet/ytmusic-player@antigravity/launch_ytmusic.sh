#!/usr/bin/env bash
# ==============================================================================
# Lançador e Focador Exclusivo do YouTube Music PWA (v2.0)
# - NUNCA busca por título da janela ("YouTube Music") para JAMAIS confundir
#   com janelas do Antigravity, VS Code ou abas do navegador!
# - Busca EXCLUSIVAMENTE pelo WM_CLASS exato do PWA:
#   `crx_cinhimbnkkaeohfgghhklpknlkffjgod`
# - Seleciona AUTOMATICAMENTE o perfil do Google Chrome da conta pessoal
#   (`cassio26@gmail` / `Profile 3`), lendo `~/.config/google-chrome/Local State`,
#   evitando abrir a conta empresarial (`ALK Agência`).
# ==============================================================================
set -euo pipefail

YTM_APP_ID="cinhimbnkkaeohfgghhklpknlkffjgod"
YTM_WM_CLASS="crx_${YTM_APP_ID}"
PREFERRED_EMAIL="${1:-cassio26@gmail}"

# 1. Se a janela EXATA do PWA do YouTube Music (WM_CLASS = crx_cinhimbnkkaeohfgghhklpknlkffjgod)
#    já estiver aberta no X11, traz somente ELA para frente!
if command -v xdotool >/dev/null 2>&1; then
    XIDS="$(xdotool search --classname "^${YTM_WM_CLASS}$" 2>/dev/null || true)"
    if [[ -n "$XIDS" ]]; then
        for xid in $XIDS; do
            xdotool windowmap "$xid" 2>/dev/null || true
            xdotool windowactivate "$xid" 2>/dev/null || true
        done
        exit 0
    fi
fi

# 2. Descobre qual diretório de perfil do Google Chrome corresponde à conta pessoal
#    (cassio26@gmail / kassio26@gmail) lendo ~/.config/google-chrome/Local State.
#    Se não encontrar por e-mail, usa "Profile 3" se o .desktop existir, ou "Default".
CHROME_PROFILE="$(/usr/bin/python3 - "$PREFERRED_EMAIL" <<'PYPROF'
import json, os, sys

target = (sys.argv[1] if len(sys.argv) > 1 else "cassio26@gmail").lower()
local_state = os.path.expanduser("~/.config/google-chrome/Local State")
chosen = None

if os.path.exists(local_state):
    try:
        with open(local_state, "r", encoding="utf-8") as f:
            data = json.load(f)
        cache = data.get("profile", {}).get("info_cache", {})
        # 1ª tentativa: match direto pelo e-mail pessoal (cassio26 / kassio26)
        for prof_dir, info in cache.items():
            user_name = str(info.get("user_name", "")).lower()
            name = str(info.get("name", "")).lower()
            gaia = str(info.get("gaia_name", "")).lower()
            if (
                target in user_name
                or "cassio26" in user_name
                or "kassio26" in user_name
                or "26@gmail" in user_name
            ):
                chosen = prof_dir
                break
        # 2ª tentativa: evita explicitamente o perfil empresarial (ALK Agência)
        if not chosen:
            for prof_dir, info in cache.items():
                combined = f"{info.get('user_name','')} {info.get('name','')} {info.get('gaia_name','')}".lower()
                if "alk" not in combined and prof_dir != "Default":
                    chosen = prof_dir
                    break
    except Exception:
        pass

if not chosen:
    # Fallback seguro: prioriza Profile 3 se o lançador dele existir
    p3_desktop = os.path.expanduser("~/.local/share/applications/chrome-cinhimbnkkaeohfgghhklpknlkffjgod-Profile_3.desktop")
    if os.path.exists(p3_desktop):
        chosen = "Profile 3"
    else:
        chosen = "Default"

print(chosen)
PYPROF
)"

# 3. Lança diretamente o Google Chrome PWA do YouTube Music no perfil pessoal correto!
if [[ -x "/opt/google/chrome/google-chrome" ]]; then
    nohup /opt/google/chrome/google-chrome "--profile-directory=${CHROME_PROFILE}" "--app-id=${YTM_APP_ID}" >/dev/null 2>&1 &
    exit 0
fi

# Fallback via gtk-launch caso o binário esteja em outro caminho
SAFE_PROF="${CHROME_PROFILE// /_}"
DESKTOP_ID="chrome-${YTM_APP_ID}-${SAFE_PROF}.desktop"
if command -v gtk-launch >/dev/null 2>&1 && [[ -f "${HOME}/.local/share/applications/${DESKTOP_ID}" ]]; then
    nohup gtk-launch "${DESKTOP_ID}" >/dev/null 2>&1 &
    exit 0
fi

nohup xdg-open "https://music.youtube.com" >/dev/null 2>&1 &
