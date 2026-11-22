# 🎵 YouTube Music Taskbar Player (Híbrido Vinil) — Linux Mint

Player para a barra de tarefas do **Linux Mint (Cinnamon)** projetado no formato **Híbrido**:

1. **Na Barra de Tarefas (Zona Esquerda — Estilo 1 Limpo):**
   - Zero poluição visual (sem texto de música ou cantor na barra).
   - Apenas o **ícone oficial do YouTube Music girando suavemente como um disco de vinil** enquanto a música toca + os 3 botões de ação rápida: **`⏮` (Voltar)**, **`⏯` (Play/Pause)** e **`⏭` (Avançar)**.
   - Suporte a **Scroll do mouse** diretamente sobre o player na barra para aumentar/diminuir o volume.

2. **Na Janelinha ao Passar o Mouse (`Hover` — Estilo 2 Dynamic Island):**
   - Abre automaticamente ao passar o mouse (`enter-event`) e permanece aberta enquanto você interage com ela.
   - **Capa do álbum em formato de disco de vinil girando** a 60 FPS sincronizada com o ícone da barra.
   - **Glow radial dinâmico**: extrai a cor predominante da capa do álbum em tempo real e ilumina a borda, o botão de Play e a barra de progresso.
   - Exibe **Nome da Música**, **Cantor**, **Álbum**, **Barra de Progresso Clicável (`Seek`)** e botão rápido para focar/abrir o YouTube Music.

---

## 🚀 Instalação Rápida no seu Linux Mint (1 Comando)

No terminal do seu Linux Mint, dentro da pasta `ytmusic-mint-player`, execute:

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

O script `install.sh` faz tudo sozinho:
1. Copia o applet `ytmusic-player@antigravity` para `~/.local/share/cinnamon/applets/`.
2. Registra o applet automaticamente na **Zona Esquerda (`panel1:left:0`)** da sua barra de tarefas via `gsettings`.
3. Recarrega os applets do Cinnamon via D-Bus sem fechar suas janelas.

---

## 🎧 Compatibilidade Automática (MPRIS2 D-Bus)

Funciona automaticamente com:
- **YouTube Music no Chrome / Brave / Chromium / Edge / Firefox** (qualquer aba aberta em `music.youtube.com`).
- **WebApp do Linux Mint** criado pelo *Gerenciador de Aplicativos Web (`webapp-manager`)*.
- **Pear Desktop (`th-ch/youtube-music`)** (basta deixar o plugin *Desktop Media Controls / MPRIS* ativo).

---

## 🖥️ Modo Alternativo Standalone (GTK3 + Cairo Dock)

Caso você também queira rodar o player como um processo Python independente (ou testar fora do Cinnamon, como no XFCE/MATE):

```bash
python3 standalone-gtk-dock/ytmusic_dock.py
```
