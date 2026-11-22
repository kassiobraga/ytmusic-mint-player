#!/usr/bin/env bash
# ==============================================================================
# Instalador Automático - YouTube Music Taskbar Player (Hybrid Vinyl)
# Focado em Linux Mint (Cinnamon) - Zona Esquerda da Barra de Tarefas
# ==============================================================================
set -euo pipefail

UUID="ytmusic-player@antigravity"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLET_SRC="${SCRIPT_DIR}/cinnamon-applet/${UUID}"
APPLET_DEST="${HOME}/.local/share/cinnamon/applets/${UUID}"

echo "=================================================================="
echo " 🎵 Instalando YouTube Music Taskbar Player (Híbrido Vinil)"
echo "=================================================================="

# 1. Copiar os arquivos do Applet para o diretório do Cinnamon
mkdir -p "${HOME}/.local/share/cinnamon/applets"
rm -rf "${APPLET_DEST}"
cp -r "${APPLET_SRC}" "${APPLET_DEST}"
echo "✅ [1/3] Applet copiado para: ${APPLET_DEST}"

# 2. Ativar automaticamente o Applet na Zona Esquerda (left) do painel principal
if command -v gsettings >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    python3 - <<'PYEOF'
import subprocess

UUID = "ytmusic-player@antigravity"
SCHEMA = "org.cinnamon"
KEY = "enabled-applets"

try:
    raw = subprocess.check_output(["gsettings", "get", SCHEMA, KEY], text=True).strip()
    import ast
    applets = ast.literal_eval(raw)
    already = any(UUID in entry for entry in applets)
    if not already:
        # Descobre o próximo instance_id livre
        max_id = 0
        for entry in applets:
            parts = entry.split(":")
            if len(parts) >= 4 and parts[3].isdigit():
                max_id = max(max_id, int(parts[3]))
        new_entry = f"panel1:left:0:{UUID}:{max_id + 1}"
        applets.append(new_entry)
        formatted = "[" + ", ".join(f"'{a}'" for a in applets) + "]"
        subprocess.check_call(["gsettings", "set", SCHEMA, KEY, formatted])
        print(f"✅ [2/3] Applet posicionado automaticamente na ESQUERDA da barra ({new_entry})!")
    else:
        print("ℹ️  [2/3] Applet já estava ativo na barra do Cinnamon.")
except Exception as e:
    print(f"⚠️  [2/3] Não foi possível ativar via gsettings automaticamente ({e}).")
    print("         Ative manualmente em: Botão direito na barra -> Applets -> YouTube Music Taskbar Player.")
PYEOF
else
    echo "ℹ️  [2/3] gsettings não detectado nesta sessão. Ative pelo menu Applets do Cinnamon."
fi

# 3. Recarregar o Applet via D-Bus do Cinnamon (sem fechar janelas abertas)
if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.Cinnamon --type=method_call \
        /org/Cinnamon org.Cinnamon.ReloadSpices string:"applet" >/dev/null 2>&1 || true
    echo "✅ [3/3] Cinnamon notificado para recarregar os Applets!"
fi

echo ""
echo "🎉 Pronto! O YouTube Music Taskbar Player já está instalado à esquerda da sua barra."
echo "   - Passe o mouse sobre o ícone/botões para abrir a janelinha estilo Dynamic Island."
echo "   - Use o scroll do mouse em cima dele para ajustar o volume."
