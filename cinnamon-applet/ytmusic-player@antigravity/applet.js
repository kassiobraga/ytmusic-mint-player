/* ==========================================================================
 * YouTube Music Taskbar Player (Hybrid Vinyl v1.3) - Cinnamon Applet
 * UUID: ytmusic-player@antigravity
 *
 * Otimizado especificamente para o Google Chrome PWA do YouTube Music
 * (app-id: cinhimbnkkaeohfgghhklpknlkffjgod) no Linux Mint Cinnamon:
 *  - Detecta janelas abertas do PWA pelo WM_CLASS (crx_cinhimbnkkaeohfgghhklpknlkffjgod)
 *    ou abre diretamente o PWA do YouTube Music no perfil ativo do Chrome.
 *  - Quando o Chrome reporta Status=Stopped (nenhuma música iniciada na sessão),
 *    clicar no ícone ou em Play abre/foca a janela do PWA e guia para o primeiro Play;
 *    assim que a sessão MediaSession do Chrome inicia, os botões ⏮ ⏯ ⏭ controlam
 *    tudo via MPRIS2 D-Bus (`org.mpris.MediaPlayer2.chromium.instance*`).
 *  - Auto-Collapse inteligente: fica minimizado só com o ícone do YouTube Music
 *    quando nenhuma música foi iniciada (`Stopped`), e expande os botões `⏮ ⏯ ⏭`
 *    assim que uma música está ativa (`Playing` ou `Paused`).
 * ========================================================================== */

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Cinnamon = imports.gi.Cinnamon;
const Util = imports.misc.util;

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const DBUS_NAME = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const YTM_CHROME_APP_ID = "cinhimbnkkaeohfgghhklpknlkffjgod";

class YTMusicHybridApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.metadata = metadata;
        this.orientation = orientation;
        this.panelHeight = panelHeight;
        this.instanceId = instanceId;

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        // Settings
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("icon-animation", "iconAnimation", () => this._updateAnimationState());
        this.settings.bind("collapse-when-idle", "collapseWhenIdle", () => this._updateBarCollapseState());
        this.settings.bind("chrome-profile", "chromeProfile");
        this.settings.bind("player-filter", "playerFilter", () => this._discoverPlayers());
        this.settings.bind("hover-delay-ms", "hoverDelayMs");
        this.settings.bind("hover-close-grace-ms", "hoverCloseGraceMs");
        this.settings.bind("ytmusic-launch-url", "ytmusicLaunchUrl");

        // Runtime State
        this._activeBusName = null;
        this._propsProxy = null;
        this._propsSignalId = 0;
        this._dbusSignalId = 0;

        this._playbackStatus = "Stopped";
        this._isPlaying = false;
        this._hasActiveTrack = false;
        this._trackId = "/org/mpris/MediaPlayer2/TrackList/NoTrack";
        this._title = "YouTube Music";
        this._artist = "Clique para abrir o YouTube Music";
        this._album = "Inicie uma música para ativar o vinil";
        this._artUrl = "";
        this._cachedArtPath = null;
        this._durationUs = 0;
        this._positionUs = 0;
        this._volume = 1.0;

        this._spinAngle = 0;
        this._spinTimerId = 0;
        this._posTimerId = 0;
        this._pollWatchdogId = 0;
        this._hoverOpenTimerId = 0;
        this._hoverCloseTimerId = 0;
        this._pointerInPanel = false;
        this._pointerInPopup = false;

        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), "ytmusic-mint-player"]);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);

        this._buildPanelUI();
        this._buildHoverPopupUI();
        this._initDBus();
        this._updateBarCollapseState();
    }

    /* ======================================================================
     * 1. BARRA DE TAREFAS (AUTO-COLLAPSE: SÓ ÍCONE QUANDO PARADO, +3 BOTÕES ATIVO)
     * ====================================================================== */
    _buildPanelUI() {
        this.actor.set_style_class_name("applet-box");
        this.actor.reactive = true;
        this.actor.track_hover = true;

        this._panelCard = new St.BoxLayout({
            style_class: "ytm-panel-container-compact",
            reactive: true,
            track_hover: true,
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        const iconPath = GLib.build_filenamev([this.metadata.path, "icons", "ytmusic-vinyl.svg"]);
        const gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(iconPath) });

        this._ytmIcon = new St.Icon({
            gicon: gicon,
            icon_size: 22,
            icon_type: St.IconType.FULLCOLOR,
            reactive: false
        });
        this._ytmIcon.set_pivot_point(0.5, 0.5);

        this._ytmIconBtn = new St.Button({
            style_class: "ytm-panel-icon-btn",
            reactive: true,
            can_focus: true,
            child: this._ytmIcon
        });
        this._ytmIconBtn.connect("clicked", () => this._raiseOrLaunchYTMusic());

        this._controlsBox = new St.BoxLayout({
            style_class: "ytm-panel-controls-box",
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._divider = new St.Widget({
            style_class: "ytm-panel-divider",
            y_align: Clutter.ActorAlign.CENTER
        });

        this._panelPrevBtn = new St.Button({
            style_class: "ytm-panel-btn",
            reactive: true,
            child: new St.Icon({
                icon_name: "media-skip-backward-symbolic",
                icon_size: 13,
                icon_type: St.IconType.SYMBOLIC
            })
        });
        this._panelPrevBtn.connect("clicked", () => this._sendMprisCommand("Previous"));

        this._panelPlayIcon = new St.Icon({
            icon_name: "media-playback-start-symbolic",
            icon_size: 13,
            icon_type: St.IconType.SYMBOLIC
        });
        this._panelPlayBtn = new St.Button({
            style_class: "ytm-panel-btn-play",
            reactive: true,
            child: this._panelPlayIcon
        });
        this._panelPlayBtn.connect("clicked", () => this._sendMprisCommand("PlayPause"));

        this._panelNextBtn = new St.Button({
            style_class: "ytm-panel-btn",
            reactive: true,
            child: new St.Icon({
                icon_name: "media-skip-forward-symbolic",
                icon_size: 13,
                icon_type: St.IconType.SYMBOLIC
            })
        });
        this._panelNextBtn.connect("clicked", () => this._sendMprisCommand("Next"));

        this._controlsBox.add_actor(this._divider);
        this._controlsBox.add_actor(this._panelPrevBtn);
        this._controlsBox.add_actor(this._panelPlayBtn);
        this._controlsBox.add_actor(this._panelNextBtn);

        this._panelCard.add_actor(this._ytmIconBtn);
        this._panelCard.add_actor(this._controlsBox);

        this.actor.add_actor(this._panelCard);

        this.actor.connect("enter-event", () => {
            this._pointerInPanel = true;
            this._scheduleHoverOpen();
        });
        this.actor.connect("leave-event", () => {
            this._pointerInPanel = false;
            this._scheduleHoverClose();
        });
        this.actor.connect("scroll-event", (actor, event) => {
            this._onScrollVolume(event);
            return Clutter.EVENT_STOP;
        });
    }

    _updateBarCollapseState() {
        const mode = this.collapseWhenIdle || "when-no-track";
        let showControls = true;

        if (mode === "when-not-playing") {
            // Só mostra os botões quando estiver efetivamente Playing
            showControls = this._isPlaying;
        } else if (mode === "when-no-track" || mode === "when-closed") {
            // Minimiza (fica só o ícone do YouTube Music) quando não há música ativa (Stopped)
            // e mantém os botões [⏮ ⏯ ⏭] visíveis quando está Playing ou Paused para você poder dar Play de novo!
            showControls = (this._isPlaying || (this._playbackStatus === "Paused" && this._hasActiveTrack));
        } else {
            showControls = true;
        }

        if (showControls) {
            this._controlsBox.show();
            this._panelCard.set_style_class_name("ytm-panel-container");
        } else {
            this._controlsBox.hide();
            this._panelCard.set_style_class_name("ytm-panel-container-compact");
        }
    }

    /* ======================================================================
     * 2. JANELINHA HOVER (ESTILO 2: DYNAMIC ISLAND + VINIL + GLOW + SEEK)
     * ====================================================================== */
    _buildHoverPopupUI() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        this.menu.actor.reactive = true;
        this.menu.actor.track_hover = true;
        this.menu.actor.connect("enter-event", () => {
            this._pointerInPopup = true;
            this._cancelHoverClose();
        });
        this.menu.actor.connect("leave-event", () => {
            this._pointerInPopup = false;
            this._scheduleHoverClose();
        });

        this._popupCard = new St.BoxLayout({
            style_class: "ytm-popup-card",
            vertical: true,
            reactive: true
        });

        const headerRow = new St.BoxLayout({
            style_class: "ytm-popup-header-row",
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._vinylWrapper = new St.Widget({
            style_class: "ytm-vinyl-wrapper",
            layout_manager: new Clutter.BinLayout(),
            width: 72,
            height: 72
        });
        this._vinylWrapper.set_pivot_point(0.5, 0.5);

        const defaultIconPath = GLib.build_filenamev([this.metadata.path, "icons", "ytmusic-vinyl.svg"]);
        this._vinylArtBin = new St.Bin({
            width: 68,
            height: 68,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `border-radius: 999px; background-image: url("file://${defaultIconPath}"); background-size: cover;`
        });

        this._vinylHole = new St.Widget({
            style_class: "ytm-vinyl-hole",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._vinylWrapper.add_actor(this._vinylArtBin);
        this._vinylWrapper.add_actor(this._vinylHole);

        const metaCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });

        const badgeRow = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._badgePill = new St.BoxLayout({
            style_class: "ytm-badge-pill",
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._badgeDot = new St.Widget({
            style_class: "ytm-badge-dot",
            y_align: Clutter.ActorAlign.CENTER
        });
        this._badgeLabel = new St.Label({
            style_class: "ytm-badge-text",
            text: "YOUTUBE MUSIC"
        });
        this._badgePill.add_actor(this._badgeDot);
        this._badgePill.add_actor(this._badgeLabel);
        badgeRow.add_actor(this._badgePill);

        this._titleLabel = new St.Label({
            style_class: "ytm-track-title",
            text: this._title
        });
        this._titleLabel.clutter_text.set_ellipsize(3);

        this._artistLabel = new St.Label({
            style_class: "ytm-track-artist",
            text: this._artist
        });
        this._artistLabel.clutter_text.set_ellipsize(3);

        this._albumLabel = new St.Label({
            style_class: "ytm-track-album",
            text: this._album
        });
        this._albumLabel.clutter_text.set_ellipsize(3);

        metaCol.add_actor(badgeRow);
        metaCol.add_actor(this._titleLabel);
        metaCol.add_actor(this._artistLabel);
        metaCol.add_actor(this._albumLabel);

        headerRow.add_actor(this._vinylWrapper);
        headerRow.add_actor(metaCol);

        const progressRow = new St.BoxLayout({
            style_class: "ytm-progress-row",
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._currentTimeLabel = new St.Label({
            style_class: "ytm-time-label",
            text: "0:00"
        });

        this._progressTrack = new St.Button({
            style_class: "ytm-progress-track",
            x_expand: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._progressFill = new St.Widget({
            style_class: "ytm-progress-fill",
            width: 0,
            height: 6
        });
        this._progressTrack.set_child(this._progressFill);
        this._progressTrack.connect("button-press-event", (actor, event) => {
            this._onSeekClick(actor, event);
            return Clutter.EVENT_STOP;
        });

        this._totalTimeLabel = new St.Label({
            style_class: "ytm-time-label",
            text: "0:00"
        });

        progressRow.add_actor(this._currentTimeLabel);
        progressRow.add_actor(this._progressTrack);
        progressRow.add_actor(this._totalTimeLabel);

        const footerRow = new St.BoxLayout({
            style_class: "ytm-popup-footer",
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._openAppBtn = new St.Button({
            style_class: "ytm-open-app-btn",
            reactive: true,
            label: "↗ Abrir YT Music"
        });
        this._openAppBtn.connect("clicked", () => {
            this.menu.close();
            this._raiseOrLaunchYTMusic();
        });

        const ctrlsBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: "spacing: 10px;"
        });

        this._popupPrevBtn = new St.Button({
            style_class: "ytm-popup-ctrl-btn",
            reactive: true,
            child: new St.Icon({
                icon_name: "media-skip-backward-symbolic",
                icon_size: 14,
                icon_type: St.IconType.SYMBOLIC
            })
        });
        this._popupPrevBtn.connect("clicked", () => this._sendMprisCommand("Previous"));

        this._popupPlayIcon = new St.Icon({
            icon_name: "media-playback-start-symbolic",
            icon_size: 17,
            icon_type: St.IconType.SYMBOLIC
        });
        this._popupPlayBtn = new St.Button({
            style_class: "ytm-popup-play-btn",
            reactive: true,
            child: this._popupPlayIcon
        });
        this._popupPlayBtn.connect("clicked", () => this._sendMprisCommand("PlayPause"));

        this._popupNextBtn = new St.Button({
            style_class: "ytm-popup-ctrl-btn",
            reactive: true,
            child: new St.Icon({
                icon_name: "media-skip-forward-symbolic",
                icon_size: 14,
                icon_type: St.IconType.SYMBOLIC
            })
        });
        this._popupNextBtn.connect("clicked", () => this._sendMprisCommand("Next"));

        ctrlsBox.add_actor(this._popupPrevBtn);
        ctrlsBox.add_actor(this._popupPlayBtn);
        ctrlsBox.add_actor(this._popupNextBtn);

        this._volumeLabel = new St.Label({
            style_class: "ytm-volume-chip",
            text: "🔊 100%"
        });

        footerRow.add_actor(this._openAppBtn);
        footerRow.add_actor(ctrlsBox);
        footerRow.add_actor(this._volumeLabel);

        this._popupCard.add_actor(headerRow);
        this._popupCard.add_actor(progressRow);
        this._popupCard.add_actor(footerRow);

        const customSection = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
            style_class: "ytm-popup-menuitem"
        });
        customSection.addActor(this._popupCard, { expand: true, span: -1 });
        this.menu.addMenuItem(customSection);
    }

    /* ======================================================================
     * 3. CONTROLE DE HOVER INTELIGENTE
     * ====================================================================== */
    _scheduleHoverOpen() {
        this._cancelHoverClose();
        if (this.menu.isOpen) return;
        if (this._hoverOpenTimerId) {
            Mainloop.source_remove(this._hoverOpenTimerId);
            this._hoverOpenTimerId = 0;
        }
        const delay = Math.max(0, this.hoverDelayMs || 80);
        this._hoverOpenTimerId = Mainloop.timeout_add(delay, () => {
            this._hoverOpenTimerId = 0;
            if (this._pointerInPanel && !this.menu.isOpen) {
                this._discoverPlayers();
                this._syncPositionNow();
                this.menu.open(true);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleHoverClose() {
        if (this._hoverOpenTimerId) {
            Mainloop.source_remove(this._hoverOpenTimerId);
            this._hoverOpenTimerId = 0;
        }
        this._cancelHoverClose();
        const grace = Math.max(120, this.hoverCloseGraceMs || 280);
        this._hoverCloseTimerId = Mainloop.timeout_add(grace, () => {
            this._hoverCloseTimerId = 0;
            if (!this._pointerInPanel && !this._pointerInPopup && this.menu.isOpen) {
                this.menu.close(true);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHoverClose() {
        if (this._hoverCloseTimerId) {
            Mainloop.source_remove(this._hoverCloseTimerId);
            this._hoverCloseTimerId = 0;
        }
    }

    /* ======================================================================
     * 4. ANIMAÇÃO DE ROTAÇÃO DO VINIL
     * ====================================================================== */
    _updateAnimationState() {
        if (this._isPlaying) {
            if (this.iconAnimation === "pulse") {
                this._ytmIconBtn.add_style_class_name("ytm-panel-icon-pulse");
            } else {
                this._ytmIconBtn.remove_style_class_name("ytm-panel-icon-pulse");
            }

            if (!this._spinTimerId) {
                this._spinTimerId = Mainloop.timeout_add(33, () => {
                    this._spinAngle = (this._spinAngle + 1.6) % 360;
                    if (this.iconAnimation === "spin" || !this.iconAnimation) {
                        this._ytmIcon.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, this._spinAngle);
                    } else {
                        this._ytmIcon.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, 0);
                    }
                    if (this.menu && this.menu.isOpen) {
                        this._vinylWrapper.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, this._spinAngle);
                    }
                    return GLib.SOURCE_CONTINUE;
                });
            }

            if (!this._posTimerId) {
                this._posTimerId = Mainloop.timeout_add(1000, () => {
                    if (this._isPlaying && this._durationUs > 0) {
                        this._positionUs = Math.min(this._durationUs, this._positionUs + 1000000);
                        this._updateProgressUI();
                    }
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else {
            this._ytmIconBtn.remove_style_class_name("ytm-panel-icon-pulse");
            if (this._spinTimerId) {
                Mainloop.source_remove(this._spinTimerId);
                this._spinTimerId = 0;
            }
            if (this._posTimerId) {
                Mainloop.source_remove(this._posTimerId);
                this._posTimerId = 0;
            }
        }
    }

    /* ======================================================================
     * 5. INTEGRAÇÃO D-BUS MPRIS2 (CHROME PWA & APPS NATIVOS)
     * ====================================================================== */
    _initDBus() {
        try {
            this._dbusSignalId = Gio.DBus.session.signal_subscribe(
                DBUS_NAME,
                DBUS_NAME,
                "NameOwnerChanged",
                DBUS_PATH,
                null,
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => {
                    const [name] = params.deep_unpack();
                    if (name && name.startsWith(MPRIS_PREFIX)) {
                        this._discoverPlayers();
                    }
                }
            );
            this._discoverPlayers();

            this._pollWatchdogId = Mainloop.timeout_add(2000, () => {
                this._discoverPlayers();
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) {
            global.logError(`[ytmusic-player] Falha _initDBus: ${e}`);
        }
    }

    _discoverPlayers() {
        try {
            Gio.DBus.session.call(
                DBUS_NAME,
                DBUS_PATH,
                DBUS_NAME,
                "ListNames",
                null,
                new GLib.VariantType("(as)"),
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                (conn, res) => {
                    try {
                        const reply = conn.call_finish(res);
                        const [names] = reply.deep_unpack();
                        const mprisNames = (names || []).filter(n => n.startsWith(MPRIS_PREFIX));
                        if (mprisNames.length === 0) {
                            this._bindToPlayer(null);
                            return;
                        }
                        this._selectBestPlayer(mprisNames);
                    } catch (_) {}
                }
            );
        } catch (_) {}
    }

    _selectBestPlayer(mprisNames) {
        let bestBus = mprisNames[0];
        let bestScore = -1;

        for (let i = 0; i < mprisNames.length; i++) {
            const busName = mprisNames[i];
            const lower = busName.toLowerCase();
            let score = 10;

            if (lower.includes("youtube-music") || lower.includes("ytmusic") || lower.includes("pear")) {
                score += 100;
            } else if (lower.includes("chromium") || lower.includes("chrome") || lower.includes("brave") || lower.includes("firefox")) {
                score += 80;
            }

            try {
                const p = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PATH,
                    "org.mpris.MediaPlayer2.Player",
                    null
                );
                const stVar = p.get_cached_property("PlaybackStatus");
                const st = stVar ? stVar.deep_unpack() : "Stopped";
                if (st === "Playing") {
                    score += 150;
                } else if (st === "Paused") {
                    score += 60;
                }
            } catch (_) {}

            if (score > bestScore) {
                bestScore = score;
                bestBus = busName;
            }
        }

        this._bindToPlayer(bestBus);
    }

    _bindToPlayer(busName) {
        if (this._activeBusName === busName) {
            if (this._propsProxy) {
                this._readPlayerProperties();
            }
            return;
        }

        if (this._propsProxy && this._propsSignalId) {
            this._propsProxy.disconnect(this._propsSignalId);
            this._propsSignalId = 0;
        }

        this._activeBusName = busName;
        this._propsProxy = null;

        if (!busName) {
            this._playbackStatus = "Stopped";
            this._isPlaying = false;
            this._hasActiveTrack = false;
            this._title = "YouTube Music";
            this._artist = "Clique para abrir o YouTube Music";
            this._album = "Inicie uma música para ativar o vinil";
            this._durationUs = 0;
            this._positionUs = 0;
            this._refreshAllUI();
            return;
        }

        try {
            this._propsProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                busName,
                MPRIS_PATH,
                "org.mpris.MediaPlayer2.Player",
                null
            );

            this._propsSignalId = this._propsProxy.connect("g-properties-changed", () => {
                this._readPlayerProperties();
            });

            this._readPlayerProperties();
        } catch (e) {
            global.logError(`[ytmusic-player] Erro ao conectar player ${busName}: ${e}`);
        }
    }

    _readPlayerProperties() {
        if (!this._propsProxy) return;

        const statusVar = this._propsProxy.get_cached_property("PlaybackStatus");
        if (statusVar) {
            this._playbackStatus = statusVar.deep_unpack();
            this._isPlaying = (this._playbackStatus === "Playing");
        }

        const volVar = this._propsProxy.get_cached_property("Volume");
        if (volVar) {
            this._volume = volVar.deep_unpack();
        }

        const posVar = this._propsProxy.get_cached_property("Position");
        if (posVar) {
            this._positionUs = Number(posVar.deep_unpack());
        }

        let gotTitle = "";
        const metaVar = this._propsProxy.get_cached_property("Metadata");
        if (metaVar) {
            const meta = metaVar.deep_unpack();

            if (meta["mpris:trackid"]) {
                this._trackId = String(meta["mpris:trackid"].deep_unpack());
            }
            if (meta["xesam:title"]) {
                gotTitle = String(meta["xesam:title"].deep_unpack() || "").trim();
            }
            if (gotTitle.length > 0) {
                this._title = gotTitle;
                this._hasActiveTrack = true;
            }
            if (meta["xesam:artist"]) {
                const artists = meta["xesam:artist"].deep_unpack();
                const joined = Array.isArray(artists) ? artists.join(", ") : String(artists);
                if (joined.trim().length > 0) {
                    this._artist = joined;
                }
            }
            if (meta["xesam:album"]) {
                const alb = String(meta["xesam:album"].deep_unpack() || "").trim();
                if (alb.length > 0) {
                    this._album = alb;
                } else if (this._hasActiveTrack) {
                    this._album = "YouTube Music";
                }
            }
            if (meta["mpris:length"]) {
                this._durationUs = Number(meta["mpris:length"].deep_unpack());
            } else {
                this._durationUs = 0;
            }

            let newArtUrl = "";
            if (meta["mpris:artUrl"]) {
                newArtUrl = String(meta["mpris:artUrl"].deep_unpack());
            }
            if (newArtUrl && newArtUrl !== this._artUrl) {
                this._artUrl = newArtUrl;
                this._updateCoverArt(newArtUrl);
            }
        }

        if (this._playbackStatus === "Stopped" && !gotTitle) {
            this._hasActiveTrack = false;
            this._title = "YouTube Music";
            this._artist = "Clique para abrir o YouTube Music";
            this._album = "Dê Play em uma música para vincular";
        }

        this._refreshAllUI();
    }

    _syncPositionNow() {
        if (!this._activeBusName) return;
        try {
            Gio.DBus.session.call(
                this._activeBusName,
                MPRIS_PATH,
                "org.freedesktop.DBus.Properties",
                "Get",
                new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", "Position"]),
                null,
                Gio.DBusCallFlags.NONE,
                500,
                null,
                (conn, res) => {
                    try {
                        const reply = conn.call_finish(res);
                        const inner = reply.deep_unpack()[0];
                        this._positionUs = Number(inner.deep_unpack());
                        this._updateProgressUI();
                    } catch (_) {}
                }
            );
        } catch (_) {}
    }

    /* ======================================================================
     * 6. CAPA DO ÁLBUM NO VINIL & EXTRAÇÃO DE GLOW RADIAL DINÂMICO
     * ====================================================================== */
    _updateCoverArt(artUrl) {
        if (artUrl.startsWith("file://")) {
            const localPath = GLib.filename_from_uri(artUrl)[0];
            this._applyLocalCoverFile(localPath);
            return;
        }

        if (artUrl.startsWith("http://") || artUrl.startsWith("https://")) {
            const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, artUrl, -1);
            const targetPath = GLib.build_filenamev([this._cacheDir, `cover_${hash}.jpg`]);

            if (GLib.file_test(targetPath, GLib.FileTest.EXISTS)) {
                this._applyLocalCoverFile(targetPath);
                return;
            }

            Util.spawn_async(["curl", "-sL", "--max-time", "8", "-o", targetPath, artUrl], () => {
                if (GLib.file_test(targetPath, GLib.FileTest.EXISTS)) {
                    this._applyLocalCoverFile(targetPath);
                }
            });
        }
    }

    _applyLocalCoverFile(filePath) {
        this._cachedArtPath = filePath;
        this._vinylArtBin.set_style(
            `border-radius: 999px; background-image: url("file://${filePath}"); background-size: cover;`
        );

        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(filePath, 16, 16, false);
            const pixels = pixbuf.get_pixels();
            const nChannels = pixbuf.get_n_channels();
            let rSum = 0, gSum = 0, bSum = 0, count = 0;

            for (let i = 0; i < pixels.length; i += nChannels) {
                const r = pixels[i];
                const g = pixels[i + 1];
                const b = pixels[i + 2];
                const brightness = (r + g + b) / 3;
                if (brightness > 32 && brightness < 235) {
                    rSum += r;
                    gSum += g;
                    bSum += b;
                    count++;
                }
            }

            if (count > 0) {
                const r = Math.min(255, Math.round((rSum / count) * 1.15));
                const g = Math.min(255, Math.round((gSum / count) * 1.15));
                const b = Math.min(255, Math.round((bSum / count) * 1.15));
                this._applyDynamicGlow(r, g, b);
            }
        } catch (_) {}
    }

    _applyDynamicGlow(r, g, b) {
        const darkR = Math.round(r * 0.22);
        const darkG = Math.round(g * 0.22);
        const darkB = Math.round(b * 0.22);

        this._popupCard.set_style(`
            background-gradient-direction: vertical;
            background-gradient-start: rgba(${darkR}, ${darkG}, ${darkB}, 0.96);
            background-gradient-end: rgba(10, 10, 14, 0.99);
            border: 1px solid rgba(${r}, ${g}, ${b}, 0.42);
            box-shadow: 0 14px 36px rgba(0, 0, 0, 0.78);
        `);
        this._progressFill.set_style(`background-color: rgb(${r}, ${g}, ${b}); border-radius: 999px;`);
        this._popupPlayBtn.set_style(`
            background-color: rgb(${r}, ${g}, ${b});
            color: #09090b;
            box-shadow: 0 4px 14px rgba(${r}, ${g}, ${b}, 0.55);
        `);
        this._badgePill.set_style(`
            background-color: rgba(${r}, ${g}, ${b}, 0.24);
            border: 1px solid rgba(${r}, ${g}, ${b}, 0.48);
        `);
    }

    /* ======================================================================
     * 7. ABRIR / FOCAR O APP CHROME PWA DO YOUTUBE MUSIC NO LINUX MINT
     * ====================================================================== */
    _raiseOrLaunchYTMusic() {
        // 1. Verifica todas as janelas abertas no Cinnamon (inclui WM_CLASS crx_cinhimbnkkaeohfgghhklpknlkffjgod)
        try {
            const windows = global.get_window_actors();
            for (let i = 0; i < windows.length; i++) {
                const metaWin = windows[i].get_meta_window();
                if (!metaWin) continue;
                const title = (metaWin.get_title() || "").toLowerCase();
                const wmClass = (metaWin.get_wm_class() || "").toLowerCase();
                const wmInst = (metaWin.get_wm_class_instance ? (metaWin.get_wm_class_instance() || "") : "").toLowerCase();
                if (
                    title.includes("youtube music") ||
                    wmClass.includes(YTM_CHROME_APP_ID) ||
                    wmInst.includes(YTM_CHROME_APP_ID) ||
                    wmClass.includes("youtube-music") ||
                    wmClass.includes("ytmusic") ||
                    wmClass.includes("pear-desktop")
                ) {
                    metaWin.activate(global.get_current_time());
                    this._discoverPlayers();
                    return;
                }
            }
        } catch (_) {}

        // 2. Se houver comando customizado configurado manualmente
        const custom = (this.ytmusicLaunchUrl || "auto").trim();
        if (custom !== "auto" && custom !== "") {
            if (custom.startsWith("http://") || custom.startsWith("https://")) {
                Util.spawnCommandLine(`xdg-open "${custom}"`);
            } else {
                Util.spawnCommandLine(custom);
            }
            this._schedulePostLaunchDiscovery();
            return;
        }

        // 3. Procura o .desktop do YouTube Music instalado no Mint (priorizando o perfil escolhido)
        try {
            const apps = Gio.AppInfo.get_all();
            const prefProfile = this.chromeProfile || "auto";
            let candidates = [];

            for (let i = 0; i < apps.length; i++) {
                const app = apps[i];
                const name = (app.get_name() || "").toLowerCase();
                const disp = (app.get_display_name() || "").toLowerCase();
                const id = (app.get_id() || "").toLowerCase();
                const cmd = (app.get_commandline() || "");

                if (
                    name.includes("youtube music") ||
                    disp.includes("youtube music") ||
                    id.includes(YTM_CHROME_APP_ID) ||
                    id.includes("youtube-music") ||
                    id.includes("ytmusic") ||
                    cmd.toLowerCase().includes(YTM_CHROME_APP_ID)
                ) {
                    let priority = 10;
                    if (prefProfile !== "auto" && cmd.includes(prefProfile)) {
                        priority = 100;
                    } else if (cmd.includes("Profile 3")) {
                        priority = 50;
                    } else if (cmd.includes("Default")) {
                        priority = 45;
                    }
                    candidates.push({ app, priority });
                }
            }

            if (candidates.length > 0) {
                candidates.sort((a, b) => b.priority - a.priority);
                candidates[0].app.launch([], null);
                this._schedulePostLaunchDiscovery();
                return;
            }
        } catch (e) {
            global.logError(`[ytmusic-player] Erro ao buscar Gio.AppInfo: ${e}`);
        }

        // 4. Fallback direto para o Google Chrome PWA do YouTube Music se o binário existir
        if (GLib.file_test("/opt/google/chrome/google-chrome", GLib.FileTest.EXISTS)) {
            const prof = (this.chromeProfile && this.chromeProfile !== "auto") ? this.chromeProfile : "Default";
            Util.spawnCommandLine(`/opt/google/chrome/google-chrome "--profile-directory=${prof}" --app-id=${YTM_CHROME_APP_ID}`);
            this._schedulePostLaunchDiscovery();
            return;
        }

        Util.spawnCommandLine(`xdg-open "https://music.youtube.com"`);
        this._schedulePostLaunchDiscovery();
    }

    _schedulePostLaunchDiscovery() {
        [600, 1500, 2800, 4500].forEach(delay => {
            Mainloop.timeout_add(delay, () => {
                this._discoverPlayers();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /* ======================================================================
     * 8. COMANDOS DE MÍDIA (PLAY, PAUSE, NEXT, PREV, SEEK, VOLUME)
     * ====================================================================== */
    _sendMprisCommand(methodName) {
        this._discoverPlayers();
        // Se nenhum player estiver aberto, ou se o Chrome estiver Stopped (sem aba do YT Music tocando),
        // abre/foca a janela do YouTube Music imediatamente!
        if (!this._activeBusName || (this._playbackStatus === "Stopped" && !this._hasActiveTrack)) {
            this._raiseOrLaunchYTMusic();
            return;
        }
        try {
            Gio.DBus.session.call(
                this._activeBusName,
                MPRIS_PATH,
                "org.mpris.MediaPlayer2.Player",
                methodName,
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                () => {
                    Mainloop.timeout_add(150, () => {
                        this._readPlayerProperties();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            );
        } catch (e) {
            global.logError(`[ytmusic-player] Erro ao enviar ${methodName}: ${e}`);
        }
    }

    _onSeekClick(actor, event) {
        if (!this._activeBusName || this._durationUs <= 0) return;
        const [stageX] = event.get_coords();
        const [actorX] = actor.get_transformed_position();
        const width = actor.get_width();
        if (width <= 0) return;

        const ratio = Math.max(0, Math.min(1, (stageX - actorX) / width));
        const targetUs = Math.floor(ratio * this._durationUs);
        this._positionUs = targetUs;
        this._updateProgressUI();

        try {
            Gio.DBus.session.call(
                this._activeBusName,
                MPRIS_PATH,
                "org.mpris.MediaPlayer2.Player",
                "SetPosition",
                new GLib.Variant("(ox)", [this._trackId || "/org/mpris/MediaPlayer2/TrackList/NoTrack", targetUs]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
            );
        } catch (_) {}
    }

    _onScrollVolume(event) {
        if (!this._activeBusName) return;
        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP) delta = 0.05;
        else if (dir === Clutter.ScrollDirection.DOWN) delta = -0.05;
        else return;

        this._volume = Math.max(0, Math.min(1, this._volume + delta));
        this._volumeLabel.set_text(`🔊 ${Math.round(this._volume * 100)}%`);

        try {
            Gio.DBus.session.call(
                this._activeBusName,
                MPRIS_PATH,
                "org.freedesktop.DBus.Properties",
                "Set",
                new GLib.Variant("(ssv)", [
                    "org.mpris.MediaPlayer2.Player",
                    "Volume",
                    new GLib.Variant("d", this._volume)
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
            );
        } catch (_) {}
    }

    _formatTime(microSeconds) {
        const totalSec = Math.max(0, Math.floor(microSeconds / 1000000));
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${m}:${s < 10 ? "0" : ""}${s}`;
    }

    _updateProgressUI() {
        this._currentTimeLabel.set_text(this._formatTime(this._positionUs));
        this._totalTimeLabel.set_text(this._formatTime(this._durationUs));

        const trackWidth = this._progressTrack.get_width() || 220;
        const ratio = this._durationUs > 0 ? Math.max(0, Math.min(1, this._positionUs / this._durationUs)) : 0;
        this._progressFill.set_width(Math.round(trackWidth * ratio));
    }

    _refreshAllUI() {
        const iconName = this._isPlaying ? "media-playback-pause-symbolic" : "media-playback-start-symbolic";
        this._panelPlayIcon.set_icon_name(iconName);
        this._popupPlayIcon.set_icon_name(iconName);

        this._titleLabel.set_text(this._title);
        this._artistLabel.set_text(this._artist);
        this._albumLabel.set_text(this._album);
        this._volumeLabel.set_text(`🔊 ${Math.round((this._volume || 1) * 100)}%`);

        this._updateBarCollapseState();
        this._updateProgressUI();
        this._updateAnimationState();
    }

    on_applet_removed_from_panel() {
        if (this._spinTimerId) Mainloop.source_remove(this._spinTimerId);
        if (this._posTimerId) Mainloop.source_remove(this._posTimerId);
        if (this._pollWatchdogId) Mainloop.source_remove(this._pollWatchdogId);
        if (this._hoverOpenTimerId) Mainloop.source_remove(this._hoverOpenTimerId);
        if (this._hoverCloseTimerId) Mainloop.source_remove(this._hoverCloseTimerId);
        if (this._dbusSignalId) Gio.DBus.session.signal_unsubscribe(this._dbusSignalId);
        if (this._propsProxy && this._propsSignalId) {
            this._propsProxy.disconnect(this._propsSignalId);
        }
        this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new YTMusicHybridApplet(metadata, orientation, panelHeight, instanceId);
}
