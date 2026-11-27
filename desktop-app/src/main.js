"use strict";

/**
 * YouTube Music Mint App — Shell Electron Minimalista & Endurecido (v1.0)
 *
 * Princípios de segurança:
 *  - sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true
 *  - Zero plugins de terceiros, zero servidor HTTP local, zero telemetria
 *  - Allowlist estrita de domínios Google / YouTube Music + bloqueio de trackers
 *  - Bloqueio padrão de permissões (câmera, mic, geo, USB, notificações)
 *  - Close-to-Tray nativo silencioso (sem ícone duplicado na bandeja direita)
 *  - MPRIS2 exclusivo (org.mpris.MediaPlayer2.YoutubeMusic) integrado ao Applet Cinnamon
 */

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require("electron");
const { MprisService } = require("./mpris");

const APP_NAME = "ytmusic-mint-app";
const HOME_URL = "https://music.youtube.com";
const DATA_DIR = path.join(app.getPath("appData"), APP_NAME);
const STATE_FILE = path.join(DATA_DIR, "window-state.json");
const THEME_CSS_PATH = path.join(__dirname, "theme.css");
const ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");

app.setName(APP_NAME);
app.setPath("userData", DATA_DIR);

// Single-instance lock: relançar o binário apenas reexibe e foca a janela existente
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Allowlist de domínios para navegação top-level (app + fluxo completo de login Google/YouTube)
const ALLOWED_NAV_HOSTS = [
  "music.youtube.com",
  "www.youtube.com",
  "accounts.google.com",
  "accounts.google.com.br",
  "accounts.youtube.com",
  "myaccount.google.com",
  "gds.google.com",
  "ogs.google.com",
  "consent.google.com",
  "consent.youtube.com",
];

// Allowlist de sufixos para sub-recursos da página (áudio, capas, scripts oficiais)
const ALLOWED_RESOURCE_SUFFIXES = [
  ".youtube.com",
  ".ytimg.com",
  ".googlevideo.com",
  ".googleusercontent.com",
  ".gstatic.com",
  ".googleapis.com",
  ".google.com",
  ".google.com.br",
  ".ggpht.com",
  ".gvt1.com",
];

// Domínios de trackers/anúncios bloqueados mesmo sob sufixos do Google
const BLOCKED_TRACKER_HOSTS = [
  "doubleclick.net",
  "googleadservices.com",
  "googlesyndication.com",
  "google-analytics.com",
  "adservice.google.com",
  "pagead2.googlesyndication.com",
];

function hostMatches(hostname, exactList, suffixList = []) {
  const h = (hostname || "").toLowerCase();
  if (!h) return false;
  if (exactList.includes(h)) return true;
  return suffixList.some((suf) => h === suf.slice(1) || h.endsWith(suf));
}

function isAllowedNavigation(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    return hostMatches(u.hostname, ALLOWED_NAV_HOSTS);
  } catch (_) {
    return false;
  }
}

function isAllowedRequest(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol === "data:" || u.protocol === "blob:") return true;
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (BLOCKED_TRACKER_HOSTS.some((b) => h === b || h.endsWith("." + b))) {
      return false;
    }
    return hostMatches(h, ALLOWED_NAV_HOSTS, ALLOWED_RESOURCE_SUFFIXES);
  } catch (_) {
    return false;
  }
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      width: Math.max(820, Math.min(2560, Number(parsed.width) || 1140)),
      height: Math.max(560, Math.min(1600, Number(parsed.height) || 800)),
      x: typeof parsed.x === "number" ? parsed.x : undefined,
      y: typeof parsed.y === "number" ? parsed.y : undefined,
      lastUrl: typeof parsed.lastUrl === "string" && parsed.lastUrl.startsWith(HOME_URL)
        ? parsed.lastUrl
        : HOME_URL,
    };
  } catch (_) {
    return { width: 1140, height: 800, lastUrl: HOME_URL };
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const bounds = win.getBounds();
    const currentUrl = win.webContents.getURL();
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      lastUrl: currentUrl.startsWith(HOME_URL) ? currentUrl : HOME_URL,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (_) {}
}

let mainWindow = null;
let isQuitting = false;
let mpris = null;
let themeCssCache = "";

function readThemeCss() {
  try {
    themeCssCache = fs.readFileSync(THEME_CSS_PATH, "utf8");
  } catch (_) {
    themeCssCache = "";
  }
  return themeCssCache;
}

function showAndFocusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isGoogleAuthHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return (
      h === "accounts.google.com" ||
      h.startsWith("accounts.google.") ||
      h === "accounts.youtube.com" ||
      h === "gds.google.com"
    );
  } catch (_) {
    return false;
  }
}

const YOUTUBE_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.152 Safari/537.36";
let originalElectronUA = "";

