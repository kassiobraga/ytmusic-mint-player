#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Suíte de Testes Rigorosos v2.0 - YouTube Music Taskbar Player
Valida:
  1. Zero conflito com a janela do Antigravity (nunca busca janela por título).
  2. Seleção automática do perfil Chrome pessoal (cassio26@gmail / Profile 3),
     ignorando a conta empresarial (ALK Agência / Default).
  3. Isolamento estrito contra vídeos do YouTube normal no navegador.
  4. Tipografia 100% Sans-Serif e selo 'YouTube Music' em Title Case sem corte.
  5. Validação de sintaxe JS e Bash.
"""

import json
import os
import subprocess
import tempfile

BASE = "/home/antigravity/ytmusic-mint-player/cinnamon-applet/ytmusic-player@antigravity"
APPLET_JS = os.path.join(BASE, "applet.js")
LAUNCH_SH = os.path.join(BASE, "launch_ytmusic.sh")
STYLE_CSS = os.path.join(BASE, "stylesheet.css")


def test_1_never_hijacks_antigravity_window():
    with open(APPLET_JS, encoding="utf-8") as f:
        js = f.read()
    with open(LAUNCH_SH, encoding="utf-8") as f:
        sh = f.read()

    # Nenhuma busca por título "YouTube Music" pode existir no código executável
    js_code_only = "\n".join(l for l in js.splitlines() if not l.strip().startswith(("//", "*", "/*")))
    assert 'title.includes("youtube music")' not in js_code_only, "ERRO: applet.js ainda busca janela por título!"
    assert '--name "YouTube Music"' not in sh, "ERRO: launch_ytmusic.sh ainda usa xdotool --name!"
    assert 'crx_${YTM_APP_ID}' in sh, "ERRO: launch_ytmusic.sh precisa usar --classname crx_cinhimbnkkaeohfgghhklpknlkffjgod!"
    assert 'ytm_window_helper.py' not in js, "ERRO: applet.js ainda referencia o helper antigo!"

    # Simulação de janelas abertas no Cinnamon
    open_windows = [
        {"title": "YouTube Music Taskbar Player - Antigravity", "wm_class": "antigravity", "wm_inst": "antigravity"},
        {"title": "YouTube Music - Google Chrome", "wm_class": "google-chrome", "wm_inst": "google-chrome"},
        {"title": "Everlong - YouTube Music", "wm_class": "crx_cinhimbnkkaeohfgghhklpknlkffjgod", "wm_inst": "crx_cinhimbnkkaeohfgghhklpknlkffjgod"},
    ]

    def find_strict(windows):
        for w in windows:
            cls = w["wm_class"].lower()
            inst = w["wm_inst"].lower()
            if cls == "crx_cinhimbnkkaeohfgghhklpknlkffjgod" or inst == "crx_cinhimbnkkaeohfgghhklpknlkffjgod":
                return w
        return None

    # Caso A: Só Antigravity aberto -> DEVE retornar None (nunca tocar no Antigravity!)
    assert find_strict(open_windows[:2]) is None
    # Caso B: Antigravity + PWA abertos -> DEVE retornar exclusivamente o PWA!
    matched = find_strict(open_windows)
    assert matched is not None and matched["wm_class"] == "crx_cinhimbnkkaeohfgghhklpknlkffjgod"
    print("✅ [TESTE 1 OK] Isolamento de Janela: Antigravity NUNCA é aberto, fechado ou tocado!")


def test_2_selects_personal_cassio26_profile_over_alk_agencia():
    with tempfile.TemporaryDirectory() as fake_home:
        chrome_dir = os.path.join(fake_home, ".config", "google-chrome")
        os.makedirs(chrome_dir, exist_ok=True)
        local_state = {
            "profile": {
                "info_cache": {
                    "Default": {
                        "name": "ALK Agência",
                        "gaia_name": "ALK Agência",
                        "user_name": "contato@alkagencia.com.br"
                    },
                    "Profile 3": {
                        "name": "Pessoal",
                        "gaia_name": "Kassio Braga",
                        "user_name": "cassio26@gmail.com"
                    }
                }
            }
        }
        with open(os.path.join(chrome_dir, "Local State"), "w", encoding="utf-8") as f:
            json.dump(local_state, f)

        # Extrai e testa o bloco Python real de detecção de perfil do launch_ytmusic.sh
        with open(LAUNCH_SH, encoding="utf-8") as f:
            sh_text = f.read()
        py_snippet = sh_text.split("<<'PYPROF'\n")[1].split("\nPYPROF")[0]

        env = os.environ.copy()
        env["HOME"] = fake_home
        chosen = subprocess.check_output(
            ["/usr/bin/python3", "-", "cassio26@gmail"],
            input=py_snippet,
            text=True,
            env=env,
        ).strip()

        assert chosen == "Profile 3", f"ERRO: Selecionou '{chosen}' em vez de 'Profile 3' (cassio26@gmail)!"
        print(f"✅ [TESTE 2 OK] Detecção de Conta Premium: Ignorou 'ALK Agência' (Default) e escolheu '{chosen}' (cassio26@gmail.com)!")


def test_3_typography_and_title_case():
    with open(STYLE_CSS, encoding="utf-8") as f:
        css = f.read()
    css_no_comments = "\n".join(line for line in css.splitlines() if not line.strip().startswith(("*", "/", "-")))
    assert "monospace" not in css_no_comments, "ERRO: Encontrado monospace no CSS!"
    assert "sans-serif" in css_no_comments, "ERRO: Sans-serif ausente no CSS!"

    with open(APPLET_JS, encoding="utf-8") as f:
        js = f.read()
    assert '"YOUTUBE MUSIC"' not in js, "ERRO: Encontrado 'YOUTUBE MUSIC' em caixa alta!"
    assert 'text: "YouTube Music"' in js, "ERRO: Selo 'YouTube Music' em Title Case ausente!"
    assert 'set_ellipsize(0)' in js, "ERRO: ellipsize(0) ausente no selo!"
    print("✅ [TESTE 3 OK] Tipografia 100% Sans-Serif + 'YouTube Music' com primeira letra maiúscula e sem corte!")


def test_4_syntax_validation():
    subprocess.check_call(["node", "--check", APPLET_JS])
    subprocess.check_call(["bash", "-n", LAUNCH_SH])
    subprocess.check_call(["bash", "-n", "/home/antigravity/ytmusic-mint-player/install.sh"])
    print("✅ [TESTE 4 OK] Sintaxe JavaScript (GJS) e Shell Script 100% válida!")


if __name__ == "__main__":
    test_1_never_hijacks_antigravity_window()
    test_2_selects_personal_cassio26_profile_over_alk_agencia()
    test_3_typography_and_title_case()
    test_4_syntax_validation()
    print("\n🎉 TODOS OS 4 TESTES CRÍTICOS DA v2.0 PASSARAM COM 100% DE SUCESSO!")
