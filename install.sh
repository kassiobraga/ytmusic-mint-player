#!/usr/bin/env bash
# ==============================================================================
# Instalador Automático v2.2 - YouTube Music Taskbar Player
# - Instala wmctrl e xdotool para remover o ícone duplicado da barra central
# - Aplica a v2.2 com lançamento direto via Gio.DesktopAppInfo (Profile 3)
# ==============================================================================
set -euo pipefail

UUID="ytmusic-player@antigravity"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLET_SRC="${SCRIPT_DIR}/cinnamon-applet/${UUID}"
APPLET_DEST="${HOME}/.local/share/cinnamon/applets/${UUID}"

echo "=================================================================="
echo " 🎵 Instalando YouTube Music Taskbar Player v2.2"
echo "=================================================================="

# 0. Garantir wmctrl e xdotool para remover o ícone duplicado do YouTube Music da barra central
MISSING=()
command -v wmctrl >/dev/null 2>&1 || MISSING+=("wmctrl")
command -v xdotool >/dev/null 2>&1 || MISSING+=("xdotool")
if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo "📦 Instalando utilitários leves (${MISSING[*]}) para remover o ícone duplicado da barra central..."
    sudo apt-get update -qq && sudo apt-get install -y -qq "${MISSING[@]}" || true
fi

# 1. Limpar resquícios legados
pkill -9 -f "[y]tm_window_helper.py" 2>/dev/null || true
rm -f "${XDG_RUNTIME_DIR:-/tmp}/ytmusic-mint-hidden-xids" "${XDG_RUNTIME_DIR:-/tmp}/ytmusic-mint-window-cmd" 2>/dev/null || true

# 2. Copiar arquivos limpos da v2.2
mkdir -p "${HOME}/.local/share/cinnamon/applets"
rm -rf "${APPLET_DEST}"
cp -r "${APPLET_SRC}" "${APPLET_DEST}"
chmod +x "${APPLET_DEST}/launch_ytmusic.sh"
echo "✅ [1/3] Applet v2.2 instalado em: ${APPLET_DEST}"

# 3. Se o YouTube Music PWA já estiver aberto agora, já tira o ícone duplicado da barra central
if command -v xdotool >/dev/null 2>&1 && command -v wmctrl >/dev/null 2>&1; then
    for id in $(xdotool search --classname "^crx_cinhimbnkkaeohfgghhklpknlkffjgod$" 2>/dev/null || true); do
        wmctrl -i -r "$id" -b add,skip_taskbar 2>/dev/null || true
    done
fi

# 4. Ativar na Zona Esquerda da barra se ainda não estiver ativo
if command -v gsettings >/dev/null 2>&1; then
    /usr/bin/python3 - <<'PYEOF'
import ast, subprocess
UUID = "ytmusic-player@antigravity"
try:
    raw = subprocess.check_output(["gsettings", "get", "org.cinnamon", "enabled-applets"], text=True).strip()
    applets = ast.literal_eval(raw)
    if not any(UUID in entry for entry in applets):
        max_id = max([int(e.split(":")[3]) for e in applets if len(e.split(":")) >= 4 and e.split(":")[3].isdigit()] + [0])
        applets.append(f"panel1:left:0:{UUID}:{max_id + 1}")
        formatted = "[" + ", ".join(f"'{a}'" for a in applets) + "]"
        subprocess.check_call(["gsettings", "set", "org.cinnamon", "enabled-applets", formatted])
        print("✅ [2/3] Applet posicionado na ESQUERDA da barra!")
    else:
        print("ℹ️  [2/3] Applet já está ativo na esquerda da barra.")
except Exception as e:
    print(f"⚠️  [2/3] gsettings: {e}")
PYEOF
fi

# 5. Recarregar o Applet no Cinnamon via D-Bus
if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" string:"${UUID}" >/dev/null 2>&1 || \
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" >/dev/null 2>&1 || true
    echo "✅ [3/3] Cinnamon recarregou a v2.2!"
fi
echo "=================================================================="
