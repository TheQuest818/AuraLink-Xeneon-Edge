# AuraLink — Xeneon Edge Audio Controller

A touchscreen audio controller for the **Corsair Xeneon Edge** (2560x720) that gives you hands-on control of **SteelSeries Sonar** channels — volume sliders, mute buttons, EQ presets, and spatial audio — all from the edge display.

Built with Python (pywebview) and runs as a standalone `.exe` with no browser required.

![AuraLink Screenshot](https://via.placeholder.com/800x225?text=AuraLink+Screenshot)

## Requirements

> **SteelSeries GG with Sonar is required.** AuraLink controls your audio through Sonar's API. Without SteelSeries Sonar running, the app has nothing to connect to.

- **Windows 10/11**
- **SteelSeries GG** with **Sonar** enabled and running
- **Corsair Xeneon Edge** touchscreen display (2560x720)

## Download

Head to the [**Releases**](../../releases) page and download the latest `AuraLink-v1.0.zip`.

1. Extract the zip
2. Run `AuraLink.exe`
3. The app auto-detects your Xeneon Edge and opens fullscreen on it

## Features

- **4 Channel Sliders** — Game, Chat, Mic, Media with real-time volume control
- **Live Audio Level Bars** — Animated per-channel audio visualization
- **EQ Preset Browser** — Browse and switch Sonar EQ presets per channel
- **Spatial Audio Toggle** — Enable/disable virtual surround per channel
- **Session Display** — See which apps are playing on each channel
- **Per-Channel Colors** — Tap a channel label to pick from 8 accent colors
- **Custom Background Image** — Tap the BG button to set a custom wallpaper behind the sliders
- **Font Picker** — Choose from 12 fonts for headers, mute buttons, and panel text
- **Channel Reorder** — Long-press a channel label, then tap another to swap positions
- **All settings persist** across restarts (colors, fonts, order, background)

## Build from Source

### Prerequisites

- [Python 3.10+](https://www.python.org/downloads/)
- pip (comes with Python)

### Steps

```bash
# Clone the repo
git clone https://github.com/TheQuest818/AuraLink-Xeneon-Edge.git
cd AuraLink-Xeneon-Edge

# Install dependencies
pip install -r requirements.txt

# Build the exe
pyinstaller --name "AuraLink" --onedir --noconsole --icon=auralink.ico --add-data "index.html;." --add-data "app.js;." --add-data "style.css;." --collect-all webview --hidden-import comtypes.stream --hidden-import comtypes._comobject --hidden-import pycaw.pycaw --clean --noconfirm main.py

# The built app is in dist/AuraLink/
```

### Run without building

```bash
python main.py
```

## How It Works

AuraLink discovers SteelSeries GG via `coreProps.json`, connects to Sonar's local API, and controls volume/mute/EQ/spatial settings through HTTP calls. Audio levels are monitored via Windows Core Audio (pycaw). The UI runs in a native pywebview window — no browser involved.

## License

MIT
