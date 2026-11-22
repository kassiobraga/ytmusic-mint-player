#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Guardiao de Segundo Plano (Close-to-Bar / Tray Mode) para o YouTube Music PWA
=============================================================================
1. Permite que o Applet da barra OCULTE completamente a janela do YouTube Music
   (X11 windowunmap / withdraw) para que ela suma da tela e do Alt+Tab mas
   continue tocando a música perfeitamente na nossa barrinha!
2. Também monitora caso a janela do YouTube Music seja fechada no "X" enquanto
   uma música estava tocando: reabre o player já oculto em segundo plano para
   que o usuário não perca o player na barra.
"""

import os
import subprocess
import time

YTM_APP_ID = "cinhimbnkkaeohfgghhklpknlkffjgod"
CMD_FIFO = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "ytmusic-mint-window-cmd")
HIDDEN_STATE_FILE = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "ytmusic-mint-hidden-xids")


def find_ytm_windows():
    """Encontra todas as janelas X11 do YouTube Music (visíveis ou ocultas)."""
    xids = []
    for args in (
        ["xdotool", "search", "--classname", YTM_APP_ID],
        ["xdotool", "search", "--class", YTM_APP_ID],
        ["xdotool", "search", "--name", "YouTube Music"],
    ):
        try:
            out = subprocess.check_output(args, stderr=subprocess.DEVNULL, text=True).strip()
            if out:
                for line in out.splitlines():
                    val = int(line.strip())
                    if val not in xids:
                        xids.append(val)
        except Exception:
            pass
    return xids


def load_hidden():
    if os.path.exists(HIDDEN_STATE_FILE):
        try:
            with open(HIDDEN_STATE_FILE, "r") as f:
                return set(int(x) for x in f.read().split() if x.isdigit())
        except Exception:
            pass
    return set()


def save_hidden(s):
    try:
        with open(HIDDEN_STATE_FILE, "w") as f:
            f.write(" ".join(str(x) for x in s))
    except Exception:
        pass


def main():
    hidden_xids = load_hidden()

    while True:
        if os.path.exists(CMD_FIFO):
            try:
                with open(CMD_FIFO, "r") as f:
                    cmd = f.read().strip()
                os.remove(CMD_FIFO)

                current_xids = find_ytm_windows()
                all_xids = list(set(current_xids) | hidden_xids)

                if cmd == "hide":
                    for xid in current_xids:
                        subprocess.call(["xdotool", "windowunmap", str(xid)], stderr=subprocess.DEVNULL)
                        hidden_xids.add(xid)
                    save_hidden(hidden_xids)
                elif cmd == "show":
                    for xid in all_xids:
                        subprocess.call(["xdotool", "windowmap", str(xid)], stderr=subprocess.DEVNULL)
                        subprocess.call(["xdotool", "windowactivate", str(xid)], stderr=subprocess.DEVNULL)
                    hidden_xids.clear()
                    save_hidden(hidden_xids)
                elif cmd == "toggle":
                    if hidden_xids:
                        for xid in all_xids:
                            subprocess.call(["xdotool", "windowmap", str(xid)], stderr=subprocess.DEVNULL)
                            subprocess.call(["xdotool", "windowactivate", str(xid)], stderr=subprocess.DEVNULL)
                        hidden_xids.clear()
                    else:
                        for xid in current_xids:
                            subprocess.call(["xdotool", "windowunmap", str(xid)], stderr=subprocess.DEVNULL)
                            hidden_xids.add(xid)
                    save_hidden(hidden_xids)
            except Exception:
                pass

        time.sleep(0.15)


if __name__ == "__main__":
    main()
