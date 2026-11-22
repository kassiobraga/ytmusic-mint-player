#!/usr/bin/env bash
# ==============================================================================
# Lançador Exclusivo do YouTube Music (v2.1) - 100% Seguro (NUNCA fecha janelas!)
#
# Ordem de prioridade:
#  1. Se a janela EXATA do PWA (`crx_cinhimbnkkaeohfgghhklpknlkffjgod`) já
#     estiver aberta, apenas foca ela (`windowactivate`) — NUNCA minimiza,
#     NUNCA faz unmap, NUNCA busca por título de janela!
#  2. Lê o atalho oficial do YouTube Music direto da Área de Trabalho do usuário
#     (`~/Área de trabalho` / `~/Área de Trabalho` / `~/Desktop`) e executa o
#     mesmo comando `Exec=` do ícone dele (conta pessoal Cássio Braga)!
#  3. Fallback: lê `~/.config/google-chrome/Local State` buscando `cassio26@gmail`
#     / `Profile 3` (evitando `ALK Agência`) e abre o PWA.
# ==============================================================================
set -euo pipefail

YTM_APP_ID="cinhimbnkkaeohfgghhklpknlkffjgod"
YTM_WM_CLASS="crx_${YTM_APP_ID}"
PREFERRED_EMAIL="${1:-cassio26@gmail}"

# 1. Se a janela EXATA do PWA do YouTube Music já estiver aberta, só traz para frente
if command -v xdotool >/dev/null 2>&1; then
    XIDS="$(xdotool search --classname "^${YTM_WM_CLASS}$" 2>/dev/null || true)"
    if [[ -n "$XIDS" ]]; then
        for xid in $XIDS; do
            xdotool windowactivate "$xid" 2>/dev/null || true
        done
        exit 0
    fi
fi

# 2. Procura o atalho exato do YouTube Music na Área de Trabalho do usuário
DESKTOP_EXEC="$(/usr/bin/python3 - <<'PYDESK'
import glob, os, re

dirs = [
    os.path.expanduser("~/Área de trabalho"),
    os.path.expanduser("~/Área de Trabalho"),
    os.path.expanduser("~/Desktop"),
]

# Também consulta xdg-user-dir DESKTOP se disponível
try:
    import subprocess
    xdg_desk = subprocess.check_output(["xdg-user-dir", "DESKTOP"], stderr=subprocess.DEVNULL, text=True).strip()
    if xdg_desk and xdg_desk not in dirs:
        dirs.insert(0, xdg_desk)
except Exception:
    pass

for d in dirs:
    if not os.path.isdir(d):
        continue
    for path in glob.glob(os.path.join(d, "*.desktop")):
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            low = content.lower()
            if "youtube music" in low or "cinhimbnkkaeohfgghhklpknlkffjgod" in low or "music.youtube.com" in low:
                m = re.search(r"^Exec=(.+)$", content, re.MULTILINE)
                if m:
                    cmd = m.group(1).strip()
                    # Remove placeholders de arquivo (%U, %F, etc.)
                    cmd = re.sub(r"\s+%[a-zA-Z]", "", cmd).strip()
                    print(cmd)
                    raise SystemExit(0)
        except SystemExit:
            raise
        except Exception:
            pass
PYDESK
)"

if [[ -n "$DESKTOP_EXEC" ]]; then
    nohup bash -c "${DESKTOP_EXEC}" >/dev/null 2>&1 &
    exit 0
fi

# 3. Fallback: detecta automaticamente o perfil Chrome da conta pessoal (cassio26@gmail)
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
        for prof_dir, info in cache.items():
            user_name = str(info.get("user_name", "")).lower()
            if (
                target in user_name
                or "cassio26" in user_name
                or "kassio26" in user_name
                or "26@gmail" in user_name
            ):
                chosen = prof_dir
                break
        if not chosen:
            for prof_dir, info in cache.items():
                combined = f"{info.get('user_name','')} {info.get('name','')} {info.get('gaia_name','')}".lower()
                if "alk" not in combined and prof_dir != "Default":
                    chosen = prof_dir
                    break
    except Exception:
        pass

if not chosen:
    p3_desktop = os.path.expanduser("~/.local/share/applications/chrome-cinhimbnkkaeohfgghhklpknlkffjgod-Profile_3.desktop")
    chosen = "Profile 3" if os.path.exists(p3_desktop) else "Default"

print(chosen)
PYPROF
)"

if [[ -x "/opt/google/chrome/google-chrome" ]]; then
    nohup /opt/google/chrome/google-chrome "--profile-directory=${CHROME_PROFILE}" "--app-id=${YTM_APP_ID}" >/dev/null 2>&1 &
    exit 0
fi

nohup xdg-open "https://music.youtube.com" >/dev/null 2>&1 &
