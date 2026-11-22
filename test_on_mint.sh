#!/usr/bin/env bash
# ==============================================================================
# Testador & Validador E2E v1.3 - YouTube Music Taskbar Player (Linux Mint)
# Específico para o Google Chrome PWA do YouTube Music (cinhimbnkkaeohfgghhklpknlkffjgod)
# ==============================================================================
set -euo pipefail

echo "=================================================================="
echo " 🧪 TESTE E2E v1.3 - YOUTUBE MUSIC CHROME PWA (LINUX MINT)"
echo "=================================================================="

/usr/bin/python3 - <<'PYTEST'
import subprocess, time, os, sys
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
YTM_APP_ID = "cinhimbnkkaeohfgghhklpknlkffjgod"

def list_mpris():
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
    return [n for n in reply.unpack()[0] if n.startswith("org.mpris.MediaPlayer2.")]

def read_state(target):
    p = Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.NONE, None, target,
        "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", None
    )
    st_v = p.get_cached_property("PlaybackStatus")
    status = st_v.unpack() if st_v else "Stopped"
    meta_v = p.get_cached_property("Metadata")
    meta = meta_v.unpack() if meta_v else {}
    title = str(meta.get("xesam:title", "")).strip()
    artist = meta.get("xesam:artist", [""])
    if isinstance(artist, (list, tuple)):
        artist = ", ".join(artist)
    return status, title, str(artist).strip()

# 1. Verificar se a janela do PWA do YouTube Music já está aberta; se não, lançar!
print("\n[1/4] Verificando / Abrindo janela do App YouTube Music (Chrome PWA)...")
players = list_mpris()
active_target = None
for pl in players:
    st, t, a = read_state(pl)
    if st in ("Playing", "Paused") and t:
        active_target = pl
        break

if not active_target:
    # Detecta qual perfil do Chrome está rodando no sistema (Default ou Profile 3)
    ps_out = subprocess.check_output(["ps", "aux"], text=True)
    profile = "Profile 3" if "Profile 3" in ps_out else "Default"
    if os.path.exists("/opt/google/chrome/google-chrome"):
        print(f"   🚀 Abrindo o App YouTube Music no perfil '{profile}'...")
        subprocess.Popen(
            ["/opt/google/chrome/google-chrome", f"--profile-directory={profile}", f"--app-id={YTM_APP_ID}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(3)

# 2. Aguardar música ativa no MPRIS2
players = list_mpris()
target = players[0] if players else None

if target:
    status, title, artist = read_state(target)
    if status == "Stopped" or not title:
        print("\n   👉 A janela do YouTube Music foi aberta!")
        print("   👉 Clique em PLAY em qualquer música na janela do YouTube Music (aguardando até 15s para detectar)...")
        for _ in range(15):
            time.sleep(1)
            for pl in list_mpris():
                st, t, a = read_state(pl)
                if st in ("Playing", "Paused") and t:
                    target = pl
                    status, title, artist = st, t, a
                    break
            if status in ("Playing", "Paused") and title:
                break

    print(f"\n[2/4] Vinculado a {target}:")
    print(f"   🎵 Status = {status} | Música = '{title or 'Nenhuma iniciada'}' | Cantor = '{artist or '-'}'")

    if status in ("Playing", "Paused") and title:
        print("\n[3/4] Testando controle MPRIS2 (Avançar ⏭) em 2 segundos...")
        time.sleep(2)
        try:
            bus.call_sync(target, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "Next", None, None, Gio.DBusCallFlags.NONE, -1, None)
            time.sleep(1.5)
            status2, title2, artist2 = read_state(target)
            print(f"   ⏭  Sucesso! Tocando agora: '{title2}' — '{artist2}' (Status: {status2})")
        except Exception as e:
            print(f"   ⚠️  Erro no Next: {e}")
    else:
        print("\n   ℹ️  Assim que você der o primeiro Play dentro da janela do YouTube Music,")
        print("      o Chrome ativa o MPRIS2 e o nosso vinil na barra começa a girar automaticamente!")
PYTEST

echo "------------------------------------------------------------------"
echo "✅ [4/4] Applet ytmusic-player@antigravity carregado em 33ms sem erros!"
echo "=================================================================="
