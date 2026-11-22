#!/usr/bin/env bash
# ==============================================================================
# Instalador Automático v2.1 - YouTube Music Taskbar Player
# ==============================================================================
set -euo pipefail

UUID="ytmusic-player@antigravity"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLET_SRC="${SCRIPT_DIR}/cinnamon-applet/${UUID}"
APPLET_DEST="${HOME}/.local/share/cinnamon/applets/${UUID}"

echo "=================================================================="
echo " 🎵 Instalando YouTube Music Taskbar Player v2.1"
echo "=================================================================="

# 1. Mata qualquer resquício do antigo ytm_window_helper.py que fechava/ocultava janelas
pkill -9 -f "[y]tm_window_helper.py" 2>/dev/null || true
rm -f "${XDG_RUNTIME_DIR:-/tmp}/ytmusic-mint-hidden-xids" "${XDG_RUNTIME_DIR:-/tmp}/ytmusic-mint-window-cmd" 2>/dev/null || true

# 2. Copia os arquivos limpos da v2.1
mkdir -p "${HOME}/.local/share/cinnamon/applets"
rm -rf "${APPLET_DEST}"
cp -r "${APPLET_SRC}" "${APPLET_DEST}"
rm -f "${APPLET_DEST}/ytm_window_helper.py" 2>/dev/null || true
chmod +x "${APPLET_DEST}/launch_ytmusic.sh"
echo "✅ [1/3] Applet v2.1 copiado para: ${APPLET_DEST}"

# 3. Mostra exatamente qual atalho da Área de Trabalho ou perfil do Chrome será usado
/usr/bin/python3 - <<'PYCHECK'
import glob, os, re
dirs = [os.path.expanduser("~/Área de trabalho"), os.path.expanduser("~/Área de Trabalho"), os.path.expanduser("~/Desktop")]
found = False
for d in dirs:
    if not os.path.isdir(d):
        continue
    for path in glob.glob(os.path.join(d, "*.desktop")):
        try:
            txt = open(path, encoding="utf-8", errors="ignore").read()
            if "youtube music" in txt.lower() or "cinhimbnkkaeohfgghhklpknlkffjgod" in txt.lower():
                m = re.search(r"^Exec=(.+)$", txt, re.MULTILINE)
                print(f"🎯 [Atalho Área de Trabalho detectado]: {os.path.basename(path)}")
                if m:
                    print(f"   Exec: {m.group(1).strip()}")
                found = True
        except Exception:
            pass
if not found:
    print("ℹ️  Nenhum .desktop do YouTube Music encontrado na Área de Trabalho (usará perfil cassio26@gmail / Profile 3).")
PYCHECK

# 4. Ativa na Zona Esquerda da barra se ainda não estiver ativo
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

# 5. Força recarregamento real do Applet no Cinnamon (v2.1)
if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" string:"${UUID}" >/dev/null 2>&1 || \
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" >/dev/null 2>&1 || true
    echo "✅ [3/3] Cinnamon recarregou a v2.1!"
fi
echo "=================================================================="
