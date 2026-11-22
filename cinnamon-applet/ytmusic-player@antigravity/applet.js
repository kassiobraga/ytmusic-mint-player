/* ==========================================================================
 * YouTube Music Taskbar Player (Hybrid Vinyl) - Cinnamon Applet
 * UUID: ytmusic-player@antigravity
 *
 * Design Híbrido:
 *  - Barra de Tarefas (Esquerda): Estilo 1 Limpo (Apenas ícone oficial do
 *    YouTube Music girando suavemente como vinil + Voltar, Play/Pause, Avançar).
 *  - Janelinha Hover (PopupMenu): Estilo 2 Dynamic Island (Capa do álbum em
 *    formato de disco de vinil girando, glow radial dinâmico, título da música,
 *    cantor/álbum, barra de progresso clicável e controles completos).
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
const Cogl = imports.gi.Cogl;
const Util = imports.misc.util;

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const DBUS_NAME = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";

const DBusIfaceXml = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out" name="names"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s" name="name"/>
      <arg type="s" name="old_owner"/>
      <arg type="s" name="new_owner"/>
    </signal>
  </interface>
</node>`;

const MprisPlayerIfaceXml = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
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
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
  </interface>
</node>`;

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIfaceXml);

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
        this.settings.bind("player-filter", "playerFilter", () => this._discoverPlayers());
        this.settings.bind("hover-delay-ms", "hoverDelayMs");
        this.settings.bind("hover-close-grace-ms", "hoverCloseGraceMs");
        this.settings.bind("ytmusic-launch-url", "ytmusicLaunchUrl");

        // Runtime State
        this._activeBusName = null;
        this._playerProxy = null;
        this._propsProxy = null;
        this._propsSignalId = 0;

        this._isPlaying = false;
        this._trackId = "/org/mpris/MediaPlayer2/TrackList/NoTrack";
        this._title = "YouTube Music";
        this._artist = "Pronto para tocar";
        this._album = "Passe o mouse ou dê Play";
        this._artUrl = "";
        this._cachedArtPath = null;
        this._durationUs = 0;
        this._positionUs = 0;
        this._volume = 1.0;
        this._accentHex = "#e11d48";
        this._accentRgba = "rgba(225, 29, 72, 0.25)";

        this._spinAngle = 0;
        this._spinTimerId = 0;
        this._posTimerId = 0;
        this._hoverOpenTimerId = 0;
        this._hoverCloseTimerId = 0;
        this._pointerInPanel = false;
        this._pointerInPopup = false;

        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), "ytmusic-mint-player"]);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);

        this._buildPanelUI();
        this._buildHoverPopupUI();
        this._initDBus();
    }

    /* ======================================================================
     * 1. BARRA DE TAREFAS (ESTILO 1 LIMPO: ÍCONE YT MUSIC GIRANDO + 3 BOTÕES)
     * ====================================================================== */
    _buildPanelUI() {
        this.actor.set_style_class_name("applet-box");
        this.actor.reactive = true;
        this.actor.track_hover = true;

        this._panelCard = new St.BoxLayout({
            style_class: "ytm-panel-container",
            reactive: true,
            track_hover: true,
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        // Ícone oficial do YouTube Music (SVG com sulcos de vinil)
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

        // Divisor sutil
        this._divider = new St.Widget({
            style_class: "ytm-panel-divider",
            y_align: Clutter.ActorAlign.CENTER
        });

        // Botão Voltar (⏮)
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

        // Botão Play / Pause (⏯)
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

        // Botão Avançar (⏭)
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

        this._panelCard.add_child(this._ytmIconBtn);
        this._panelCard.add_child(this._divider);
        this._panelCard.add_child(this._panelPrevBtn);
        this._panelCard.add_child(this._panelPlayBtn);
        this._panelCard.add_child(this._panelNextBtn);

        this.actor.add_child(this._panelCard);

        // Eventos de Hover na Barra e Scroll de Volume
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

    /* ======================================================================
     * 2. JANELINHA HOVER (ESTILO 2: DYNAMIC ISLAND + VINIL + GLOW + SEEK)
     * ====================================================================== */
    _buildHoverPopupUI() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        // Rastrear mouse dentro da janelinha para mantê-la aberta durante o hover
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

        // --- Linha Superior: Disco de Vinil Girando + Metadados da Música ---
        const headerRow = new St.BoxLayout({
            style_class: "ytm-popup-header-row",
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        // Container do Disco de Vinil (72x72 circular)
        this._vinylWrapper = new St.Widget({
            style_class: "ytm-vinyl-wrapper",
            layout_manager: new Clutter.BinLayout(),
            width: 72,
            height: 72
        });
        this._vinylWrapper.set_pivot_point(0.5, 0.5);

        // Imagem da capa do álbum dentro do vinil
        const defaultIconPath = GLib.build_filenamev([this.metadata.path, "icons", "ytmusic-vinyl.svg"]);
        this._vinylArtBin = new St.Bin({
            width: 68,
            height: 68,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `border-radius: 999px; background-image: url("file://${defaultIconPath}"); background-size: cover;`
        });

        // Furinho central do disco de vinil
        this._vinylHole = new St.Widget({
            style_class: "ytm-vinyl-hole",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._vinylWrapper.add_child(this._vinylArtBin);
        this._vinylWrapper.add_child(this._vinylHole);

        // Coluna de Textos (Badge YouTube Music + Música + Cantor + Álbum)
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
        this._badgePill.add_child(this._badgeDot);
        this._badgePill.add_child(this._badgeLabel);
        badgeRow.add_child(this._badgePill);

        this._titleLabel = new St.Label({
            style_class: "ytm-track-title",
            text: this._title
        });
        this._titleLabel.clutter_text.set_ellipsize(3); // PANGO_ELLIPSIZE_END

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

        metaCol.add_child(badgeRow);
        metaCol.add_child(this._titleLabel);
        metaCol.add_child(this._artistLabel);
        metaCol.add_child(this._albumLabel);

        headerRow.add_child(this._vinylWrapper);
        headerRow.add_child(metaCol);

        // --- Linha de Progresso Interativa (Tempo Atual + Barra Clicável + Duração) ---
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

        progressRow.add_child(this._currentTimeLabel);
        progressRow.add_child(this._progressTrack);
        progressRow.add_child(this._totalTimeLabel);

        // --- Rodapé da Janelinha: Abrir App + Controles ⏮ ⏯ ⏭ + Volume ---
        const footerRow = new St.BoxLayout({
            style_class: "ytm-popup-footer",
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._openAppBtn = new St.Button({
            style_class: "ytm-open-app-btn",
            reactive: true,
            label: "↗ Abrir Player"
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

        ctrlsBox.add_child(this._popupPrevBtn);
        ctrlsBox.add_child(this._popupPlayBtn);
        ctrlsBox.add_child(this._popupNextBtn);

        this._volumeLabel = new St.Label({
            style_class: "ytm-volume-chip",
            text: "🔊 100%"
        });

        footerRow.add_child(this._openAppBtn);
        footerRow.add_child(ctrlsBox);
        footerRow.add_child(this._volumeLabel);

        this._popupCard.add_child(headerRow);
        this._popupCard.add_child(progressRow);
        this._popupCard.add_child(footerRow);

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
     * 3. CONTROLE DE HOVER INTELIGENTE (ABRE AO PASSAR O MOUSE, COM GRACE)
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
     * 4. ANIMAÇÃO DE ROTAÇÃO DO VINIL (60 FPS QUANDO TOCANDO)
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
     * 5. INTEGRAÇÃO D-BUS MPRIS2 (YOUTUBE MUSIC / CHROME / BRAVE / PEAR)
     * ====================================================================== */
    _initDBus() {
        try {
            this._dbusProxy = new DBusProxy(Gio.DBus.session, DBUS_NAME, DBUS_PATH, (proxy, error) => {
                if (error) {
                    global.logError(`[ytmusic-player] Erro ao conectar ao DBus: ${error}`);
                    return;
                }
                this._dbusProxy.connectSignal("NameOwnerChanged", (proxy, sender, [name, oldOwner, newOwner]) => {
                    if (name.startsWith(MPRIS_PREFIX)) {
                        this._discoverPlayers();
                    }
                });
                this._discoverPlayers();
            });
        } catch (e) {
            global.logError(`[ytmusic-player] Falha _initDBus: ${e}`);
        }
    }

    _discoverPlayers() {
        if (!this._dbusProxy) return;
        this._dbusProxy.ListNamesRemote(([names]) => {
            if (!names) return;
            const mprisNames = names.filter(n => n.startsWith(MPRIS_PREFIX));
            if (mprisNames.length === 0) {
                this._bindToPlayer(null);
                return;
            }

            // Prioridade inteligente para YouTube Music (Pear Desktop, WebApp, Chromium/Brave/Firefox)
            const scored = mprisNames.map(busName => {
                const lower = busName.toLowerCase();
                let score = 10;
                if (lower.includes("youtube-music") || lower.includes("ytmusic") || lower.includes("pear")) {
                    score = 100;
                } else if (lower.includes("chromium") || lower.includes("chrome") || lower.includes("brave") || lower.includes("firefox") || lower.includes("plasma-browser")) {
                    score = 75;
                }
                return { busName, score };
            });

            scored.sort((a, b) => b.score - a.score);

            if (this.playerFilter === "only-ytm") {
                const ytmOnly = scored.find(s => s.score >= 75);
                this._bindToPlayer(ytmOnly ? ytmOnly.busName : null);
            } else {
                this._bindToPlayer(scored[0].busName);
            }
        });
    }

    _bindToPlayer(busName) {
        if (this._activeBusName === busName) return;

        if (this._propsProxy && this._propsSignalId) {
            this._propsProxy.disconnect(this._propsSignalId);
            this._propsSignalId = 0;
        }

        this._activeBusName = busName;
        this._playerProxy = null;
        this._propsProxy = null;

        if (!busName) {
            this._isPlaying = false;
            this._title = "YouTube Music";
            this._artist = "Nenhum player ativo";
            this._album = "Clique para abrir music.youtube.com";
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

            this._propsSignalId = this._propsProxy.connect("g-properties-changed", (proxy, changed, invalidated) => {
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
            const status = statusVar.deep_unpack();
            this._isPlaying = (status === "Playing");
        }

        const volVar = this._propsProxy.get_cached_property("Volume");
        if (volVar) {
            this._volume = volVar.deep_unpack();
        }

        const posVar = this._propsProxy.get_cached_property("Position");
        if (posVar) {
            this._positionUs = Number(posVar.deep_unpack());
        }

        const metaVar = this._propsProxy.get_cached_property("Metadata");
        if (metaVar) {
            const meta = metaVar.deep_unpack();

            if (meta["mpris:trackid"]) {
                this._trackId = meta["mpris:trackid"].deep_unpack();
            }
            if (meta["xesam:title"]) {
                this._title = meta["xesam:title"].deep_unpack() || "YouTube Music";
            }
            if (meta["xesam:artist"]) {
                const artists = meta["xesam:artist"].deep_unpack();
                this._artist = Array.isArray(artists) ? artists.join(", ") : String(artists);
            } else {
                this._artist = "YouTube Music";
            }
            if (meta["xesam:album"]) {
                this._album = meta["xesam:album"].deep_unpack() || "YouTube Music";
            } else {
                this._album = "YouTube Music Streaming";
            }
            if (meta["mpris:length"]) {
                this._durationUs = Number(meta["mpris:length"].deep_unpack());
            } else {
                this._durationUs = 0;
            }

            let newArtUrl = "";
            if (meta["mpris:artUrl"]) {
                newArtUrl = meta["mpris:artUrl"].deep_unpack();
            }
            if (newArtUrl && newArtUrl !== this._artUrl) {
                this._artUrl = newArtUrl;
                this._updateCoverArt(newArtUrl);
            }
        }

        this._syncPositionNow();
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

            // Download assíncrono via curl para compatibilidade universal (Soup2 / Soup3)
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

        // Extrai a cor vibrante dominante da capa para o Glow Estilo 2
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(filePath, 16, 16, false);
            const pixels = pixbuf.get_pixels();
            const nChannels = pixbuf.get_n_channels();
            let rSum = 0, gSum = 0, bSum = 0, count = 0;

            for (let i = 0; i < pixels.length; i += nChannels) {
                const r = pixels[i];
                const g = pixels[i + 1];
                const b = pixels[i + 2];
                // Ignora pixels muito pretos ou muito brancos para pegar a cor vibrante da capa
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
                this._accentHex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
                this._accentRgba = `rgba(${r}, ${g}, ${b}, 0.28)`;
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
     * 7. AÇÕES E ATUALIZAÇÃO DE INTERFACE
     * ====================================================================== */
    _sendMprisCommand(methodName) {
        if (!this._activeBusName) {
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
                null
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

    _raiseOrLaunchYTMusic() {
        if (this._activeBusName) {
            try {
                Gio.DBus.session.call(
                    this._activeBusName,
                    MPRIS_PATH,
                    "org.mpris.MediaPlayer2",
                    "Raise",
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    null
                );
                return;
            } catch (_) {}
        }
        const target = this.ytmusicLaunchUrl || "https://music.youtube.com";
        Util.spawnCommandLine(`xdg-open "${target}"`);
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

        this._updateProgressUI();
        this._updateAnimationState();
    }

    on_applet_removed_from_panel() {
        if (this._spinTimerId) Mainloop.source_remove(this._spinTimerId);
        if (this._posTimerId) Mainloop.source_remove(this._posTimerId);
        if (this._hoverOpenTimerId) Mainloop.source_remove(this._hoverOpenTimerId);
        if (this._hoverCloseTimerId) Mainloop.source_remove(this._hoverCloseTimerId);
        if (this._propsProxy && this._propsSignalId) {
            this._propsProxy.disconnect(this._propsSignalId);
        }
        this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new YTMusicHybridApplet(metadata, orientation, panelHeight, instanceId);
}
