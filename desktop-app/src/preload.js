"use strict";

// Preload 100% sandbox-safe (sandbox: true, contextIsolation: true):
// Sem acesso a fs, child_process, os ou rede. Apenas ipcRenderer estrito.
const { ipcRenderer } = require("electron");

let lastSnapshotJson = "";
let trackedVideo = null;

function getVideo() {
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

function getVideoId() {
  try {
    const u = new URL(window.location.href);
    const v = u.searchParams.get("v");
    if (v) return v;
  } catch (_) {}
  const link = document.querySelector("ytmusic-player-bar a.ytp-title-link, ytmusic-player-bar .title");
  if (link && link.href) {
    try {
      return new URL(link.href).searchParams.get("v") || "";
    } catch (_) {}
  }
  return "";
}

function pickBestArtwork(artworkList) {
  if (!Array.isArray(artworkList) || artworkList.length === 0) return "";
  let best = artworkList[0];
  let bestScore = 0;
  for (const item of artworkList) {
    if (!item || !item.src) continue;
    const match = String(item.sizes || "").match(/(\d+)x(\d+)/);
    const score = match ? Number(match[1]) * Number(match[2]) : 1;
    if (score >= bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best && best.src ? best.src : "";
}

function readDomMetadata() {
  const bar = document.querySelector("ytmusic-player-bar");
  if (!bar) return { title: "", artist: "", album: "", artUrl: "" };

  const titleEl = bar.querySelector(".title.style-scope.ytmusic-player-bar, yt-formatted-string.title");
  const bylineEl = bar.querySelector(".byline.style-scope.ytmusic-player-bar, span.subtitle yt-formatted-string");
  const imgEl = bar.querySelector("img.image.style-scope.ytmusic-player-bar, .thumbnail-image-wrapper img");

  const title = titleEl ? titleEl.textContent.trim() : "";
  let artist = "";
  let album = "";

  if (bylineEl) {
    const parts = bylineEl.textContent
      .split("•")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 1) artist = parts[0];
    if (parts.length >= 2 && !/^\d{4}$/.test(parts[1])) album = parts[1];
  }

  let artUrl = imgEl && imgEl.src ? imgEl.src : "";
  if (artUrl.startsWith("data:")) artUrl = "";
  return { title, artist, album, artUrl };
}

function readPlayerState(seeked = false) {
  const video = getVideo();
  const domMeta = readDomMetadata();
  const msMeta = navigator.mediaSession && navigator.mediaSession.metadata;

  const title = (msMeta && msMeta.title) || domMeta.title || "";
  const artist = (msMeta && msMeta.artist) || domMeta.artist || "";
  const album = (msMeta && msMeta.album) || domMeta.album || "";
  const artUrl = (msMeta && pickBestArtwork(msMeta.artwork)) || domMeta.artUrl || "";

  let playbackStatus = "Stopped";
  let positionSec = 0;
  let durationSec = 0;
  let volume = 1.0;

  if (video) {
    if (title || video.readyState > 0) {
      playbackStatus = video.paused ? "Paused" : "Playing";
    }
    if (Number.isFinite(video.currentTime)) positionSec = video.currentTime;
    if (Number.isFinite(video.duration) && video.duration > 0) durationSec = video.duration;
    volume = video.muted ? 0 : (Number.isFinite(video.volume) ? video.volume : 1.0);
  }

  // Sincroniza com o slider de volume do YouTube Music quando existir (escala 0..100)
  const volSlider = document.querySelector("ytmusic-player-bar #volume-slider");
  if (volSlider && typeof volSlider.value === "number" && !Number.isNaN(volSlider.value)) {
    volume = Math.max(0, Math.min(1, volSlider.value / 100));
  }

  return {
    playbackStatus,
    positionSec,
    durationSec,
    volume: Math.round(volume * 100) / 100,
    title,
    artist,
    album,
    artUrl,
    videoId: getVideoId() || (title ? title.slice(0, 40) : ""),
    seeked,
  };
}

function emitState(force = false, seeked = false) {
  if (window.location.hostname !== "music.youtube.com") return;
  const state = readPlayerState(seeked);
  const key = JSON.stringify({
    s: state.playbackStatus,
    t: state.title,
    a: state.artist,
    al: state.album,
    art: state.artUrl,
    d: Math.round(state.durationSec),
    p: Math.floor(state.positionSec),
    v: state.volume,
    id: state.videoId,
  });
  if (force || seeked || key !== lastSnapshotJson) {
    lastSnapshotJson = key;
    ipcRenderer.send("ytm:state", state);
  }
}

function attachVideoListeners() {
  const video = getVideo();
  if (!video || video === trackedVideo) return;
  trackedVideo = video;
  for (const ev of ["play", "pause", "ended", "volumechange", "durationchange", "loadedmetadata"]) {
    video.addEventListener(ev, () => emitState(true, false));
  }
  video.addEventListener("seeked", () => emitState(true, true));
}

function setPlayerVolume(vol) {
  const pct = Math.round(Math.max(0, Math.min(1, vol)) * 100);
  const video = getVideo();
  const slider = document.querySelector("ytmusic-player-bar #volume-slider");

  if (slider) {
    slider.value = pct;
    slider.dispatchEvent(new Event("value-change", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    slider.dispatchEvent(new Event("immediate-value-change", { bubbles: true }));
  }
  if (video) {
    video.muted = pct === 0;
    video.volume = pct / 100;
  }
  setTimeout(() => emitState(true, false), 80);
}

function clickSelector(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      el.click();
      return true;
    }
  }
  return false;
}

ipcRenderer.on("ytm:command", (_event, cmd, arg) => {
  if (window.location.hostname !== "music.youtube.com") return;
  const video = getVideo();

  if (cmd === "play") {
    if (video && video.paused) {
      video.play().catch(() => clickSelector(["ytmusic-player-bar #play-pause-button"]));
    } else if (!video) {
      clickSelector(["ytmusic-player-bar #play-pause-button"]);
    }
  } else if (cmd === "pause") {
    if (video && !video.paused) {
      video.pause();
    } else if (!video) {
      clickSelector(["ytmusic-player-bar #play-pause-button"]);
    }
  } else if (cmd === "playPause") {
    if (video) {
      if (video.paused) {
        video.play().catch(() => clickSelector(["ytmusic-player-bar #play-pause-button"]));
      } else {
        video.pause();
      }
    } else {
      clickSelector(["ytmusic-player-bar #play-pause-button"]);
    }
  } else if (cmd === "next") {
    clickSelector([
      "ytmusic-player-bar .next-button",
      'ytmusic-player-bar tp-yt-paper-icon-button[title*="Próxima"]',
      'ytmusic-player-bar tp-yt-paper-icon-button[title*="Next"]',
    ]);
  } else if (cmd === "previous") {
    clickSelector([
      "ytmusic-player-bar .previous-button",
      'ytmusic-player-bar tp-yt-paper-icon-button[title*="Anterior"]',
      'ytmusic-player-bar tp-yt-paper-icon-button[title*="Previous"]',
    ]);
  } else if (cmd === "seekTo" && typeof arg === "number" && video) {
    video.currentTime = Math.max(0, Math.min(video.duration || arg, arg));
    emitState(true, true);
  } else if (cmd === "seekBy" && typeof arg === "number" && video) {
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + arg));
    emitState(true, true);
  } else if (cmd === "setVolume" && typeof arg === "number") {
    setPlayerVolume(arg);
  }

  setTimeout(() => emitState(true, false), 180);
});

window.addEventListener("DOMContentLoaded", () => {
  setInterval(() => {
    attachVideoListeners();
    emitState(false, false);
  }, 800);
});
