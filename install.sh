#!/usr/bin/env bash
# ==============================================================================
# Instalador Automático v1.4 - YouTube Music Taskbar Player (Hybrid Vinyl)
# Focado em Linux Mint (Cinnamon) - Zona Esquerda da Barra de Tarefas
# ==============================================================================
set -euo pipefail

UUID="ytmusic-player@antigravity"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLET_SRC="${SCRIPT_DIR}/cinnamon-applet/${UUID}"
APPLET_DEST="${HOME}/.local/share/cinnamon/applets/${UUID}"

echo "=================================================================="
echo " 🎵 Instalando YouTube Music Taskbar Player v1.4 (Híbrido)"
echo "=================================================================="

# 0. Garantir xdotool instalado para ocultar/mostrar a janela do YouTube Music em 2º plano
if ! command -v xdotool >/dev/null 2>&1; then
    echo "📦 Instalando utilitário leve 'xdotool' para modo Segundo Plano..."
    sudo apt-get update -qq && sudo apt-get install -y -qq xdotool || true
fi

# 1. Copiar os arquivos do Applet para o diretório do Cinnamon
mkdir -p "${HOME}/.local/share/cinnamon/applets"
rm -rf "${APPLET_DEST}"
cp -r "${APPLET_SRC}" "${APPLET_DEST}"
chmod +x "${APPLET_DEST}/ytm_window_helper.py" || true
echo "✅ [1/4] Applet v1.4 copiado para: ${APPLET_DEST}"

# Reinicia o helper de segundo plano
pkill -f "ytm_window_helper.py" 2>/dev/null || true
nohup /usr/bin/python3 "${APPLET_DEST}/ytm_window_helper.py" >/dev/null 2>&1 &

# 2. Habilitar plugin MPRIS caso o usuário também tenha Pear Desktop / th-ch instalado
for cfg in \
    "${HOME}/.config/YouTube Music/config.json" \
    "${HOME}/.config/youtube-music/config.json" \
    "${HOME}/.config/pear-desktop/config.json" \
    "${HOME}/.var/app/io.github.pear_devs.pear_desktop/config/YouTube Music/config.json" \
    "${HOME}/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/config.json"; do
    if [[ -f "$cfg" ]] && command -v /usr/bin/python3 >/dev/null 2>&1; then
        /usr/bin/python3 - "$cfg" <<'PYCFG' || true
import json, sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    plugins = data.setdefault("plugins", {})
    if "shortcuts" in plugins and isinstance(plugins["shortcuts"], dict):
        plugins["shortcuts"]["enabled"] = True
    else:
        plugins.setdefault("shortcuts", {"enabled": True})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
except Exception:
    pass
PYCFG
    fi
done

# 3. Ativar automaticamente o Applet na Zona Esquerda (left) do painel principal
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
        print(f"✅ [2/4] Applet posicionado automaticamente na ESQUERDA da barra ({new_entry})!")
    else:
        print("ℹ️  [2/4] Applet já está ativo na esquerda da barra do Cinnamon.")
except Exception as e:
    print(f"⚠️  [2/4] Não foi possível ativar via gsettings ({e}).")
PYEOF
fi

# 4. Recarregar o Applet via D-Bus do Cinnamon
if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" string:"${UUID}" >/dev/null 2>&1 || \
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" >/dev/null 2>&1 || true
    echo "✅ [3/4] Cinnamon recarregou o Applet ${UUID}!"
fi

echo "✅ [4/4] Guardião de Segundo Plano ativo!"
echo "   - Agora a capa do álbum na janelinha fica QUADRADA e FIXA (estilo capa de álbum real)."
echo "   - Para esconder a janela do YouTube Music e deixar tocando só na barrinha:"
echo "     clique no ícone do YouTube Music na barra ou em '🗕 Ocultar na Barra' na janelinha!"
echo "=================================================================="
