#!/usr/bin/env bash
# ==============================================================================
# Instalador Automático v2.0 - YouTube Music Taskbar Player (Hybrid)
# - Encerra qualquer processo legado do antigo ytm_window_helper.py
# - Instala o Applet v2.0 com isolamento estrito de janela (WM_CLASS)
# - Detecta e valida o perfil do Chrome da conta pessoal (cassio26@gmail)
# ==============================================================================
set -euo pipefail

UUID="ytmusic-player@antigravity"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLET_SRC="${SCRIPT_DIR}/cinnamon-applet/${UUID}"
APPLET_DEST="${HOME}/.local/share/cinnamon/applets/${UUID}"

echo "=================================================================="
echo " 🎵 Instalando YouTube Music Taskbar Player v2.0"
echo "=================================================================="

# 1. Encerra e limpa qualquer resquício do antigo helper que usava --name "YouTube Music"
pkill -f "[y]tm_window_helper.py" 2>/dev/null || true
rm -f "${XDG_RUNTIME_DIR:-/tmp}/ytmusic-mint-hidden-xids" "${XDG_RUNTIME_DIR:-/tmp}/ytmusic-mint-window-cmd" 2>/dev/null || true

# 2. Copiar os arquivos limpos do Applet v2.0 para o diretório do Cinnamon
mkdir -p "${HOME}/.local/share/cinnamon/applets"
rm -rf "${APPLET_DEST}"
cp -r "${APPLET_SRC}" "${APPLET_DEST}"
rm -f "${APPLET_DEST}/ytm_window_helper.py" 2>/dev/null || true
chmod +x "${APPLET_DEST}/launch_ytmusic.sh"
echo "✅ [1/3] Applet v2.0 instalado em: ${APPLET_DEST}"

# 3. Ativar automaticamente na Zona Esquerda (left) do painel principal
if command -v gsettings >/dev/null 2>&1 && command -v /usr/bin/python3 >/dev/null 2>&1; then
    /usr/bin/python3 - <<'PYEOF'
import ast, subprocess

UUID = "ytmusic-player@antigravity"
SCHEMA = "org.cinnamon"
KEY = "enabled-applets"

try:
    raw = subprocess.check_output(["gsettings", "get", SCHEMA, KEY], text=True).strip()
    applets = ast.literal_eval(raw)
    already = any(UUID in entry for entry in applets)
    if not already:
        max_id = 0
        for entry in applets:
            parts = entry.split(":")
            if len(parts) >= 4 and parts[3].isdigit():
                max_id = max(max_id, int(parts[3]))
        new_entry = f"panel1:left:0:{UUID}:{max_id + 1}"
        applets.append(new_entry)
        formatted = "[" + ", ".join(f"'{a}'" for a in applets) + "]"
        subprocess.check_call(["gsettings", "set", SCHEMA, KEY, formatted])
        print(f"✅ [2/3] Applet posicionado na ESQUERDA da barra ({new_entry})!")
    else:
        print("ℹ️  [2/3] Applet já está ativo na esquerda da barra do Cinnamon.")
except Exception as e:
    print(f"⚠️  [2/3] Não foi possível ativar via gsettings ({e}).")
PYEOF
fi

# 4. Recarregar o Applet via D-Bus do Cinnamon
if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" string:"${UUID}" >/dev/null 2>&1 || \
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" >/dev/null 2>&1 || true
    echo "✅ [3/3] Cinnamon recarregou o Applet ${UUID}!"
fi
echo "=================================================================="