function configureSecurity(ses) {
  originalElectronUA = ses.getUserAgent();

  // UA estável validado para YouTube/YouTube Music (evita a tela "Não foi possível fazer login no YouTube")
  ses.setUserAgent(YOUTUBE_CHROME_UA);
  app.userAgentFallback = YOUTUBE_CHROME_UA;

  // Bloqueio padrão de permissões (libera apenas mídia/DRM e fullscreen)
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = permission === "mediaKeySystem" || permission === "fullscreen";
    callback(allowed);
  });

  ses.setPermissionCheckHandler((_wc, permission) => {
    return permission === "mediaKeySystem" || permission === "fullscreen";
  });

  // Allowlist estrita de rede + bloqueio de trackers
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allow = isAllowedRequest(details.url);
    if (!allow && process.env.YTM_DEBUG === "1") {
      console.log("[blocked]", details.url);
    }
    callback({ cancel: !allow });
  });

  // Em accounts.google.com envia o UA nativo do Electron 45 (passa 3/3 no BotGuard);
  // em www.youtube.com/signin e music.youtube.com usa YOUTUBE_CHROME_UA (passa 100% no SetSID).
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.webContents.getURL().startsWith("https://accounts.google.com") &&
      details.url.startsWith("https://accounts.google.com")
    ) {
      headers["User-Agent"] = originalElectronUA;
    }
    callback({ requestHeaders: headers });
  });
}

function createWindow() {
  const state = loadWindowState();
  readThemeCss();

  // Remove totalmente a barra de menus feia do Electron no topo
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 820,
    minHeight: 560,
    title: "YouTube Music",
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    backgroundColor: "#0a0a0e",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: process.env.YTM_DEBUG === "1",
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // Impede navegação top-level para fora da allowlist Google/YouTube Music
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      if (url.startsWith("https://")) {
        shell.openExternal(url).catch(() => {});
      }
      return;
    }
    // Se navegou para a raiz de www.youtube.com após o SetSID, retorna ao YouTube Music
    try {
      const u = new URL(url);
      if (u.hostname === "www.youtube.com" && (u.pathname === "/" || u.pathname === "")) {
        event.preventDefault();
        mainWindow.loadURL(HOME_URL);
      }
    } catch (_) {}
  });

  // Se o YouTube tentar redirecionar /premium no meio do login, direciona limpo ao ServiceLogin
  mainWindow.webContents.on("will-redirect", (event, url) => {
    try {
      const u = new URL(url);
      if (u.hostname.endsWith("youtube.com") && u.pathname === "/premium") {
        event.preventDefault();
        mainWindow.loadURL(
          "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F"
        );
      }
    } catch (_) {}
  });

  // Impede popups arbitrários (permite apenas fluxos OAuth Google na própria janela)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) {
      mainWindow.loadURL(url);
    } else if (url.startsWith("https://")) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  // Injeta nosso Design System CSS em music.youtube.com
  const injectTheme = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = mainWindow.webContents.getURL();
    if (url.startsWith(HOME_URL)) {
      const css = readThemeCss();
      if (css) mainWindow.webContents.insertCSS(css).catch(() => {});
    }
  };
  mainWindow.webContents.on("dom-ready", injectTheme);
  // Após o SetSID gravar os cookies do YouTube, o signin_prompt às vezes fica parado em www.youtube.com;
  // aguardamos 1.5s para persistência dos cookies e direcionamos limpo para music.youtube.com.
  mainWindow.webContents.on("did-finish-load", () => {
    injectTheme();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const cur = mainWindow.webContents.getURL();
    if (cur.startsWith("https://www.youtube.com/signin_prompt")) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().startsWith("https://www.youtube.com/signin_prompt")) {
          mainWindow.loadURL(HOME_URL).catch(() => {});
        }
      }, 1500);
    }
  });

  // Atalhos úteis e seguros (Alt+Left/Right, Ctrl+R/F5, Ctrl+Q para sair de fato)
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if ((input.control && input.key.toLowerCase() === "q")) {
      event.preventDefault();
      isQuitting = true;
      app.quit();
    } else if ((input.control && input.key.toLowerCase() === "r") || input.key === "F5") {
      event.preventDefault();
      mainWindow.webContents.reload();
    } else if (input.alt && input.key === "ArrowLeft" && mainWindow.webContents.canGoBack()) {
      event.preventDefault();
      mainWindow.webContents.goBack();
    } else if (input.alt && input.key === "ArrowRight" && mainWindow.webContents.canGoForward()) {
      event.preventDefault();
      mainWindow.webContents.goForward();
    }
  });

  // Close-to-Tray silencioso: clicar no "X" oculta a janela mantendo a música tocando
  // e sem criar nenhum ícone duplicado na bandeja direita!
  mainWindow.on("close", (event) => {
    saveWindowState(mainWindow);
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (!process.argv.includes("--start-hidden")) {
      showAndFocusWindow();
    }
  });

  const startUrl = process.argv.includes("--sync-login")
    ? "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F"
    : state.lastUrl;
  mainWindow.loadURL(startUrl);
}

app.on("second-instance", () => {
  showAndFocusWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  saveWindowState(mainWindow);
  if (mpris) mpris.stop();
});

app.whenReady().then(async () => {
  configureSecurity(session.defaultSession);

  ipcMain.on("ytm:state", (_event, state) => {
    if (mpris) mpris.updateState(state);
  });

  mpris = new MprisService({
    onRaise: () => showAndFocusWindow(),
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
    onCommand: (cmd, arg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("ytm:command", cmd, arg);
      }
    },
  });

  try {
    await mpris.start();
  } catch (err) {
    console.error("[ytmusic-mint-app] Falha ao registrar MPRIS2:", err.message);
  }

  createWindow();
});
