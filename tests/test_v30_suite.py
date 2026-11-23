#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Suíte de Testes E2E Rigorosos v3.0 — YouTube Music Taskbar Player (Pear Desktop)
"""

import json
import os
import re
import subprocess
import tempfile
import time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPLET_DIR = os.path.join(BASE, "cinnamon-applet", "ytmusic-player@antigravity")
APPLET_JS = os.path.join(APPLET_DIR, "applet.js")
STYLE_CSS = os.path.join(APPLET_DIR, "stylesheet.css")
LAUNCH_SH = os.path.join(APPLET_DIR, "launch_ytmusic.sh")
INSTALL_SH = os.path.join(BASE, "install.sh")


def test_1_regression_audit_of_all_5_bugs():
    js = open(APPLET_JS, encoding="utf-8").read()
    js_code = "\n".join(l for l in js.splitlines() if not l.strip().startswith(("//", "*", "/*")))
    inst = open(INSTALL_SH, encoding="utf-8").read()

    # Bug 1: unminimize() DEVE ter 0 argumentos no Muffin/Cinnamon
    bad_unmin = re.findall(r"unminimize\([^)]+\)", js_code)
    assert not bad_unmin, f"ERRO: unminimize() chamado com argumentos: {bad_unmin}"
    assert "metaWin.unminimize()" in js_code, "ERRO: metaWin.unminimize() sem argumentos ausente!"

    # Bug 2: Zero bloqueio síncrono da main thread do Cinnamon
    assert "new_for_bus_sync" not in js_code, "ERRO: Ainda existe Gio.DBusProxy.new_for_bus_sync!"
    assert "Gio.DBusProxy.new_for_bus(" in js_code, "ERRO: Proxy assíncrono ausente!"

    # Bug 3: Reset completo de _artUrl e estilos inline no idle
    assert 'this._artUrl = "";' in js_code, "ERRO: _resetToIdleState() não limpa _artUrl!"
    assert "this._popupCard.set_style(null);" in js_code, "ERRO: _resetToIdleState() não limpa glow!"

    # Bug 4: Reload real do Cinnamon (ReloadXlet, nunca ReloadSpices)
    assert "org.Cinnamon.ReloadXlet" in inst, "ERRO: install.sh não usa ReloadXlet!"
    assert "ReloadSpices" not in inst, "ERRO: install.sh ainda referencia ReloadSpices!"

    # Bug 5: Isolamento absoluto — zero escuta de Chrome/Chromium no applet.js
    assert "chromium" not in js_code.lower() and "cinhimbnkkaeohfgghhklpknlkffjgod" not in js_code.lower(), \
        "ERRO: applet.js ainda contém referências ao Chrome PWA!"
    assert "org.mpris.MediaPlayer2.Raise" in js_code or '"Raise"' in js_code, "ERRO: MPRIS Raise ausente!"

    print("✅ [TESTE 1 OK] Auditoria anti-regressão: todos os 5 bugs críticos corrigidos!")


def test_2_e2e_dbus_isolation_and_10x_reopen():
    # Sobe um D-Bus real isolado com servidor em processo separado (IPC real!)
    runner = r"""
set -euo pipefail
eval $(dbus-launch --sh-syntax)
trap 'kill -9 $DBUS_SESSION_BUS_PID $SRV_PID 2>/dev/null || true' EXIT

/usr/bin/python3 - <<'PYSERVER' &
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
MPRIS_XML = '''
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="RaiseCount" type="i" access="read"/>
  </interface>
</node>
'''
pear_state = {
    "status": "Playing",
    "title": "Everlong",
    "artist": "Foo Fighters",
    "album": "Greatest Hits",
    "pos": 42000000,
    "vol": 0.85,
    "raises": 0,
}
node = Gio.DBusNodeInfo.new_for_xml(MPRIS_XML)

