"use strict";

const path = require("path");
const { spawn } = require("child_process");

class MprisService {
  constructor(handlers) {
    this._handlers = handlers || {};
    this._proc = null;
    this._buf = "";
  }

  async start() {
    const script = path.join(__dirname, "mpris_bridge.py");
    this._proc = spawn("/usr/bin/python3", [script], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this._proc.stdout.setEncoding("utf8");
    this._proc.stdout.on("data", (chunk) => {
      this._buf += chunk;
      let idx;
      while ((idx = this._buf.indexOf("\n")) !== -1) {
        const line = this._buf.slice(0, idx).trim();
        this._buf = this._buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "raise" && this._handlers.onRaise) {
            this._handlers.onRaise();
          } else if (msg.type === "quit" && this._handlers.onQuit) {
            this._handlers.onQuit();
          } else if (msg.type === "command" && this._handlers.onCommand) {
            this._handlers.onCommand(msg.cmd, msg.arg);
          }
        } catch (_) {}
      }
    });

    this._proc.on("exit", () => {
      this._proc = null;
    });
  }

  updateState(state) {
    if (!this._proc || !this._proc.stdin || this._proc.stdin.destroyed) return;
    try {
      this._proc.stdin.write(JSON.stringify(state) + "\n");
    } catch (_) {}
  }

  stop() {
    if (this._proc) {
      try {
        this._proc.stdin.end();
        this._proc.kill("SIGTERM");
      } catch (_) {}
      this._proc = null;
    }
  }
}

module.exports = { MprisService };
