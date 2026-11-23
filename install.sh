#!/usr/bin/env bash
# ==============================================================================
# Instalador Automático v3.0 — YouTube Music Taskbar Player (Pear Desktop + Mint)
#
# Etapas executadas:
#  1. Instala utilitários leves (curl, wmctrl, xdotool) se faltarem.
#  2. Instala o Pear Desktop (.deb oficial de pear-devs/pear-desktop) se ainda
#     não estiver instalado, resolvendo dependências via `apt install`.
#  3. Pré-configura ~/.config/YouTube Music/config.json (merge seguro):
#       - options.tray = true (Close-to-Tray nativo real: clicar no X oculta e
#         continua tocando!)
#       - options.resumeOnStart = true
#       - plugins.shortcuts.enabled = true (MPRIS exclusivo YoutubeMusic!)
#  4. Instala o Applet v3.0 na zona esquerda do painel do Cinnamon.
#  5. Recarrega o Applet via método D-Bus real `org.Cinnamon.ReloadXlet`.
# ==============================================================================
set -euo pipefail

UUID="ytmusic-player@antigravity"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLET_SRC="${SCRIPT_DIR}/cinnamon-applet/${UUID}"
APPLET_DEST="${HOME}/.local/share/cinnamon/applets/${UUID}"
PEAR_FALLBACK_URL="https://github.com/pear-devs/pear-desktop/releases/download/v3.12.1/youtube-music_3.12.1_amd64.deb"

echo "=================================================================="
echo " 🎵 Instalando YouTube Music Taskbar Player v3.0 (Pear Desktop)"
echo "=================================================================="

# 1. Dependências leves de sistema
MISSING=()
command -v curl >/dev/null 2>&1 || MISSING+=("curl")
command -v wmctrl >/dev/null 2>&1 || MISSING+=("wmctrl")
command -v xdotool >/dev/null 2>&1 || MISSING+=("xdotool")
if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo "📦 [1/5] Instalando utilitários leves: ${MISSING[*]}..."
    sudo apt-get update -qq && sudo apt-get install -y -qq "${MISSING[@]}"
else
    echo "✅ [1/5] Utilitários (curl, wmctrl, xdotool) já instalados."
fi

# 2. Instalar Pear Desktop (.deb oficial) se ainda não estiver instalado
if [[ -x "/opt/YouTube Music/youtube-music" ]] || command -v youtube-music >/dev/null 2>&1; then
    echo "✅ [2/5] Pear Desktop (YouTube Music) já está instalado."
else
    echo "⬇️  [2/5] Baixando e instalando Pear Desktop (.deb oficial)..."
    TMP_DEB="$(mktemp --suffix=.deb)"
    DEB_URL="$(curl -fsSL https://api.github.com/repos/pear-devs/pear-desktop/releases/latest 2>/dev/null \
        | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((a["browser_download_url"] for a in d.get("assets",[]) if a["name"].endswith("_amd64.deb")), ""))' 2>/dev/null || true)"
    if [[ -z "$DEB_URL" ]]; then
        DEB_URL="$PEAR_FALLBACK_URL"
    fi
    echo "   URL: ${DEB_URL}"
    curl -fL --progress-bar -o "$TMP_DEB" "$DEB_URL"
    sudo apt-get update -qq
    sudo apt-get install -y "$TMP_DEB"
    rm -f "$TMP_DEB"
    echo "✅ [2/5] Pear Desktop instalado com sucesso!"
fi

# 3. Pré-configurar ~/.config/YouTube Music/config.json (Close-to-Tray + MPRIS exclusivo)
echo "⚙️  [3/5] Configurando Close-to-Tray e MPRIS exclusivo no Pear Desktop..."
/usr/bin/python3 - <<'PYCFG'
import json, os

cfg_dir = os.path.expanduser("~/.config/YouTube Music")
os.makedirs(cfg_dir, exist_ok=True)
cfg_path = os.path.join(cfg_dir, "config.json")

data = {}
if os.path.exists(cfg_path):
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            data = loaded
    except Exception:
        data = {}

if not isinstance(data.get("options"), dict):
    data["options"] = {}
options = data["options"]
options["tray"] = True
options["appVisible"] = True
options["resumeOnStart"] = True
options["overrideUserAgent"] = True

if not isinstance(data.get("plugins"), dict):
    data["plugins"] = {}
plugins = data["plugins"]
shortcuts = plugins.get("shortcuts")
if not isinstance(shortcuts, dict):
    shortcuts = {}
shortcuts["enabled"] = True
shortcuts.setdefault("overrideMediaKeys", False)
plugins["shortcuts"] = shortcuts

with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print(f"   ✅ Configurado: {cfg_path} (tray=true, shortcuts/MPRIS=true)")
PYCFG

# 4. Instalar Applet v3.0 no Cinnamon (limpando qualquer resquício antigo)
pkill -9 -f "[y]tm_window_helper.py" 2>/dev/null || true
mkdir -p "${HOME}/.local/share/cinnamon/applets"
rm -rf "${APPLET_DEST}"
cp -r "${APPLET_SRC}" "${APPLET_DEST}"
chmod +x "${APPLET_DEST}/launch_ytmusic.sh"
echo "✅ [4/5] Applet v3.0 instalado em: ${APPLET_DEST}"

# Ativar na Zona Esquerda da barra se ainda não estiver ativo
if command -v gsettings >/dev/null 2>&1; then
    /usr/bin/python3 - <<'PYEOF'
import ast, subprocess
UUID = "ytmusic-player@antigravity"
try:
    raw = subprocess.check_output(["gsettings", "get", "org.cinnamon", "enabled-applets"], text=True).strip()
    applets = ast.literal_eval(raw)
    if not any(UUID in entry for entry in applets):
        max_id = max([int(e.split(":")[4]) for e in applets if len(e.split(":")) >= 5 and e.split(":")[4].isdigit()] + [0])
        applets.append(f"panel1:left:0:{UUID}:{max_id + 1}")
        formatted = "[" + ", ".join(f"'{a}'" for a in applets) + "]"
        subprocess.check_call(["gsettings", "set", "org.cinnamon", "enabled-applets", formatted])
        print("   ✅ Applet posicionado na ESQUERDA da barra!")
    else:
        print("   ℹ️  Applet já está ativo na esquerda da barra.")
except Exception as e:
    print(f"   ⚠️  gsettings indisponível nesta sessão ({e}).")
PYEOF
fi

# 5. Recarregar o Applet via método D-Bus REAL do Cinnamon (ReloadXlet com --print-reply)
if command -v dbus-send >/dev/null 2>&1; then
    if dbus-send --session --dest=org.Cinnamon --type=method_call --print-reply \
        /org/Cinnamon org.Cinnamon.ReloadXlet string:"${UUID}" string:"APPLET" >/dev/null 2>&1; then
        echo "✅ [5/5] Cinnamon recarregou o Applet ${UUID} via ReloadXlet!"
    else
        echo "ℹ️  [5/5] ReloadXlet não respondeu (fora de sessão Cinnamon ativa)."
    fi
fi

echo "=================================================================="
echo "🎉 Instalação v3.0 concluída!"
echo "   👉 Clique no ícone do YouTube Music à esquerda da sua barra para"
echo "      abrir o Pear Desktop e fazer login 1 única vez com cassio26@gmail."
echo "   👉 Depois, pode clicar no 'X' da janela: a música continua tocando"
echo "      na barrinha e o ícone some da barra central!"
echo "=================================================================="