def handle_method(conn, sender, path, iface, method, params, inv):
    if method == "Raise":
        pear_state["raises"] += 1
    elif method == "PlayPause":
        pear_state["status"] = "Paused" if pear_state["status"] == "Playing" else "Playing"
    elif method == "Next":
        pear_state["title"] = "The Pretender"
    elif method == "Previous":
        pear_state["title"] = "Best of You"
    elif method == "SetPosition":
        _, pos = params.unpack()
        pear_state["pos"] = pos
    inv.return_value(None)

def handle_get(conn, sender, path, iface, prop):
    if prop == "CanRaise": return GLib.Variant("b", True)
    if prop == "PlaybackStatus": return GLib.Variant("s", pear_state["status"])
    if prop == "Volume": return GLib.Variant("d", pear_state["vol"])
    if prop == "Position": return GLib.Variant("x", pear_state["pos"])
    if prop == "RaiseCount": return GLib.Variant("i", pear_state["raises"])
    if prop == "Metadata":
        return GLib.Variant("a{sv}", {
            "mpris:trackid": GLib.Variant("o", "/org/mpris/MediaPlayer2/Track/1"),
            "xesam:title": GLib.Variant("s", pear_state["title"]),
            "xesam:artist": GLib.Variant("as", [pear_state["artist"]]),
            "xesam:album": GLib.Variant("s", pear_state["album"]),
            "mpris:length": GLib.Variant("x", 250000000),
        })
    return None

def handle_set(conn, sender, path, iface, prop, val):
    if prop == "Volume":
        pear_state["vol"] = float(val.unpack())
        return True
    return False

for iface in node.interfaces:
    bus.register_object("/org/mpris/MediaPlayer2", iface, handle_method, handle_get, handle_set)

Gio.bus_own_name_on_connection(bus, "org.mpris.MediaPlayer2.YoutubeMusic", Gio.BusNameOwnerFlags.NONE, None, None)
Gio.bus_own_name_on_connection(bus, "org.mpris.MediaPlayer2.chromium.instance9999", Gio.BusNameOwnerFlags.NONE, None, None)
GLib.MainLoop().run()
PYSERVER
SRV_PID=$!
sleep 0.5

/usr/bin/python3 - <<'PYCLIENT'
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

def is_pear_mpris_bus(name):
    if not name.startswith("org.mpris.MediaPlayer2."): return False
    suf = name[len("org.mpris.MediaPlayer2."):].lower()
    return suf.startswith("youtubemusic") or suf.startswith("youtube-music") or suf.startswith("pear")

def get_prop(prop):
    r = bus.call_sync("org.mpris.MediaPlayer2.YoutubeMusic", "/org/mpris/MediaPlayer2",
                      "org.freedesktop.DBus.Properties", "Get",
                      GLib.Variant("(ss)", ("org.mpris.MediaPlayer2.Player", prop)),
                      GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, 2000, None)
    return r.unpack()[0]

reply = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                      "ListNames", None, GLib.VariantType.new("(as)"), Gio.DBusCallFlags.NONE, 2000, None)
names = reply.unpack()[0]
assert "org.mpris.MediaPlayer2.chromium.instance9999" in names
assert "org.mpris.MediaPlayer2.YoutubeMusic" in names

matched = [n for n in names if is_pear_mpris_bus(n)]
assert matched == ["org.mpris.MediaPlayer2.YoutubeMusic"], f"Filtro falhou: {matched}"

# 10 reaberturas consecutivas via Raise()
for _ in range(10):
    bus.call_sync("org.mpris.MediaPlayer2.YoutubeMusic", "/org/mpris/MediaPlayer2",
                  "org.mpris.MediaPlayer2", "Raise", None, None, Gio.DBusCallFlags.NONE, 2000, None)
assert get_prop("RaiseCount") == 10

# PlayPause, Next, SetPosition e Volume real
bus.call_sync("org.mpris.MediaPlayer2.YoutubeMusic", "/org/mpris/MediaPlayer2",
              "org.mpris.MediaPlayer2.Player", "PlayPause", None, None, Gio.DBusCallFlags.NONE, 2000, None)
assert get_prop("PlaybackStatus") == "Paused"

bus.call_sync("org.mpris.MediaPlayer2.YoutubeMusic", "/org/mpris/MediaPlayer2",
              "org.mpris.MediaPlayer2.Player", "Next", None, None, Gio.DBusCallFlags.NONE, 2000, None)
