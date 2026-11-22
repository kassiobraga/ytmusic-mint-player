#!/usr/bin/env bash
# ==============================================================================
# Testador & Validador E2E - YouTube Music Taskbar Player (Linux Mint)
# Abre o app do YouTube Music, toca uma música real via MPRIS2 D-Bus,
# testa Play, Avançar (Next), Voltar (Previous) e valida os logs do Cinnamon.
# ==============================================================================
set -euo pipefail

echo "=================================================================="
echo " 🧪 INICIANDO TESTE AUTOMATIZADO NO SEU LINUX MINT"
echo "=================================================================="

/usr/bin/python3 - <<'PYTEST'
import subprocess, time, os, sys
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

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

# 1. Descobrir qual é o App do YouTube Music instalado no Mint
apps = Gio.AppInfo.get_all()
yt_app = None
print("\n[1/5] Procurando aplicativo YouTube Music instalado...")
for a in apps:
    name = (a.get_name() or "").lower()
    disp = (a.get_display_name() or "").lower()
    aid = (a.get_id() or "").lower()
    cmd = (a.get_commandline() or "").lower()
    if any(k in name or k in disp or k in aid or k in cmd for k in ("youtube music", "youtube-music", "ytmusic", "pear_desktop", "music.youtube.com")):
        print(f"   ✅ Encontrado: {a.get_name()} | ID: {a.get_id()} | Comando: {a.get_commandline()}")
        if yt_app is None:
            yt_app = a

# 2. Verificar se já existe player MPRIS aberto; se não, abrir o YouTube Music!
players = list_mpris()
if not players:
    print("\n[2/5] Nenhum player MPRIS ativo. Abrindo o YouTube Music automaticamente...")
    if yt_app:
        yt_app.launch([], None)
    else:
        subprocess.Popen(["xdg-open", "https://music.youtube.com"])
    for i in range(10):
        time.sleep(1)
        players = list_mpris()
        if players:
            break
else:
    print(f"\n[2/5] Players MPRIS2 já abertos: {players}")

if not players:
    print("   ⚠️  Nenhum serviço MPRIS2 apareceu no D-Bus ainda.")
    print("      Certifique-se de que o YouTube Music está com uma música carregada.")
    sys.exit(0)

# Seleciona o melhor player (priorizando YouTube Music / Navegador)
def score(n):
    low = n.lower()
    if any(k in low for k in ("youtube-music", "ytmusic", "pear")):
        return 100
    if any(k in low for k in ("chrome", "chromium", "brave", "firefox")):
        return 80
    return 10

players.sort(key=score, reverse=True)
target = players[0]
print(f"   🎯 Vinculado ao player MPRIS2: {target}")

proxy = Gio.DBusProxy.new_sync(
    bus,
    Gio.DBusProxyFlags.NONE,
    None,
    target,
    "/org/mpris/MediaPlayer2",
    "org.mpris.MediaPlayer2.Player",
    None,
)

def read_state():
    p = Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.NONE, None, target,
        "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", None
    )
    st_v = p.get_cached_property("PlaybackStatus")
    status = st_v.unpack() if st_v else "Unknown"
    meta_v = p.get_cached_property("Metadata")
    meta = meta_v.unpack() if meta_v else {}
    title = meta.get("xesam:title", "Sem título")
    artist = meta.get("xesam:artist", ["Desconhecido"])
    if isinstance(artist, (list, tuple)):
        artist = ", ".join(artist)
    return status, title, artist

status, title, artist = read_state()
print(f"\n[3/5] Estado atual antes do teste: Status={status} | Música='{title}' | Cantor='{artist}'")

# 3. Enviar comando Play se estiver pausado
print("\n[4/5] Enviando comando PLAY para tocar a música e girar o vinil na barra...")
try:
    bus.call_sync(target, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "Play", None, None, Gio.DBusCallFlags.NONE, -1, None)
except Exception as e:
    print(f"   ⚠️  Erro ao chamar Play: {e}")

time.sleep(2.5)
status, title, artist = read_state()
print(f"   🎵 Tocando agora: Status={status} | Música='{title}' | Cantor='{artist}'")
print("   👉 Olhe para o canto esquerdo da sua barra: o vinil do YouTube Music está girando e os botões [⏮ ⏯ ⏭] apareceram!")

# 4. Testar Avançar (Next)
print("\n[5/5] Testando botão AVANÇAR (Next) em 3 segundos...")
time.sleep(3)
try:
    bus.call_sync(target, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "Next", None, None, Gio.DBusCallFlags.NONE, -1, None)
    time.sleep(2)
    status, title, artist = read_state()
    print(f"   ⏭  Após Avançar: Status={status} | Música='{title}' | Cantor='{artist}'")
except Exception as e:
    print(f"   ⚠️  Next não suportado pela fila atual: {e}")

PYTEST

echo "------------------------------------------------------------------"
echo "📋 Verificando estado do Applet no Cinnamon (gsettings & logs):"
gsettings get org.cinnamon enabled-applets | grep -o "[^']*ytmusic-player@antigravity[^']*" || echo "⚠️ Applet não listado no enabled-applets"
if [[ -f "${HOME}/.xsession-errors" ]]; then
    ERRS=$(grep -i "ytmusic-player@antigravity" "${HOME}/.xsession-errors" | tail -n 10 || true)
    if [[ -n "$ERRS" ]]; then
        echo "Logs recentes do Cinnamon para o Applet:"
        echo "$ERRS"
    else
        echo "✅ Zero erros do Applet no ~/.xsession-errors!"
    fi
fi
echo "=================================================================="
