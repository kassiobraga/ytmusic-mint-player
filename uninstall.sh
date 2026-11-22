#!/usr/bin/env bash
set -euo pipefail

UUID="ytmusic-player@antigravity"
APPLET_DEST="${HOME}/.local/share/cinnamon/applets/${UUID}"

echo "Removendo ${UUID}..."
rm -rf "${APPLET_DEST}"

if command -v gsettings >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    /usr/bin/python3 - <<'PYEOF'
import ast, subprocess
UUID = "ytmusic-player@antigravity"
try:
    raw = subprocess.check_output(["gsettings", "get", "org.cinnamon", "enabled-applets"], text=True).strip()
    applets = [a for a in ast.literal_eval(raw) if UUID not in a]
    formatted = "[" + ", ".join(f"'{a}'" for a in applets) + "]"
    subprocess.check_call(["gsettings", "set", "org.cinnamon", "enabled-applets", formatted])
except Exception:
    pass
PYEOF
fi

echo "✅ Desinstalado com sucesso."