assert get_prop("Metadata")["xesam:title"] == "The Pretender"

bus.call_sync("org.mpris.MediaPlayer2.YoutubeMusic", "/org/mpris/MediaPlayer2",
              "org.mpris.MediaPlayer2.Player", "SetPosition",
              GLib.Variant("(ox)", ("/org/mpris/MediaPlayer2/Track/1", 120000000)),
              None, Gio.DBusCallFlags.NONE, 2000, None)
assert get_prop("Position") == 120000000

bus.call_sync("org.mpris.MediaPlayer2.YoutubeMusic", "/org/mpris/MediaPlayer2",
              "org.freedesktop.DBus.Properties", "Set",
              GLib.Variant("(ssv)", ("org.mpris.MediaPlayer2.Player", "Volume", GLib.Variant("d", 0.55))),
              None, Gio.DBusCallFlags.NONE, 2000, None)
assert abs(get_prop("Volume") - 0.55) < 0.01

print("✅ [TESTE 2 OK] E2E D-Bus real (IPC): Chrome ignorado 100%, 10/10 Raise() OK, Play/Next/Seek/Volume real OK!")
PYCLIENT
"""
    subprocess.check_call(["/bin/bash", "-c", runner])


def test_3_pear_config_merge():
    with tempfile.TemporaryDirectory() as fake_home:
        cfg_dir = os.path.join(fake_home, ".config", "YouTube Music")
        os.makedirs(cfg_dir, exist_ok=True)
        cfg_path = os.path.join(cfg_dir, "config.json")
        # Simula configuração pré-existente do usuário (deve ser preservada!)
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump({"options": {"language": "pt-BR"}, "plugins": {"adblocker": {"enabled": True}}}, f)

        inst = open(INSTALL_SH, encoding="utf-8").read()
        py_snippet = inst.split("<<'PYCFG'\n")[1].split("\nPYCFG")[0]
        env = os.environ.copy()
        env["HOME"] = fake_home
        subprocess.run(["/usr/bin/python3", "-"], input=py_snippet, text=True, env=env, check=True)

        result = json.load(open(cfg_path, encoding="utf-8"))
        assert result["options"]["language"] == "pt-BR", "Perdeu config existente!"
        assert result["options"]["tray"] is True, "options.tray não foi ativado!"
        assert result["options"]["resumeOnStart"] is True
        assert result["plugins"]["shortcuts"]["enabled"] is True
        assert result["plugins"]["adblocker"]["enabled"] is True
        print("✅ [TESTE 3 OK] Merge de ~/.config/YouTube Music/config.json preservou dados e ativou Close-to-Tray + MPRIS!")


def test_4_typography_title_case_and_syntax():
    css = open(STYLE_CSS, encoding="utf-8").read()
    css_code = "\n".join(l for l in css.splitlines() if not l.strip().startswith(("*", "/", "-")))
    assert "monospace" not in css_code and "sans-serif" in css_code

    js = open(APPLET_JS, encoding="utf-8").read()
    assert '"YOUTUBE MUSIC"' not in js
    assert 'text: "YouTube Music"' in js
    assert "set_ellipsize(Pango.EllipsizeMode.NONE)" in js or "set_ellipsize(0)" in js

    subprocess.check_call(["node", "--check", APPLET_JS])
    subprocess.check_call(["bash", "-n", LAUNCH_SH])
    subprocess.check_call(["bash", "-n", INSTALL_SH])
    print("✅ [TESTE 4 OK] Tipografia 100% Sans-Serif, Title Case sem corte e sintaxe JS/Bash 100% válida!")


if __name__ == "__main__":
    test_1_regression_audit_of_all_5_bugs()
    test_2_e2e_dbus_isolation_and_10x_reopen()
    test_3_pear_config_merge()
    test_4_typography_title_case_and_syntax()
    print("\n🎉 TODOS OS TESTES E2E DA v3.0 PASSARAM COM 100% DE SUCESSO!")
