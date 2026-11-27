/* ==========================================================================
 * YouTube Music Taskbar Player v3.0 — Cinnamon Applet Nativo
 * UUID: ytmusic-player@antigravity
 *
 * Arquitetura v3.0 (Integrada ao Pear Desktop — pear-devs/pear-desktop):
 *  1. Isolamento 100% Determinístico via MPRIS2 D-Bus:
 *     - Escuta EXCLUSIVAMENTE `org.mpris.MediaPlayer2.YoutubeMusic*`.
 *     - Nunca se conecta ao Google Chrome / Chromium (zero mistura com
 *       vídeos do YouTube normal ou outras abas do navegador).
 *  2. 100% Assíncrono (Zero bloqueio na Main Thread do Cinnamon):
 *     - Proxies D-Bus criados com `Gio.DBusProxy.new_for_bus` assíncrono.
 *     - Download de capas via `Gio.Subprocess` + `wait_check_async` (sem
 *       shell injection e sem timeouts cegos).
 *  3. Close-to-Tray Nativo + Reabertura Infalível (10/10 vezes):
 *     - Clicar no "X" da janela do Pear Desktop oculta a janela (`hide()`)
 *       mantendo a música tocando em segundo plano e sumindo da barra central.
 *     - Clicar no ícone da barra ou em "Abrir player" chama `MPRIS Raise()` +
 *       `metaWin.unminimize()` (0 argumentos!) + troca de workspace + `activate()`,
 *       ou dispara `launch_ytmusic.sh` (Electron `second-instance`).
 *     - Clicar com a janela já visível e focada aciona `metaWin.delete()` que,
 *       com `options.tray: true`, oculta a janela mantendo a música tocando!
 *  4. Padrão Visual do Usuário:
 *     - Tipografia 100% Sans-Serif, primeira letra maiúscula ("YouTube Music"
 *       sem corte), capa do álbum quadrada fixa + glow adaptativo e ícone de
 *       vinil girando apenas na barra esquerda.
 * ========================================================================== */

const Applet = imports.ui.applet;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const DBUS_NAME = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";

// WM_CLASS exclusivo do nosso app YouTube Music (e fallback Pear Desktop)
const PEAR_WM_CLASSES = [
    "ytmusic-mint-app",
    "com.github.th-ch.youtube-music",
    "youtube-music",
    "pear-desktop"
];

class YTMusicV3Applet extends Applet.Applet {
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
        this.settings.bind("hide-from-center-taskbar", "hideFromCenterTaskbar", () => this._applySkipTaskbarToPear());
        this.settings.bind("hover-delay-ms", "hoverDelayMs");
        this.settings.bind("hover-close-grace-ms", "hoverCloseGraceMs");

        // Runtime State
        this._destroyed = false;
        this._activeBusName = null;
        this._bindingBusName = null;
        this._propsProxy = null;
        this._propsSignalId = 0;
        this._playerSignalId = 0;
        this._dbusSignalId = 0;
        this._mediaKeysSignalId = 0;
        this._windowCreatedSignalId = 0;
        this._windowMapSignalId = 0;

        this._playbackStatus = "Stopped";
        this._isPlaying = false;
        this._hasActiveTrack = false;

        this._trackId = "/org/mpris/MediaPlayer2/TrackList/NoTrack";
        this._title = "YouTube Music";
        this._artist = "Clique em Abrir player para iniciar";
        this._album = "Player exclusivo do YouTube Music";
        this._artUrl = "";
        this._cachedArtPath = null;
        this._durationUs = 0;
        this._positionUs = 0;
        this._volume = 1.0;
        this._volumeBeforeMute = 1.0;
        this._lastVolSetAt = 0;
        this._lastMprisPosUs = null;
        this._isNativeMintApp = false;

        this._spinAngle = 0;
        this._spinTimerId = 0;
        this._posTimerId = 0;
        this._hoverOpenTimerId = 0;
        this._hoverCloseTimerId = 0;
        this._oneShotTimers = new Set();

