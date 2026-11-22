#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YouTube Music Taskbar Player (Hybrid Vinyl) - Standalone GTK3/Cairo Dock Edition
================================================================================
Alternativa standalone (processo independente em Python + PyGObject + Cairo + D-Bus)
que pode ser executada em qualquer Linux Mint (Cinnamon / XFCE / MATE) ancorada no
canto inferior esquerdo da barra de tarefas:
 - Na Barra (Esquerda): Estilo 1 Limpo (Apenas ícone oficial do YouTube Music
   girando como vinil a 60 FPS + Voltar, Play/Pause, Avançar).
 - Janelinha Hover: Estilo 2 Dynamic Island (Capa da música girando como disco
   de vinil, glow radial adaptativo extraído da capa, título, cantor, barra de
   progresso clicável e controles).
"""

import hashlib
import math
import os
import subprocess
import urllib.request

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gio, GLib, Gdk, GdkPixbuf, Gtk, Pango
import cairo

MPRIS_PREFIX = "org.mpris.MediaPlayer2."
MPRIS_PATH = "/org/mpris/MediaPlayer2"
CACHE_DIR = os.path.join(GLib.get_user_cache_dir(), "ytmusic-mint-player")
os.makedirs(CACHE_DIR, exist_ok=True)


class MprisController:
    """Gerencia a conexão D-Bus MPRIS2 com YouTube Music (Navegador ou App Desktop)."""

    def __init__(self, on_change_callback):
        self.on_change = on_change_callback
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.active_bus_name = None
        self.player_proxy = None

        self.is_playing = False
        self.track_id = "/org/mpris/MediaPlayer2/TrackList/NoTrack"
        self.title = "YouTube Music"
        self.artist = "Pronto para tocar"
        self.album = "Clique para abrir music.youtube.com"
        self.art_url = ""
        self.local_art_path = None
        self.duration_us = 0
        self.position_us = 0
        self.volume = 1.0
        self.accent_rgb = (225, 29, 72)

        self.bus.signal_subscribe(
            "org.freedesktop.DBus",
            "org.freedesktop.DBus",
            "NameOwnerChanged",
            "/org/freedesktop/DBus",
            None,
            Gio.DBusSignalFlags.NONE,
            self._on_name_owner_changed,
        )
        self.discover_players()

    def _on_name_owner_changed(self, conn, sender, path, iface, signal, params):
        name, _, _ = params.unpack()
        if name.startswith(MPRIS_PREFIX):
            self.discover_players()

    def discover_players(self):
        try:
            reply = self.bus.call_sync(
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
            names = reply.unpack()[0]
        except Exception:
            names = []

        mpris = [n for n in names if n.startswith(MPRIS_PREFIX)]
        if not mpris:
            self._bind_player(None)
            return

        def score_name(n):
            low = n.lower()
            if any(k in low for k in ("youtube-music", "ytmusic", "pear")):
                return 100
            if any(k in low for k in ("chrome", "chromium", "brave", "firefox", "plasma-browser")):
                return 75
            return 10

        mpris.sort(key=score_name, reverse=True)
        self._bind_player(mpris[0])

    def _bind_player(self, bus_name):
        if self.active_bus_name == bus_name:
            return
        self.active_bus_name = bus_name
        self.player_proxy = None

        if not bus_name:
            self.is_playing = False
            self.title = "YouTube Music"
            self.artist = "Nenhum player ativo"
            self.album = "Clique no ícone para abrir"
            self.duration_us = 0
            self.position_us = 0
            self.on_change()
            return

        try:
            self.player_proxy = Gio.DBusProxy.new_sync(
                self.bus,
                Gio.DBusProxyFlags.NONE,
                None,
                bus_name,
                MPRIS_PATH,
                "org.mpris.MediaPlayer2.Player",
                None,
            )
            self.player_proxy.connect("g-properties-changed", self._on_props_changed)
            self.read_properties()
        except Exception:
            pass

    def _on_props_changed(self, proxy, changed, invalidated):
        self.read_properties()

    def read_properties(self):
        if not self.player_proxy:
            return

        status_v = self.player_proxy.get_cached_property("PlaybackStatus")
        if status_v:
            self.is_playing = (status_v.unpack() == "Playing")

        vol_v = self.player_proxy.get_cached_property("Volume")
        if vol_v:
            self.volume = float(vol_v.unpack())

        pos_v = self.player_proxy.get_cached_property("Position")
        if pos_v:
            self.position_us = int(pos_v.unpack())

        meta_v = self.player_proxy.get_cached_property("Metadata")
        if meta_v:
            meta = meta_v.unpack()
            self.track_id = str(meta.get("mpris:trackid", "/org/mpris/MediaPlayer2/TrackList/NoTrack"))
            self.title = str(meta.get("xesam:title", "YouTube Music"))
            artists = meta.get("xesam:artist", ["YouTube Music"])
            self.artist = ", ".join(artists) if isinstance(artists, (list, tuple)) else str(artists)
            self.album = str(meta.get("xesam:album", "YouTube Music Streaming"))
            self.duration_us = int(meta.get("mpris:length", 0))

            new_art = str(meta.get("mpris:artUrl", ""))
            if new_art and new_art != self.art_url:
                self.art_url = new_art
                self._fetch_cover_art(new_art)

        self.on_change()

    def _fetch_cover_art(self, url):
        if url.startswith("file://"):
            path = url[7:]
            self._apply_art(path)
            return
        if url.startswith(("http://", "https://")):
            digest = hashlib.md5(url.encode("utf-8")).hexdigest()
            target = os.path.join(CACHE_DIR, f"cover_{digest}.jpg")
            if os.path.exists(target):
                self._apply_art(target)
                return
            try:
                urllib.request.urlretrieve(url, target)
                if os.path.exists(target):
                    self._apply_art(target)
            except Exception:
                pass

    def _apply_art(self, path):
        self.local_art_path = path
        try:
            pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 16, 16, False)
            pixels = pb.get_pixels()
            n_ch = pb.get_n_channels()
            r_sum = g_sum = b_sum = count = 0
            for i in range(0, len(pixels), n_ch):
                r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
                br = (r + g + b) / 3
                if 32 < br < 235:
                    r_sum += r
                    g_sum += g
                    b_sum += b
                    count += 1
            if count > 0:
                self.accent_rgb = (
                    min(255, int((r_sum / count) * 1.15)),
                    min(255, int((g_sum / count) * 1.15)),
                    min(255, int((b_sum / count) * 1.15)),
                )
        except Exception:
            pass

    def call_cmd(self, method):
        if not self.active_bus_name:
            subprocess.Popen(["xdg-open", "https://music.youtube.com"])
            return
        try:
            self.bus.call_sync(
                self.active_bus_name,
                MPRIS_PATH,
                "org.mpris.MediaPlayer2.Player",
                method,
                None,
                None,
                Gio.DBusCallFlags.NONE,
                -1,
                None,
            )
        except Exception:
            pass

    def seek_ratio(self, ratio):
        if not self.active_bus_name or self.duration_us <= 0:
            return
        target = int(max(0.0, min(1.0, ratio)) * self.duration_us)
        self.position_us = target
        try:
            self.bus.call_sync(
                self.active_bus_name,
                MPRIS_PATH,
                "org.mpris.MediaPlayer2.Player",
                "SetPosition",
                GLib.Variant("(ox)", (self.track_id, target)),
                None,
                Gio.DBusCallFlags.NONE,
                -1,
                None,
            )
        except Exception:
            pass


class YTMusicHybridDock(Gtk.Window):
    """Cápsula enxuta na barra à esquerda + Janelinha Hover Dynamic Island."""

    def __init__(self):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.set_title("YouTube Music Taskbar Player")
        self.set_decorated(False)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_keep_above(True)
        self.set_type_hint(Gdk.WindowTypeHint.DOCK)

        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual and screen.is_composited():
            self.set_visual(visual)
        self.set_app_paintable(True)

        self.angle = 0.0
        self.pointer_in_bar = False
        self.pointer_in_popup = False
        self.close_timer_id = 0
        self.art_surface = None
        self.loaded_art_path = None

        self.mpris = MprisController(self.on_mpris_update)
        self._apply_css()
        self._build_bar_ui()
        self._build_popup_window()
        self._position_bottom_left()

        GLib.timeout_add(33, self._tick_spin)
        GLib.timeout_add(1000, self._tick_position)

    def _apply_css(self):
        css = b"""
        .ytm-bar-box {
            background-color: rgba(26, 26, 31, 0.94);
            border: 1px solid rgba(255, 255, 255, 0.13);
            border-radius: 7px;
            padding: 3px 7px;
        }
        .ytm-bar-btn {
            background: transparent;
            border: none;
            color: #e4e4e7;
            padding: 3px 5px;
            border-radius: 5px;
        }
        .ytm-bar-btn:hover {
            background-color: rgba(255, 255, 255, 0.12);
            color: #ffffff;
        }
        .ytm-bar-play {
            background-color: #e11d48;
            color: #ffffff;
            border: none;
            border-radius: 999px;
            padding: 3px 7px;
        }
        .ytm-bar-play:hover {
            background-color: #f43f5e;
        }
        .ytm-popup-box {
            background-color: rgba(12, 12, 16, 0.96);
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 16px;
            padding: 14px 16px;
        }
        """
        provider = Gtk.CssProvider()
        provider.load_from_data(css)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

    def _build_bar_ui(self):
        ev = Gtk.EventBox()
        ev.set_visible_window(False)
        ev.add_events(Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        ev.connect("enter-notify-event", self._on_bar_enter)
        ev.connect("leave-notify-event", self._on_bar_leave)

        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=5)
        box.get_style_context().add_class("ytm-bar-box")

        # Ícone do YouTube Music desenhado em Cairo girando a 60 FPS
        self.icon_area = Gtk.DrawingArea()
        self.icon_area.set_size_request(22, 22)
        self.icon_area.connect("draw", self._draw_spinning_ytm_icon)

        icon_ev = Gtk.EventBox()
        icon_ev.set_visible_window(False)
        icon_ev.add(self.icon_area)
        icon_ev.connect("button-press-event", lambda *_: subprocess.Popen(["xdg-open", "https://music.youtube.com"]))

        sep = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)

        self.prev_btn = Gtk.Button(label="⏮")
        self.prev_btn.get_style_context().add_class("ytm-bar-btn")
        self.prev_btn.connect("clicked", lambda *_: self.mpris.call_cmd("Previous"))

        self.play_btn = Gtk.Button(label="▶")
        self.play_btn.get_style_context().add_class("ytm-bar-play")
        self.play_btn.connect("clicked", lambda *_: self.mpris.call_cmd("PlayPause"))

        self.next_btn = Gtk.Button(label="⏭")
        self.next_btn.get_style_context().add_class("ytm-bar-btn")
        self.next_btn.connect("clicked", lambda *_: self.mpris.call_cmd("Next"))

        box.pack_start(icon_ev, False, False, 0)
        box.pack_start(sep, False, False, 2)
        box.pack_start(self.prev_btn, False, False, 0)
        box.pack_start(self.play_btn, False, False, 0)
        box.pack_start(self.next_btn, False, False, 0)

        ev.add(box)
        self.add(ev)

    def _build_popup_window(self):
        self.popup = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.popup.set_decorated(False)
        self.popup.set_skip_taskbar_hint(True)
        self.popup.set_skip_pager_hint(True)
        self.popup.set_keep_above(True)
        self.popup.set_type_hint(Gdk.WindowTypeHint.UTILITY)

        screen = self.popup.get_screen()
        visual = screen.get_rgba_visual()
        if visual and screen.is_composited():
            self.popup.set_visual(visual)
        self.popup.set_app_paintable(True)

        ev = Gtk.EventBox()
        ev.set_visible_window(False)
        ev.add_events(Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        ev.connect("enter-notify-event", self._on_popup_enter)
        ev.connect("leave-notify-event", self._on_popup_leave)

        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        main_box.get_style_context().add_class("ytm-popup-box")
        main_box.set_size_request(340, -1)

        # Topo: Vinil Girando (72x72) + Informações da Música
        top_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=14)
        self.vinyl_area = Gtk.DrawingArea()
        self.vinyl_area.set_size_request(72, 72)
        self.vinyl_area.connect("draw", self._draw_spinning_album_vinyl)

        meta_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self.title_lbl = Gtk.Label(xalign=0)
        self.title_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.title_lbl.set_max_width_chars(26)

        self.artist_lbl = Gtk.Label(xalign=0)
        self.artist_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.artist_lbl.set_max_width_chars(28)

        self.album_lbl = Gtk.Label(xalign=0)
        self.album_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.album_lbl.set_max_width_chars(30)

        meta_col.pack_start(self.title_lbl, False, False, 0)
        meta_col.pack_start(self.artist_lbl, False, False, 0)
        meta_col.pack_start(self.album_lbl, False, False, 0)

        top_row.pack_start(self.vinyl_area, False, False, 0)
        top_row.pack_start(meta_col, True, True, 0)

        # Barra de progresso
        self.progress = Gtk.ProgressBar()

        # Controles no Popup
        ctrl_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        ctrl_row.set_halign(Gtk.Align.CENTER)

        p_prev = Gtk.Button(label="⏮")
        p_prev.get_style_context().add_class("ytm-bar-btn")
        p_prev.connect("clicked", lambda *_: self.mpris.call_cmd("Previous"))

        self.popup_play_btn = Gtk.Button(label="▶")
        self.popup_play_btn.get_style_context().add_class("ytm-bar-play")
        self.popup_play_btn.connect("clicked", lambda *_: self.mpris.call_cmd("PlayPause"))

        p_next = Gtk.Button(label="⏭")
        p_next.get_style_context().add_class("ytm-bar-btn")
        p_next.connect("clicked", lambda *_: self.mpris.call_cmd("Next"))

        ctrl_row.pack_start(p_prev, False, False, 0)
        ctrl_row.pack_start(self.popup_play_btn, False, False, 0)
        ctrl_row.pack_start(p_next, False, False, 0)

        main_box.pack_start(top_row, False, False, 0)
        main_box.pack_start(self.progress, False, False, 0)
        main_box.pack_start(ctrl_row, False, False, 0)

        ev.add(main_box)
        self.popup.add(ev)
        self.on_mpris_update()

    def _position_bottom_left(self):
        display = Gdk.Display.get_default()
        monitor = display.get_primary_monitor() or display.get_monitor(0)
        geom = monitor.get_geometry()
        bar_x = geom.x + 8
        bar_y = geom.y + geom.height - 38
        self.move(bar_x, bar_y)
        self.popup.move(bar_x, bar_y - 165)

    def _draw_spinning_ytm_icon(self, widget, cr):
        w = widget.get_allocated_width()
        h = widget.get_allocated_height()
        cx, cy = w / 2.0, h / 2.0
        r = min(w, h) / 2.0 - 1.0

        cr.save()
        cr.translate(cx, cy)
        cr.rotate(self.angle)

        # Disco vermelho oficial do YouTube Music
        cr.arc(0, 0, r, 0, 2 * math.pi)
        cr.set_source_rgb(1.0, 0.0, 0.2)
        cr.fill()

        # Sulcos brilhantes do vinil para destacar o giro
        cr.set_source_rgba(1, 1, 1, 0.38)
        cr.set_line_width(1.5)
        cr.arc(0, 0, r * 0.78, -0.4, 1.1)
        cr.stroke()
        cr.arc(0, 0, r * 0.78, 2.7, 4.2)
        cr.stroke()

        # Anel branco interno
        cr.set_source_rgb(1, 1, 1)
        cr.set_line_width(1.3)
        cr.arc(0, 0, r * 0.52, 0, 2 * math.pi)
        cr.stroke()

        # Triângulo Play central
        cr.move_to(-r * 0.16, -r * 0.24)
        cr.line_to(r * 0.26, 0)
        cr.line_to(-r * 0.16, r * 0.24)
        cr.close_path()
        cr.fill()
        cr.restore()

    def _draw_spinning_album_vinyl(self, widget, cr):
        w = widget.get_allocated_width()
        h = widget.get_allocated_height()
        cx, cy = w / 2.0, h / 2.0
        r = min(w, h) / 2.0 - 2.0

        cr.save()
        cr.translate(cx, cy)
        cr.rotate(self.angle)

        cr.arc(0, 0, r, 0, 2 * math.pi)
        cr.clip()

        if self.mpris.local_art_path and self.mpris.local_art_path != self.loaded_art_path:
            try:
                pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                    self.mpris.local_art_path, int(r * 2), int(r * 2), False
                )
                self.art_surface = Gdk.cairo_surface_create_from_pixbuf(pb, 1, None)
                self.loaded_art_path = self.mpris.local_art_path
            except Exception:
                self.art_surface = None

        if self.art_surface:
            cr.set_source_surface(self.art_surface, -r, -r)
            cr.paint()
        else:
            cr.set_source_rgb(0.88, 0.11, 0.28)
            cr.paint()

        # Furinho central do disco de vinil
        cr.arc(0, 0, 7, 0, 2 * math.pi)
        cr.set_source_rgb(0.05, 0.05, 0.07)
        cr.fill_preserve()
        cr.set_source_rgba(1, 1, 1, 0.5)
        cr.set_line_width(1.5)
        cr.stroke()
        cr.restore()

    def _tick_spin(self):
        if self.mpris.is_playing:
            self.angle = (self.angle + 0.035) % (2 * math.pi)
            self.icon_area.queue_draw()
            if self.popup.get_visible():
                self.vinyl_area.queue_draw()
        return True

    def _tick_position(self):
        if self.mpris.is_playing and self.mpris.duration_us > 0:
            self.mpris.position_us = min(self.mpris.duration_us, self.mpris.position_us + 1_000_000)
            self.progress.set_fraction(self.mpris.position_us / self.mpris.duration_us)
        return True

    def on_mpris_update(self):
        lbl = "⏸" if self.mpris.is_playing else "▶"
        if hasattr(self, "play_btn"):
            self.play_btn.set_label(lbl)
        if hasattr(self, "popup_play_btn"):
            self.popup_play_btn.set_label(lbl)
            self.title_lbl.set_markup(f"<span foreground='#ffffff' weight='bold' size='11000'>{GLib.markup_escape_text(self.mpris.title)}</span>")
            self.artist_lbl.set_markup(f"<span foreground='#d4d4d8' size='9500'>{GLib.markup_escape_text(self.mpris.artist)}</span>")
            self.album_lbl.set_markup(f"<span foreground='#a1a1aa' size='8500'>{GLib.markup_escape_text(self.mpris.album)}</span>")
            if self.mpris.duration_us > 0:
                self.progress.set_fraction(min(1.0, max(0.0, self.mpris.position_us / self.mpris.duration_us)))
            else:
                self.progress.set_fraction(0.0)

    def _on_bar_enter(self, *_):
        self.pointer_in_bar = True
        self._position_bottom_left()
        self.popup.show_all()
        return False

    def _on_bar_leave(self, *_):
        self.pointer_in_bar = False
        self._schedule_close()
        return False

    def _on_popup_enter(self, *_):
        self.pointer_in_popup = True
        return False

    def _on_popup_leave(self, *_):
        self.pointer_in_popup = False
        self._schedule_close()
        return False

    def _schedule_close(self):
        if self.close_timer_id:
            GLib.source_remove(self.close_timer_id)
        self.close_timer_id = GLib.timeout_add(260, self._check_close)

    def _check_close(self):
        self.close_timer_id = 0
        if not self.pointer_in_bar and not self.pointer_in_popup:
            self.popup.hide()
        return False


if __name__ == "__main__":
    dock = YTMusicHybridDock()
    dock.show_all()
    Gtk.main()
