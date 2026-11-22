#!/usr/bin/env bash
# ==============================================================================
# Instalador Automático v1.2 - YouTube Music Taskbar Player (Hybrid Vinyl)
# Focado em Linux Mint (Cinnamon) - Zona Esquerda da Barra de Tarefas
# ==============================================================================
set -euo pipefail

UUID="ytmusic-player@antigravity"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLET_SRC="${SCRIPT_DIR}/cinnamon-applet/${UUID}"
APPLET_DEST="${HOME}/.local/share/cinnamon/applets/${UUID}"

echo "=================================================================="
echo " 🎵 Instalando YouTube Music Taskbar Player v1.2 (Híbrido Vinil)"
echo "=================================================================="

# 1. Copiar os arquivos do Applet para o diretório do Cinnamon
mkdir -p "${HOME}/.local/share/cinnamon/applets"
rm -rf "${APPLET_DEST}"
cp -r "${APPLET_SRC}" "${APPLET_DEST}"
echo "✅ [1/4] Applet copiado para: ${APPLET_DEST}"

# 2. Habilitar plugin MPRIS automaticamente caso o usuário tenha o Pear Desktop / th-ch youtube-music instalado
for cfg in \
    "${HOME}/.config/YouTube Music/config.json" \
    "${HOME}/.config/youtube-music/config.json" \
    "${HOME}/.config/pear-desktop/config.json" \
    "${HOME}/.var/app/io.github.pear_devs.pear_desktop/config/YouTube Music/config.json" \
    "${HOME}/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/config.json"; do
    if [[ -f "$cfg" ]] && command -v python3 >/dev/null 2>&1; then
        /usr/bin/python3 - "$cfg" <<'PYCFG' || true
import json, sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    plugins = data.setdefault("plugins", {})
    # Ativa o plugin de atalhos/MPRIS nativo do YouTube Music Desktop App
    if "shortcuts" in plugins and isinstance(plugins["shortcuts"], dict):
        plugins["shortcuts"]["enabled"] = True
    else:
        plugins.setdefault("shortcuts", {"enabled": True})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print(f"✅ [MPRIS] Integração MPRIS habilitada em: {path}")
except Exception:
    pass
PYCFG
    fi
done

# 3. Ativar automaticamente o Applet na Zona Esquerda (left) do painel principal
if command -v gsettings >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
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
        print("ℹ️  [2/4] Applet já estava ativo na barra do Cinnamon.")
except Exception as e:
    print(f"⚠️  [2/4] Não foi possível ativar via gsettings ({e}).")
PYEOF
fi

# 4. Recarregar especificamente a instância do Applet via D-Bus do Cinnamon
if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" string:"${UUID}" >/dev/null 2>&1 || \
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" >/dev/null 2>&1 || true
    echo "✅ [3/4] Cinnamon recarregou o Applet ${UUID}!"
fi

# 5. Diagnóstico rápido dos aplicativos YouTube Music e players MPRIS encontrados na máquina
echo "------------------------------------------------------------------"
echo "🔍 [4/4] Diagnóstico de vinculação ao YouTube Music na sua máquina:"
if command -v python3 >/dev/null 2>&1; then
    /usr/bin/python3 - <<'PYDIAG' || true
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

# 1. Apps instalados que correspondem ao YouTube Music
apps = Gio.AppInfo.get_all()
yt_apps = []
for a in apps:
    name = (a.get_name() or "").lower()
    disp = (a.get_display_name() or "").lower()
    aid = (a.get_id() or "").lower()
    cmd = (a.get_commandline() or "").lower()
    if any(k in name or k in disp or k in aid or k in cmd for k in ("youtube music", "youtube-music", "ytmusic", "pear_desktop", "music.youtube.com")):
        yt_apps.append(f"{a.get_name()} (ID: {a.get_id()} | Exec: {a.get_commandline()})")

if yt_apps:
    print("   🎯 App(s) YouTube Music detectado(s) no Mint:")
    for item in yt_apps:
        print(f"      - {item}")
else:
    print("   ℹ️  Nenhum lançador desktop específico encontrado (usará https://music.youtube.com no navegador padrão).")

# 2. Barramentos MPRIS2 ativos agora
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = bus.call_sync(
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "ListNames",
        None,
        GLib.VariantType.new("(as)"),
        Gio.DBusCallFlags.NONE,
        -1,
        None,
    )
    names = [n for n in reply.unpack()[0] if n.startswith("org.mpris.MediaPlayer2.")]
    if names:
        print("   🎧 Players MPRIS2 ativos neste momento:")
        for n in names:
            print(f"      - {n}")
    else:
        print("   ℹ️  Nenhum player MPRIS2 tocando neste exato segundo (clique no ícone do YT Music na barra para abrir!).")
except Exception:
    pass
PYDIAG
fi
echo "=================================================================="
echo "🎉 Atualização v1.2 concluída!"
