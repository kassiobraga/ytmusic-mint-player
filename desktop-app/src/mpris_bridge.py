#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ponte MPRIS2 nativa via GLib/Gio (zero dependências npm de terceiros!).
Expõe org.mpris.MediaPlayer2.YoutubeMusic no session bus e conversa com
o processo principal do Electron por JSON lines via stdin/stdout.
"""

import json
import sys
import threading
import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

BUS_NAME = "org.mpris.MediaPlayer2.YoutubeMusic"
OBJ_PATH = "/org/mpris/MediaPlayer2"
NO_TRACK = "/org/mpris/MediaPlayer2/TrackList/NoTrack"

INTROSPECTION_XML = """
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Shuffle" type="b" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>
"""

state = {
    "playbackStatus": "Stopped",
    "volume": 1.0,
    "positionUs": 0,
    "durationUs": 0,
    "title": "",
    "artist": "",
    "album": "",
    "artUrl": "",
    "trackId": NO_TRACK,
}


def send_event(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def sanitize_track_id(video_id):
    if not video_id:
        return NO_TRACK
    clean = "".join(c if (c.isalnum() or c == "_") else "_" for c in str(video_id))
    return f"/org/ytmusic/mint/Track/{clean}" if clean else NO_TRACK


def build_metadata_variant():
    if not state["title"]:
        return GLib.Variant("a{sv}", {})
    meta = {
        "mpris:trackid": GLib.Variant("o", state["trackId"] or NO_TRACK),
        "mpris:length": GLib.Variant("x", max(0, int(state["durationUs"]))),
        "xesam:title": GLib.Variant("s", state["title"]),
        "xesam:artist": GLib.Variant("as", [state["artist"] or "YouTube Music"]),
        "xesam:album": GLib.Variant("s", state["album"] or "YouTube Music"),
    }
    if state["artUrl"]:
        meta["mpris:artUrl"] = GLib.Variant("s", state["artUrl"])
    return GLib.Variant("a{sv}", meta)


def emit_props_changed(bus, changed):
    if not changed:
        return
    try:
        bus.emit_signal(
            None,
            OBJ_PATH,
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
            GLib.Variant("(sa{sv}as)", ("org.mpris.MediaPlayer2.Player", changed, [])),
        )
    except Exception:
        pass


def emit_seeked(bus, pos_us):
    try:
        bus.emit_signal(
            None,
            OBJ_PATH,
            "org.mpris.MediaPlayer2.Player",
            "Seeked",
            GLib.Variant("(x)", (max(0, int(pos_us)),)),
        )
    except Exception:
        pass


def main():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION_XML)
    loop = GLib.MainLoop()

    def handle_method(conn, sender, path, iface, method, params, inv):
        if iface == "org.mpris.MediaPlayer2":
            if method == "Raise":
                send_event({"type": "raise"})
            elif method == "Quit":
                send_event({"type": "quit"})
        elif iface == "org.mpris.MediaPlayer2.Player":
            if method == "Next":
                send_event({"type": "command", "cmd": "next"})
            elif method == "Previous":
                send_event({"type": "command", "cmd": "previous"})
            elif method == "Pause":
                send_event({"type": "command", "cmd": "pause"})
            elif method == "Play":
                send_event({"type": "command", "cmd": "play"})
            elif method == "PlayPause":
                send_event({"type": "command", "cmd": "playPause"})
            elif method == "Stop":
                send_event({"type": "command", "cmd": "pause"})
            elif method == "Seek":
                offset_us = params.unpack()[0]
                send_event({"type": "command", "cmd": "seekBy", "arg": offset_us / 1e6})
            elif method == "SetPosition":
                _, pos_us = params.unpack()
                pos_us = max(0, int(pos_us))
                state["positionUs"] = pos_us
                send_event({"type": "command", "cmd": "seekTo", "arg": pos_us / 1e6})
                emit_seeked(bus, pos_us)
        inv.return_value(None)

    def handle_get(conn, sender, path, iface, prop):
        if iface == "org.mpris.MediaPlayer2":
            table = {
                "CanQuit": GLib.Variant("b", True),
                "CanRaise": GLib.Variant("b", True),
                "HasTrackList": GLib.Variant("b", False),
                "Identity": GLib.Variant("s", "YouTube Music"),
                "DesktopEntry": GLib.Variant("s", "ytmusic-mint-app"),
                "SupportedUriSchemes": GLib.Variant("as", ["https"]),
                "SupportedMimeTypes": GLib.Variant("as", ["audio/webm", "audio/mpeg", "audio/mp4"]),
            }
            return table.get(prop)
        if iface == "org.mpris.MediaPlayer2.Player":
            if prop == "PlaybackStatus":
                return GLib.Variant("s", state["playbackStatus"])
            if prop == "LoopStatus":
                return GLib.Variant("s", "None")
            if prop == "Rate":
                return GLib.Variant("d", 1.0)
            if prop == "Shuffle":
                return GLib.Variant("b", False)
            if prop == "Metadata":
                return build_metadata_variant()
            if prop == "Volume":
                return GLib.Variant("d", float(state["volume"]))
            if prop == "Position":
                return GLib.Variant("x", max(0, int(state["positionUs"])))
            if prop == "MinimumRate":
                return GLib.Variant("d", 1.0)
            if prop == "MaximumRate":
                return GLib.Variant("d", 1.0)
            if prop in ("CanGoNext", "CanGoPrevious", "CanPlay", "CanPause", "CanSeek", "CanControl"):
                return GLib.Variant("b", True)
        return None

    def handle_set(conn, sender, path, iface, prop, val):
        if iface == "org.mpris.MediaPlayer2.Player" and prop == "Volume":
            v = round(max(0.0, min(1.0, float(val.unpack()))), 2)
            state["volume"] = v
            send_event({"type": "command", "cmd": "setVolume", "arg": v})
            emit_props_changed(bus, {"Volume": GLib.Variant("d", v)})
            return True
        return False

    for iface in node.interfaces:
        bus.register_object(OBJ_PATH, iface, handle_method, handle_get, handle_set)

    Gio.bus_own_name_on_connection(
        bus,
        BUS_NAME,
        Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
        None,
        None,
    )

    def apply_update(data):
        changed = {}
        st = data.get("playbackStatus")
        if st in ("Playing", "Paused", "Stopped") and st != state["playbackStatus"]:
            state["playbackStatus"] = st
            changed["PlaybackStatus"] = GLib.Variant("s", st)

        vol = data.get("volume")
        if isinstance(vol, (int, float)):
            v = round(max(0.0, min(1.0, float(vol))), 2)
            if abs(v - state["volume"]) >= 0.01:
                state["volume"] = v
                changed["Volume"] = GLib.Variant("d", v)

        pos_sec = data.get("positionSec")
        if isinstance(pos_sec, (int, float)):
            new_pos = max(0, int(round(pos_sec * 1e6)))
            jumped = abs(new_pos - state["positionUs"]) > 2500000
            state["positionUs"] = new_pos
            if jumped and data.get("seeked"):
                emit_seeked(bus, new_pos)

        new_tid = sanitize_track_id(data.get("videoId"))
        dur_sec = data.get("durationSec")
        new_dur = max(0, int(round(dur_sec * 1e6))) if isinstance(dur_sec, (int, float)) else state["durationUs"]
        new_title = str(data.get("title", state["title"])).strip()
        new_artist = str(data.get("artist", state["artist"])).strip()
        new_album = str(data.get("album", state["album"])).strip()
        new_art = str(data.get("artUrl", state["artUrl"])).strip()

        if (
            new_tid != state["trackId"]
            or new_dur != state["durationUs"]
            or new_title != state["title"]
            or new_artist != state["artist"]
            or new_album != state["album"]
            or new_art != state["artUrl"]
        ):
            state["trackId"] = new_tid
            state["durationUs"] = new_dur
            state["title"] = new_title
            state["artist"] = new_artist
            state["album"] = new_album
            state["artUrl"] = new_art
            changed["Metadata"] = build_metadata_variant()

        emit_props_changed(bus, changed)
        return GLib.SOURCE_REMOVE

    def stdin_reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                if isinstance(msg, dict):
                    GLib.idle_add(apply_update, msg)
            except Exception:
                pass
        GLib.idle_add(loop.quit)

    t = threading.Thread(target=stdin_reader, daemon=True)
    t.start()
    send_event({"type": "ready"})
    loop.run()


if __name__ == "__main__":
    main()