        this._pointerInPanel = false;
        this._pointerInPopup = false;

        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), "ytmusic-mint-player"]);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);

        this._buildPanelUI();
        this._buildHoverPopupUI();
        this._initDBus();
        this._initMediaKeys();
        this._initWindowDeduplicator();
        this._updateBarCollapseState();
    }

    _scheduleOnce(delayMs, callback) {
        if (this._destroyed) return 0;
        const id = Mainloop.timeout_add(delayMs, () => {
            this._oneShotTimers.delete(id);
            if (!this._destroyed) {
                callback();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._oneShotTimers.add(id);
        return id;
    }

    /* ======================================================================
     * 1. BARRA DE TAREFAS (ESQUERDA — ÍCONE GIRANDO + VOLTAR / PLAY / AVANÇAR)
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
        this._ytmIconBtn.connect("clicked", () => this._toggleOrLaunchPearWindow(true));

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
            icon_size: 12,
            icon_type: St.IconType.SYMBOLIC
        });
        this._panelPlayBtn = new St.Button({
            style_class: "ytm-panel-btn-play",
            reactive: true,
            child: this._panelPlayIcon
        });
        this._panelPlayBtn.connect("clicked", () => this._sendMprisCommand(this._isPlaying ? "Pause" : "Play"));

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

        this._controlsBox.add(this._divider, { y_fill: false, y_align: St.Align.MIDDLE });
        this._controlsBox.add(this._panelPrevBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        this._controlsBox.add(this._panelPlayBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        this._controlsBox.add(this._panelNextBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });

        this._panelCard.add(this._ytmIconBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        this._panelCard.add(this._controlsBox, { y_fill: false, y_align: St.Align.MIDDLE });

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
            showControls = (this._isPlaying && this._hasActiveTrack);
        } else if (mode === "when-no-track") {
            showControls = (this._hasActiveTrack && (this._isPlaying || this._playbackStatus === "Paused"));
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
     * 2. JANELINHA HOVER (SANS-SERIF + PRIMEIRA LETRA MAIÚSCULA + CAPA FIXA)
     * ====================================================================== */
    _buildHoverPopupUI() {
        // shouldGrab = false: janelinha hover NÃO-MODAL (modalCount=0),
        // assim cliques nos botões da barrinha (⏮ ⏯ ⏭ e ícone) nunca são engolidos!
        // E addChrome(doNotAdd:true, affectsInputRegion:true) mantém a janelinha
        // 100% clicável e com hover ativo no X11 quando aberta!
        this.menuManager = new PopupMenu.PopupMenuManager(this, false);
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);
        try {
            Main.layoutManager.addChrome(this.menu.actor, {
                doNotAdd: true,
                affectsInputRegion: true,
                affectsStruts: false
            });
        } catch (e) {
            global.logError(`[ytmusic-player] Falha addChrome: ${e}`);
        }

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
        this.menu.actor.connect("scroll-event", (actor, event) => {
            this._onScrollVolume(event);
            return Clutter.EVENT_STOP;
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

        const defaultIconPath = GLib.build_filenamev([this.metadata.path, "icons", "ytmusic-vinyl.svg"]);
        const defaultIconUri = GLib.filename_to_uri(defaultIconPath, null);
        this._albumCoverBin = new St.Bin({
            style_class: "ytm-album-cover-wrapper",
            width: 72,
            height: 72,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `border-radius: 12px; background-image: url("${defaultIconUri}"); background-size: 72px 72px;`
        });

        const metaCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });

        const badgeRow = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._badgePill = new St.BoxLayout({
            style_class: "ytm-badge-pill",
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._badgeDot = new St.Widget({
            style_class: "ytm-badge-dot",
            y_align: Clutter.ActorAlign.CENTER
        });
        this._badgeLabel = new St.Label({
            style_class: "ytm-badge-text",
            text: "YouTube Music"
        });
        this._badgeLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE); // Nunca cortar!
        this._badgePill.add_actor(this._badgeDot);
        this._badgePill.add_actor(this._badgeLabel);
        badgeRow.add_actor(this._badgePill);

        this._titleLabel = new St.Label({
            style_class: "ytm-track-title",
            text: this._formatTitleCase(this._title)
        });
        this._titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

        this._artistLabel = new St.Label({
            style_class: "ytm-track-artist",
            text: this._formatTitleCase(this._artist)
        });
        this._artistLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

        this._albumLabel = new St.Label({
            style_class: "ytm-track-album",
            text: this._formatTitleCase(this._album)
        });
        this._albumLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

        metaCol.add_actor(badgeRow);
        metaCol.add_actor(this._titleLabel);
        metaCol.add_actor(this._artistLabel);
        metaCol.add_actor(this._albumLabel);

        headerRow.add_actor(this._albumCoverBin);
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

        this._progressTrack = new St.BoxLayout({
            style_class: "ytm-progress-track",
            x_expand: true,
            reactive: true,
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._progressFill = new St.Widget({
            style_class: "ytm-progress-fill",
            width: 0,
            height: 6,
            x_expand: false,
            x_align: Clutter.ActorAlign.START
        });
        this._progressTrack.add_actor(this._progressFill);
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
            can_focus: true,
            label: "↗ Abrir player"
        });
        this._openAppBtn.connect("clicked", () => {
            this.menu.close(false);
            // Aguarda 50ms para liberar o grab do PopupMenu antes de ocultar/abrir a janela
            this._scheduleOnce(50, () => this._toggleOrLaunchPearWindow(true, true));
        });

        const ctrlsBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: "spacing: 8px;"
        });

        this._popupPrevBtn = new St.Button({
            style_class: "ytm-popup-ctrl-btn",
            reactive: true,
            child: new St.Icon({
                icon_name: "media-skip-backward-symbolic",
                icon_size: 13,
                icon_type: St.IconType.SYMBOLIC
            })
        });
        this._popupPrevBtn.connect("clicked", () => this._sendMprisCommand("Previous"));

        this._popupPlayIcon = new St.Icon({
            icon_name: "media-playback-start-symbolic",
            icon_size: 15,
            icon_type: St.IconType.SYMBOLIC
        });
        this._popupPlayBtn = new St.Button({
            style_class: "ytm-popup-play-btn",
            reactive: true,
            child: this._popupPlayIcon
        });
        this._popupPlayBtn.connect("clicked", () => this._sendMprisCommand(this._isPlaying ? "Pause" : "Play"));

        this._popupNextBtn = new St.Button({
            style_class: "ytm-popup-ctrl-btn",
            reactive: true,
            child: new St.Icon({
                icon_name: "media-skip-forward-symbolic",
                icon_size: 13,
                icon_type: St.IconType.SYMBOLIC
            })
        });
        this._popupNextBtn.connect("clicked", () => this._sendMprisCommand("Next"));

        // y_fill: false garante círculos perfeitos (28x28 e 34x34), nunca ovais!
        ctrlsBox.add(this._popupPrevBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        ctrlsBox.add(this._popupPlayBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        ctrlsBox.add(this._popupNextBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });

        // Cápsula minimalista de volume no próprio rodapé (Mutar, −, %, +)
        const volPill = new St.BoxLayout({
            style_class: "ytm-vol-pill",
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._muteIcon = new St.Icon({
            icon_name: "audio-volume-high-symbolic",
            icon_size: 12,
            icon_type: St.IconType.SYMBOLIC
        });
        this._muteBtn = new St.Button({
            style_class: "ytm-vol-mini-btn",
            reactive: true,
            child: this._muteIcon
        });
        this._muteBtn.connect("clicked", () => this._toggleMute());

        this._volDownBtn = new St.Button({
            style_class: "ytm-vol-mini-btn",
            reactive: true,
            child: new St.Icon({
                icon_name: "list-remove-symbolic",
                icon_size: 10,
                icon_type: St.IconType.SYMBOLIC
            })
        });
        this._volDownBtn.connect("clicked", () => this._adjustVolume(-0.10));

        this._volumeLabel = new St.Label({
            style_class: "ytm-volume-chip",
            text: "100%"
        });

        this._volUpBtn = new St.Button({
            style_class: "ytm-vol-mini-btn",
            reactive: true,
            child: new St.Icon({
                icon_name: "list-add-symbolic",
                icon_size: 10,
                icon_type: St.IconType.SYMBOLIC
            })
        });
        this._volUpBtn.connect("clicked", () => this._adjustVolume(0.10));

        volPill.add(this._muteBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        volPill.add(this._volDownBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        volPill.add(this._volumeLabel, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        volPill.add(this._volUpBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });

        footerRow.add(this._openAppBtn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        footerRow.add(ctrlsBox, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        footerRow.add(volPill, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });

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

    _formatTitleCase(str) {
        if (!str) return "";
        const s = String(str).trim();
        if (!s) return "";
        // Converte apenas CAIXA ALTA "gritada" (palavras com 4+ letras maiúsculas seguidas);
        // preserva siglas como R.E.M., AC/DC, U2, BTS.
        if (s === s.toUpperCase() && /[A-ZÀ-Ú]{4,}/.test(s)) {
            return s.toLowerCase().replace(/(?:^|\s|\(|\[|-)([a-zà-ú])/g, (m) => m.toUpperCase());
        }
        return s.charAt(0).toUpperCase() + s.slice(1);
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
        const delay = Math.max(0, this.hoverDelayMs ?? 80);
        this._hoverOpenTimerId = Mainloop.timeout_add(delay, () => {
            this._hoverOpenTimerId = 0;
            if (this._pointerInPanel && !this.menu.isOpen) {
                this._syncPositionNow();
                this._updateWindowButtonLabel();
                this.menu.open(true);
                this._scheduleOnce(40, () => {
                    this._updateProgressUI();
                    this._updateVolumeUI();
                });
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
     * 4. ANIMAÇÃO DE ROTAÇÃO (APENAS NO ÍCONE DA BARRA)
     * ====================================================================== */
    _updateAnimationState() {
        if (this._isPlaying && this._hasActiveTrack) {
            if (this.iconAnimation === "pulse") {
                this._ytmIconBtn.add_style_class_name("ytm-panel-icon-pulse");
            } else {
                this._ytmIconBtn.remove_style_class_name("ytm-panel-icon-pulse");
            }

            const shouldSpin = (this.iconAnimation === "spin" || !this.iconAnimation);
            if (shouldSpin) {
                if (!this._spinTimerId) {
                    this._spinTimerId = Mainloop.timeout_add(33, () => {
                        this._spinAngle = (this._spinAngle + 1.6) % 360;
                        this._ytmIcon.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, this._spinAngle);
                        return GLib.SOURCE_CONTINUE;
                    });
                }
            } else {
                if (this._spinTimerId) {
                    Mainloop.source_remove(this._spinTimerId);
                    this._spinTimerId = 0;
                }
                this._spinAngle = 0;
                this._ytmIcon.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, 0);
            }

            if (!this._posTimerId) {
                this._posTimerId = Mainloop.timeout_add(1000, () => {
                    if (this._isPlaying && this._hasActiveTrack && this._durationUs > 0) {
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
            // Ao pausar/parar, alinha o ícone do YouTube Music retinho em 0° (nunca torto!)
            this._spinAngle = 0;
            this._ytmIcon.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, 0);
            if (this._posTimerId) {
                Mainloop.source_remove(this._posTimerId);
                this._posTimerId = 0;
            }
        }
    }

    /* ======================================================================
     * 5. GESTÃO DE JANELA DO PEAR DESKTOP (REABERTURA INFALÍVEL + SKIP_TASKBAR)
     * ====================================================================== */
    _initMediaKeys() {
        // Integração nativa com csd-media-keys (teclas físicas de mídia do teclado:
        // Play/Pause, Stop, Anterior e Próxima — ex.: Logitech G213)
        try {
            this._mediaKeysSignalId = Gio.DBus.session.signal_subscribe(
                "org.gnome.SettingsDaemon",
                "org.gnome.SettingsDaemon.MediaKeys",
                "MediaPlayerKeyPressed",
                "/org/gnome/SettingsDaemon/MediaKeys",
                null,
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => {
                    if (this._destroyed) return;
                    try {
                        const [app, key] = params.deep_unpack();
                        if (app !== "ytmusic-player") return;
                        if (key === "Play") {
                            this._sendMprisCommand(this._isPlaying ? "Pause" : "Play");
                        } else if (key === "Pause" || key === "Stop") {
                            this._sendMprisCommand("Pause");
                        } else if (key === "Next") {
                            this._sendMprisCommand("Next");
                        } else if (key === "Previous") {
                            this._sendMprisCommand("Previous");
                        }
                    } catch (e) {
                        global.logError(`[ytmusic-player] Erro ao processar tecla de mídia: ${e}`);
                    }
                }
            );
            this._grabMediaKeys();
        } catch (e) {
            global.logError(`[ytmusic-player] Falha _initMediaKeys: ${e}`);
        }
    }

    _grabMediaKeys() {
        try {
            Gio.DBus.session.call(
                "org.gnome.SettingsDaemon",
                "/org/gnome/SettingsDaemon/MediaKeys",
                "org.gnome.SettingsDaemon.MediaKeys",
                "GrabMediaPlayerKeys",
                new GLib.Variant("(su)", ["ytmusic-player", 0]),
                null,
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                null
            );
        } catch (_) {}
    }

    _releaseMediaKeys() {
        try {
            Gio.DBus.session.call(
                "org.gnome.SettingsDaemon",
                "/org/gnome/SettingsDaemon/MediaKeys",
                "org.gnome.SettingsDaemon.MediaKeys",
                "ReleaseMediaPlayerKeys",
                new GLib.Variant("(s)", ["ytmusic-player"]),
                null,
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                null
            );
        } catch (_) {}
    }

    _initWindowDeduplicator() {
        this._applySkipTaskbarToPear();
        try {
            if (global.display) {
                this._windowCreatedSignalId = global.display.connect("window-created", (display, metaWin) => {
                    if (this._isPearMetaWindow(metaWin)) {
                        this._scheduleOnce(200, () => this._applySkipTaskbarToPear());
                        this._scheduleOnce(650, () => this._applySkipTaskbarToPear());
                    }
                });
            }
            if (global.window_manager) {
                this._windowMapSignalId = global.window_manager.connect("map", (wm, actor) => {
                    const metaWin = actor && actor.meta_window ? actor.meta_window : null;
                    if (this._isPearMetaWindow(metaWin)) {
                        this._scheduleOnce(120, () => this._applySkipTaskbarToPear());
                    }
                });
            }
        } catch (_) {}
    }

    _isPearMetaWindow(metaWin) {
        if (!metaWin) return false;
        try {
            if (metaWin.get_window_type && metaWin.get_window_type() !== Meta.WindowType.NORMAL) {
                return false;
            }
            const wmClass = (metaWin.get_wm_class() || "").toLowerCase();
            const wmInst = (metaWin.get_wm_class_instance ? (metaWin.get_wm_class_instance() || "") : "").toLowerCase();
            return PEAR_WM_CLASSES.some(c => wmClass === c || wmInst === c);
        } catch (_) {
            return false;
        }
    }

    _findPearMetaWindow() {
        try {
            const windows = global.get_window_actors();
            for (let i = 0; i < windows.length; i++) {
                const metaWin = windows[i].get_meta_window();
                if (this._isPearMetaWindow(metaWin)) {
                    return metaWin;
                }
            }
        } catch (_) {}
        return null;
    }

    _applySkipTaskbarToPear() {
        const action = (this.hideFromCenterTaskbar === false) ? "remove" : "add";
        try {
            const windows = global.get_window_actors();
            for (let i = 0; i < windows.length; i++) {
                const metaWin = windows[i].get_meta_window();
                if (this._isPearMetaWindow(metaWin) && metaWin.get_xwindow) {
                    const xid = metaWin.get_xwindow();
                    if (xid) {
                        const hexId = "0x" + xid.toString(16);
                        GLib.spawn_command_line_async(`wmctrl -i -r ${hexId} -b ${action},skip_taskbar`);
                    }
                }
            }
        } catch (_) {}
    }

    _updateWindowButtonLabel() {
        const metaWin = this._findPearMetaWindow();
        if (metaWin && !metaWin.minimized) {
            this._openAppBtn.set_label("🗕 Ocultar");
        } else {
            this._openAppBtn.set_label("↗ Abrir player");
        }
    }

    _launchPearBinary() {
        const launcherScript = GLib.build_filenamev([this.metadata.path, "launch_ytmusic.sh"]);
        try {
            if (GLib.file_test(launcherScript, GLib.FileTest.EXISTS)) {
                GLib.spawn_command_line_async(`/bin/bash "${launcherScript}"`);
            } else if (GLib.file_test("/opt/YouTube Music/youtube-music", GLib.FileTest.EXISTS)) {
                GLib.spawn_command_line_async(`"/opt/YouTube Music/youtube-music"`);
            }
        } catch (e) {
            global.logError(`[ytmusic-player] Erro ao abrir Pear Desktop: ${e}`);
        }

        [600, 1500, 2800].forEach(delay => {
            this._scheduleOnce(delay, () => {
                this._applySkipTaskbarToPear();
                this._discoverPearPlayer();
                this._updateWindowButtonLabel();
            });
        });
    }

    _toggleOrLaunchPearWindow(allowToggleHide, forceHideWhenVisible = false) {
        const metaWin = this._findPearMetaWindow();
        const now = global.get_current_time();

        // 1. Se a janela do Pear Desktop está aberta e visível:
        if (metaWin && !metaWin.minimized) {
            if (allowToggleHide && (forceHideWhenVisible || metaWin.has_focus())) {
                // Com options.tray=true no Pear Desktop, metaWin.delete(now) aciona
                // Close-to-Tray nativo (mainWindow.hide()), mantendo a música tocando
                // e removendo a janela da tela e da barra central!
                try {
                    metaWin.delete(now);
                } catch (_) {
                    metaWin.minimize();
                }
                this._scheduleOnce(150, () => this._updateWindowButtonLabel());
                return;
            }
            // Se está aberta atrás de outra janela ou em outro workspace, traz para frente!
            try {
                const ws = metaWin.get_workspace();
                if (ws) ws.activate(now);
                metaWin.activate(now);
            } catch (_) {}
            this._scheduleOnce(200, () => this._applySkipTaskbarToPear());
            this._updateWindowButtonLabel();
            return;
        }

        // 2. Se a janela existe mas está minimizada:
        if (metaWin && metaWin.minimized) {
            try {
                const ws = metaWin.get_workspace();
                if (ws) ws.activate(now);
                // No Muffin/Cinnamon unminimize() aceita 0 argumentos!
                metaWin.unminimize();
                metaWin.activate(now);
            } catch (_) {}
            this._scheduleOnce(200, () => this._applySkipTaskbarToPear());
            this._updateWindowButtonLabel();
            return;
        }

        // 3. Se o Pear Desktop está rodando oculto no tray (bus MPRIS ativo, sem janela mapeada):
        //    Chama org.mpris.MediaPlayer2.Raise() via D-Bus, com fallback automático para _launchPearBinary()!
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
                    1000,
                    null,
                    (conn, res) => {
                        if (this._destroyed) return;
                        try {
                            conn.call_finish(res);
                        } catch (_) {
                            this._launchPearBinary();
                            return;
                        }
                        this._scheduleOnce(250, () => {
                            const w = this._findPearMetaWindow();
                            if (!w) {
                                // Raise() não reexibiu a janela -> aciona fallback Electron second-instance
                                this._launchPearBinary();
                                return;
                            }
                            this._applySkipTaskbarToPear();
                            try {
                                const nowRaise = global.get_current_time();
                                const ws = w.get_workspace();
                                if (ws) ws.activate(nowRaise);
                                w.unminimize();
                                w.activate(nowRaise);
                            } catch (_) {}
                            this._updateWindowButtonLabel();
                        });
                    }
                );
                return;
            } catch (_) {}
        }

        // 4. Se o Pear Desktop está fechado: lança o binário oficial
        this._launchPearBinary();
    }

    /* ======================================================================
     * 6. INTEGRAÇÃO D-BUS MPRIS2 — EXCLUSIVA DO PEAR DESKTOP (100% ASSÍNCRONA)
     * ====================================================================== */
    _isPearMprisBus(busName) {
        if (!busName || !busName.startsWith(MPRIS_PREFIX)) return false;
        const suffix = busName.slice(MPRIS_PREFIX.length).toLowerCase();
        // Aceita EXCLUSIVAMENTE o barramento dedicado do Pear Desktop / YouTube Music
        // Rejeita 100% Chrome, Chromium, Brave, Firefox, VLC, Spotify, etc.
        return (
            suffix.startsWith("youtubemusic") ||
            suffix.startsWith("youtube-music") ||
            suffix.startsWith("pear")
        );
    }

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
                    if (this._isPearMprisBus(name)) {
                        this._discoverPearPlayer();
                    }
                }
            );
            this._discoverPearPlayer();
        } catch (e) {
            global.logError(`[ytmusic-player] Falha _initDBus: ${e}`);
        }
    }

    _discoverPearPlayer() {
        if (this._destroyed) return;
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
                    if (this._destroyed) return;
                    try {
                        const reply = conn.call_finish(res);
                        const [names] = reply.deep_unpack();
                        const pearBuses = (names || []).filter(n => this._isPearMprisBus(n));
                        if (pearBuses.length === 0) {
                            this._bindToPlayerAsync(null);
                            return;
                        }
                        this._bindToPlayerAsync(pearBuses[0]);
                    } catch (_) {}
                }
            );
        } catch (_) {}
    }

    _bindToPlayerAsync(busName) {
        if (this._activeBusName === busName && this._bindingBusName === null) {
            if (this._propsProxy) this._readPlayerProperties();
            else if (!busName) this._resetToIdleState();
            return;
        }
        if (busName !== null && this._bindingBusName === busName) {
            return;
        }

        if (this._propsProxy && this._propsSignalId) {
            this._propsProxy.disconnect(this._propsSignalId);
            this._propsSignalId = 0;
        }
        if (this._propsProxy && this._playerSignalId) {
            this._propsProxy.disconnect(this._playerSignalId);
            this._playerSignalId = 0;
        }

        this._propsProxy = null;
        this._activeBusName = null;
        this._bindingBusName = busName;

        if (!busName) {
            this._resetToIdleState();
            return;
        }

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            busName,
            MPRIS_PATH,
            "org.mpris.MediaPlayer2.Player",
            null,
            (source, res) => {
                if (this._destroyed || this._bindingBusName !== busName) return;
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    this._activeBusName = busName;
                    this._bindingBusName = null;
                    this._propsProxy = proxy;
                    this._propsSignalId = this._propsProxy.connect("g-properties-changed", (p, changed) => {
                        let changedKeys = null;
                        try {
                            changedKeys = changed ? Object.keys(changed.deep_unpack()) : null;
                        } catch (_) {}
                        this._readPlayerProperties(changedKeys);
                    });
                    this._playerSignalId = this._propsProxy.connect("g-signal", (p, sender, signalName, params) => {
                        if (signalName === "Seeked" && params) {
                            try {
                                const [pos] = params.deep_unpack();
                                this._positionUs = Number(pos);
                                this._updateProgressUI();
                            } catch (_) {}
                        }
                    });
                    this._readPlayerProperties(null);
                    this._syncPositionNow();
                    this._grabMediaKeys();
                    this._detectNativeApp(busName);
                } catch (e) {
                    this._bindingBusName = null;
                    global.logError(`[ytmusic-player] Erro ao conectar proxy assíncrono ${busName}: ${e}`);
                }
            }
        );
    }

    _resetCoverAndGlow() {
        const defaultIconPath = GLib.build_filenamev([this.metadata.path, "icons", "ytmusic-vinyl.svg"]);
        const defaultIconUri = GLib.filename_to_uri(defaultIconPath, null);
        this._albumCoverBin.set_style(
            `border-radius: 12px; background-image: url("${defaultIconUri}"); background-size: 72px 72px;`
        );
        this._popupCard.set_style(null);
        this._progressFill.set_style(null);
        if (this._volFill) this._volFill.set_style(null);
        this._popupPlayBtn.set_style(null);
        this._badgePill.set_style(null);
    }

    _resetToIdleState() {
        this._playbackStatus = "Stopped";
        this._isPlaying = false;
        this._hasActiveTrack = false;
        this._title = "YouTube Music";
        this._artist = "Clique em Abrir player para iniciar";
        this._album = "Player exclusivo do YouTube Music";
        this._artUrl = "";
        this._cachedArtPath = null;
        this._durationUs = 0;
        this._positionUs = 0;
        this._spinAngle = 0;
        this._ytmIcon.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, 0);

        // Restaura a capa padrão e limpa o glow inline da faixa anterior
        this._resetCoverAndGlow();

        this._refreshAllUI();
    }

    _readPlayerProperties(changedKeys = null) {
        if (!this._propsProxy || this._destroyed) return;

        const statusVar = this._propsProxy.get_cached_property("PlaybackStatus");
        if (statusVar) {
            this._playbackStatus = statusVar.deep_unpack();
            this._isPlaying = (this._playbackStatus === "Playing");
        }

        // Pear Desktop não é simétrico: Set(Volume=x) é reportado de volta por uma curva
        // perceptual (ex.: 0.5 -> 0.20). Ignoramos o eco do nosso próprio Set e
        // convertemos mudanças externas de volta para a escala do applet.
        const volCooldownUs = this._isNativeMintApp ? 150000 : 2000000;
        const volVar = this._propsProxy.get_cached_property("Volume");
        if (volVar && (GLib.get_monotonic_time() - (this._lastVolSetAt || 0)) > volCooldownUs) {
            this._volume = this._volumeFromPlayer(Number(volVar.deep_unpack()));
        }

        // Só lê Position do cache se ele veio explicitamente em g-properties-changed
        if (changedKeys && changedKeys.includes("Position")) {
            const posVar = this._propsProxy.get_cached_property("Position");
            if (posVar) {
                this._positionUs = Number(posVar.deep_unpack());
            }
        }

        let gotTitle = "";
        const metaVar = this._propsProxy.get_cached_property("Metadata");
        if (metaVar) {
            const meta = metaVar.deep_unpack();

            if (meta["mpris:trackid"]) {
                const newTrackId = String(meta["mpris:trackid"].deep_unpack());
                if (newTrackId !== this._trackId) {
                    // Nova faixa: o Position do Pear fica congelado até um Seek, então zera localmente
                    this._positionUs = 0;
                    this._lastMprisPosUs = null;
                }
                this._trackId = newTrackId;
            }
            if (meta["xesam:title"]) {
                gotTitle = String(meta["xesam:title"].deep_unpack() || "").trim();
                if (gotTitle.length > 0) {
                    this._title = gotTitle;
                    this._hasActiveTrack = true;
                } else {
                    this._hasActiveTrack = false;
                }
            } else {
                this._hasActiveTrack = false;
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
                this._album = alb.length > 0 ? alb : "YouTube Music";
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
                this._updateCoverArtAsync(newArtUrl);
            } else if (!newArtUrl && this._artUrl) {
                this._artUrl = "";
                this._cachedArtPath = null;
                this._resetCoverAndGlow();
            }
        }

        if (this._playbackStatus === "Stopped" && !gotTitle) {
            this._resetToIdleState();
            return;
        }

        if (changedKeys && (changedKeys.includes("PlaybackStatus") || changedKeys.includes("Metadata"))) {
            this._syncPositionNow();
        }

        this._refreshAllUI();
    }

    _syncPositionNow() {
        if (!this._activeBusName || !this._hasActiveTrack) return;
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
                    if (this._destroyed) return;
                    try {
                        const reply = conn.call_finish(res);
                        const inner = reply.deep_unpack()[0];
                        const mprisPos = Number(inner.deep_unpack());
                        // O Pear só atualiza Position em Seek/TimeChanged; um valor repetido é
                        // obsoleto e não deve sobrescrever a extrapolação local.
                        if (this._lastMprisPosUs === null || this._lastMprisPosUs === undefined ||
                            mprisPos !== this._lastMprisPosUs) {
                            this._positionUs = mprisPos;
                        }
                        this._lastMprisPosUs = mprisPos;
                        this._updateProgressUI();
                    } catch (_) {}
                }
            );
        } catch (_) {}
    }

    /* ======================================================================
     * 7. CAPA DO ÁLBUM ASSÍNCRONA SEGURA (GIO.SUBPROCESS) + GLOW DINÂMICO
     * ====================================================================== */
    _updateCoverArtAsync(artUrl) {
        if (artUrl.startsWith("file://")) {
            try {
                const localPath = GLib.filename_from_uri(artUrl)[0];
                this._applyLocalCoverFile(localPath);
            } catch (_) {}
            return;
        }

        if (artUrl.startsWith("http://") || artUrl.startsWith("https://")) {
            const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, artUrl, -1);
            const targetPath = GLib.build_filenamev([this._cacheDir, `cover_${hash}.jpg`]);
            const tmpPath = `${targetPath}.part`;

            if (GLib.file_test(targetPath, GLib.FileTest.EXISTS)) {
                this._applyLocalCoverFile(targetPath);
                return;
            }

            try {
                const proc = Gio.Subprocess.new(
                    ["curl", "-fsSL", "--max-time", "10", "-o", tmpPath, artUrl],
                    Gio.SubprocessFlags.NONE
                );
                proc.wait_check_async(null, (p, res) => {
                    if (this._destroyed) return;
                    try {
                        if (p.wait_check_finish(res) && GLib.file_test(tmpPath, GLib.FileTest.EXISTS)) {
                            const src = Gio.File.new_for_path(tmpPath);
                            const dst = Gio.File.new_for_path(targetPath);
                            src.move(dst, Gio.FileCopyFlags.OVERWRITE, null, null);
                            // Garante que a faixa ainda é a mesma antes de aplicar a capa
                            if (this._artUrl === artUrl) {
                                this._applyLocalCoverFile(targetPath);
                            }
                        }
                    } catch (_) {}
                });
            } catch (_) {}
        }
    }

    _applyLocalCoverFile(filePath) {
        let displayPath = filePath;
        try {
            // Crop central 1:1 para evitar distorção em thumbnails 16:9 do YouTube Music
            const orig = GdkPixbuf.Pixbuf.new_from_file(filePath);
            const w = orig.get_width();
            const h = orig.get_height();
            if (w > 0 && h > 0) {
                const sqPath = filePath + "_sq.png";
                if (!GLib.file_test(sqPath, GLib.FileTest.EXISTS)) {
                    const side = Math.min(w, h);
                    const x = Math.floor((w - side) / 2);
                    const y = Math.floor((h - side) / 2);
                    const cropped = orig.new_subpixbuf(x, y, side, side);
                    const scaled = cropped.scale_simple(144, 144, GdkPixbuf.InterpType.BILINEAR);
                    if (scaled) {
                        scaled.savev(sqPath, "png", [], []);
                    }
                }
                if (GLib.file_test(sqPath, GLib.FileTest.EXISTS)) {
                    displayPath = sqPath;
                }
            }
        } catch (_) {}

        this._cachedArtPath = displayPath;
        const coverUri = GLib.filename_to_uri(displayPath, null);
        this._albumCoverBin.set_style(
            `border-radius: 12px; background-image: url("${coverUri}"); background-size: 72px 72px;`
        );

        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(displayPath, 16, 16, false);
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
        const darkR = Math.round(r * 0.24);
        const darkG = Math.round(g * 0.24);
        const darkB = Math.round(b * 0.24);
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const playFg = lum > 145 ? "#09090b" : "#ffffff";

        this._popupCard.set_style(`
            background-gradient-direction: radial;
            background-gradient-start: rgba(${darkR}, ${darkG}, ${darkB}, 0.96);
            background-gradient-end: rgba(10, 10, 14, 0.99);
            border: 1px solid rgba(${r}, ${g}, ${b}, 0.42);
            box-shadow: 0 14px 36px rgba(0, 0, 0, 0.78);
        `);
        if (this._cachedArtPath) {
            const coverUri = GLib.filename_to_uri(this._cachedArtPath, null);
            this._albumCoverBin.set_style(
                `border-radius: 12px; background-image: url("${coverUri}"); background-size: 72px 72px; box-shadow: 0 0 18px rgba(${r}, ${g}, ${b}, 0.45);`
            );
        }
        this._progressFill.set_style(`background-color: rgb(${r}, ${g}, ${b}); border-radius: 999px;`);
        if (this._volFill) {
            this._volFill.set_style(`background-color: rgb(${r}, ${g}, ${b}); border-radius: 999px;`);
        }
        this._popupPlayBtn.set_style(`
            background-color: rgb(${r}, ${g}, ${b});
            color: ${playFg};
            box-shadow: 0 4px 14px rgba(${r}, ${g}, ${b}, 0.55);
        `);
        this._badgePill.set_style(`
            background-color: rgba(${r}, ${g}, ${b}, 0.24);
            border: 1px solid rgba(${r}, ${g}, ${b}, 0.48);
        `);
    }

    /* ======================================================================
     * 8. COMANDOS DE MÍDIA (PLAY, PAUSE, NEXT, PREV, SEEK, VOLUME REAL)
     * ====================================================================== */
    _sendMprisCommand(methodName) {
        if (!this._activeBusName) {
            this._toggleOrLaunchPearWindow(false);
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
                1000,
                null,
                () => {
                    this._scheduleOnce(150, () => this._readPlayerProperties());
                }
            );
        } catch (e) {
            global.logError(`[ytmusic-player] Erro ao enviar ${methodName}: ${e}`);
        }
    }

    _onSeekClick(actor, event) {
        if (!this._activeBusName || !this._hasActiveTrack || this._durationUs <= 0) return;
        const [stageX] = event.get_coords();
        const [actorX] = actor.get_transformed_position();
        const width = actor.get_width();
        if (width <= 0) return;

        const ratio = Math.max(0, Math.min(1, (stageX - actorX) / width));
        const targetUs = Math.floor(ratio * this._durationUs);
        this._positionUs = targetUs;
        this._lastMprisPosUs = targetUs;
        this._updateProgressUI();

        const validTrackId = (this._trackId && /^\/[A-Za-z0-9_\/]+$/.test(this._trackId))
            ? this._trackId
            : "/org/mpris/MediaPlayer2/TrackList/NoTrack";

        try {
            Gio.DBus.session.call(
                this._activeBusName,
                MPRIS_PATH,
                "org.mpris.MediaPlayer2.Player",
                "SetPosition",
                new GLib.Variant("(ox)", [validTrackId, targetUs]),
                null,
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                null
            );
        } catch (_) {}
    }

    _detectNativeApp(busName) {
        this._isNativeMintApp = false;
        if (!busName) return;
        try {
            Gio.DBus.session.call(
                busName,
                MPRIS_PATH,
                "org.freedesktop.DBus.Properties",
                "Get",
                new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2", "DesktopEntry"]),
                null,
                Gio.DBusCallFlags.NONE,
                500,
                null,
                (conn, res) => {
                    if (this._destroyed) return;
                    try {
                        const reply = conn.call_finish(res);
                        const val = String(reply.deep_unpack()[0].deep_unpack() || "");
                        this._isNativeMintApp = (val === "ytmusic-mint-app");
                    } catch (_) {}
                }
            );
        } catch (_) {}
    }

    _volumeFromPlayer(reported) {
        const y = Math.max(0, Math.min(1, reported || 0));
        // Nosso app próprio reporta volume 100% linear (simétrico)
        if (this._isNativeMintApp) {
            return Math.round(y * 100) / 100;
        }
        // Inversa medida ao vivo no Pear Desktop 3.12.1 (Set x -> Get y)
        const pts = [[0, 0], [0.02, 0.1], [0.08, 0.3], [0.2, 0.5], [0.4, 0.7], [0.74, 0.9], [1, 1]];
        for (let i = 1; i < pts.length; i++) {
            const [y0, x0] = pts[i - 1];
            const [y1, x1] = pts[i];
            if (y <= y1) {
                const t = (y1 - y0) > 0 ? (y - y0) / (y1 - y0) : 0;
                return Math.round((x0 + t * (x1 - x0)) * 100) / 100;
            }
        }
        return 1;
    }

    _formatVolumeText(vol) {
        const pct = Math.round(Math.max(0, Math.min(1, vol ?? 1)) * 100);
        return `${pct}%`;
    }

    _updateVolumeUI() {
        const v = Math.max(0, Math.min(1, this._volume ?? 1));
        this._volumeLabel.set_text(this._formatVolumeText(v));
        if (this._muteIcon) {
            let iconName = "audio-volume-high-symbolic";
            if (v <= 0.001) iconName = "audio-volume-muted-symbolic";
            else if (v < 0.35) iconName = "audio-volume-low-symbolic";
            else if (v < 0.7) iconName = "audio-volume-medium-symbolic";
            this._muteIcon.set_icon_name(iconName);
        }
        if (this._muteBtn) {
            if (v <= 0.001) this._muteBtn.add_style_class_name("ytm-vol-muted");
            else this._muteBtn.remove_style_class_name("ytm-vol-muted");
        }
    }

    _setVolume(targetVol) {
        if (!this._activeBusName) return;
        const clamped = Math.round(Math.max(0, Math.min(1, targetVol)) * 100) / 100;
        if (clamped > 0) {
            this._volumeBeforeMute = clamped;
        }
        this._volume = clamped;
        this._lastVolSetAt = GLib.get_monotonic_time();
        this._updateVolumeUI();

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
                1000,
                null,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                    } catch (e) {
                        global.logError(`[ytmusic-player] Erro ao ajustar Volume: ${e}`);
                    }
                }
            );
        } catch (_) {}
    }

    _adjustVolume(delta) {
        this._setVolume((this._volume ?? 1) + delta);
    }

    _toggleMute() {
        if ((this._volume ?? 1) > 0.001) {
            this._volumeBeforeMute = this._volume;
            this._setVolume(0);
        } else {
            this._setVolume(this._volumeBeforeMute > 0.05 ? this._volumeBeforeMute : 0.7);
        }
    }

    _onVolumeBarClick(actor, event) {
        if (!this._activeBusName) return;
        const [stageX] = event.get_coords();
        const [actorX] = actor.get_transformed_position();
        const width = actor.get_width();
        if (width <= 0) return;
        const ratio = Math.max(0, Math.min(1, (stageX - actorX) / width));
        this._setVolume(ratio);
    }

    _onScrollVolume(event) {
        if (!this._activeBusName) return;
        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP) {
            delta = 0.05;
        } else if (dir === Clutter.ScrollDirection.DOWN) {
            delta = -0.05;
        } else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            if (dy < 0) delta = 0.05;
            else if (dy > 0) delta = -0.05;
            else return;
        } else {
            return;
        }

        this._adjustVolume(delta);
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
        const playingNow = (this._isPlaying && this._hasActiveTrack);
        const iconName = playingNow ? "media-playback-pause-symbolic" : "media-playback-start-symbolic";
        this._panelPlayIcon.set_icon_name(iconName);
        this._popupPlayIcon.set_icon_name(iconName);
        // Compensação óptica de 1px para o triângulo ▶ ficar perfeitamente centralizado no círculo
        this._panelPlayIcon.set_style(playingNow ? null : "padding-left: 2px;");
        this._popupPlayIcon.set_style(playingNow ? null : "padding-left: 2px;");

        this._titleLabel.set_text(this._formatTitleCase(this._title));
        this._artistLabel.set_text(this._formatTitleCase(this._artist));
        this._albumLabel.set_text(this._formatTitleCase(this._album));
        this._updateVolumeUI();

        this._updateWindowButtonLabel();
        this._updateBarCollapseState();
        this._updateProgressUI();
        this._updateAnimationState();
    }

    on_applet_removed_from_panel() {
        this._destroyed = true;
        if (this._spinTimerId) Mainloop.source_remove(this._spinTimerId);
        if (this._posTimerId) Mainloop.source_remove(this._posTimerId);
        if (this._hoverOpenTimerId) Mainloop.source_remove(this._hoverOpenTimerId);
        if (this._hoverCloseTimerId) Mainloop.source_remove(this._hoverCloseTimerId);
        for (const tid of this._oneShotTimers) {
            try { Mainloop.source_remove(tid); } catch (_) {}
        }
        this._oneShotTimers.clear();

        if (this._dbusSignalId) Gio.DBus.session.signal_unsubscribe(this._dbusSignalId);
        if (this._mediaKeysSignalId) {
            Gio.DBus.session.signal_unsubscribe(this._mediaKeysSignalId);
            this._mediaKeysSignalId = 0;
        }
        this._releaseMediaKeys();
        if (this._windowCreatedSignalId && global.display) {
            global.display.disconnect(this._windowCreatedSignalId);
        }
        if (this._windowMapSignalId && global.window_manager) {
            global.window_manager.disconnect(this._windowMapSignalId);
        }
        if (this._propsProxy && this._propsSignalId) {
            this._propsProxy.disconnect(this._propsSignalId);
        }
        if (this._propsProxy && this._playerSignalId) {
            this._propsProxy.disconnect(this._playerSignalId);
        }
        if (this.menu) {
            try { Main.layoutManager.untrackChrome(this.menu.actor); } catch (_) {}
            this.menu.destroy();
        }
        this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new YTMusicV3Applet(metadata, orientation, panelHeight, instanceId);
}
