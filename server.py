"""
Sonar Edge Controller — Flask Backend
Discovers SteelSeries Sonar's dynamic port, proxies API calls (no CORS),
serves frontend, and provides Windows audio session/level data via pycaw.
"""

import json
import os
import threading
import time

import requests
import urllib3
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

# Suppress InsecureRequestWarning for self-signed TLS certs
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ---------------------------------------------------------------------------
# pycaw imports (Windows audio API)
# ---------------------------------------------------------------------------

try:
    import pythoncom
    from pycaw.pycaw import (
        AudioUtilities, IAudioMeterInformation,
        IAudioSessionManager2, IAudioSessionControl2,
        IMMDeviceEnumerator,
    )
    from pycaw.constants import CLSID_MMDeviceEnumerator
    from ctypes import cast, POINTER
    from comtypes import CLSCTX_ALL
    import comtypes
    import psutil
    PYCAW_AVAILABLE = True
except ImportError:
    PYCAW_AVAILABLE = False

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GG_CORE_PROPS = r"C:\ProgramData\SteelSeries\GG\coreProps.json"
FLASK_PORT = 5199

# Friendly name → Sonar internal channel name
CHANNELS = {
    "game": "game",
    "chat": "chatRender",
    "mic": "chatCapture",
    "media": "media",
}

# Global state — set by discovery thread
SONAR_BASE_URL = None
sonar_connected = False

# Track which config ID is active per channel (in-memory, lost on restart)
active_config_ids = {}

# Background audio session cache — pycaw runs in its own thread to avoid
# blocking Flask and hammering COM on every request
_audio_cache = {"sessions": [], "timestamp": 0}
_AUDIO_POLL_INTERVAL = 0.25  # seconds between pycaw polls (fast, but only hits Sonar devices)

# Cache for /configs/selected (avoid hitting Sonar API on every EQ poll)
_selected_cache = {"data": None, "timestamp": 0}
_SELECTED_CACHE_MS = 3000  # 3 second cache

# ---------------------------------------------------------------------------
# Port Discovery
# ---------------------------------------------------------------------------


def discover_sonar() -> str:
    """Read GG's coreProps, hit the subApps endpoint, return Sonar's web address."""
    with open(GG_CORE_PROPS, "r") as f:
        core = json.load(f)

    gg_address = core["ggEncryptedAddress"]
    resp = requests.get(f"https://{gg_address}/subApps", verify=False, timeout=5)
    resp.raise_for_status()

    sub_apps = resp.json()
    return sub_apps["subApps"]["sonar"]["metadata"]["webServerAddress"]


def discovery_loop():
    """Background thread: retry discovery every 10 s until Sonar is found."""
    global SONAR_BASE_URL, sonar_connected

    print("Looking for SteelSeries GG...")
    while True:
        try:
            url = discover_sonar()
            SONAR_BASE_URL = url
            sonar_connected = True
            print(f"Found Sonar at: {url}")
            return
        except Exception:
            time.sleep(10)


# ---------------------------------------------------------------------------
# Sonar HTTP helpers
# ---------------------------------------------------------------------------


def sonar_get(path: str):
    """GET from Sonar, return (json_data, status_code) or raise."""
    resp = requests.get(f"{SONAR_BASE_URL}/{path}", verify=False, timeout=5)
    if resp.content:
        return resp.json(), resp.status_code
    return None, resp.status_code


def sonar_put(path: str, body=None):
    """PUT to Sonar, return (json_data, status_code) or raise."""
    kwargs = {"verify": False, "timeout": 5}
    if body is not None:
        kwargs["json"] = body
    resp = requests.put(f"{SONAR_BASE_URL}/{path}", **kwargs)
    if resp.content:
        return resp.json(), resp.status_code
    return None, resp.status_code


def require_sonar():
    """Return an error response if Sonar is not connected."""
    if not sonar_connected:
        return jsonify({"error": "Sonar unreachable"}), 503
    return None


def resolve_channel(friendly: str):
    """Return (sonar_name, None) or (None, error_response)."""
    sonar_name = CHANNELS.get(friendly)
    if sonar_name is None:
        return None, (jsonify({"error": f"Unknown channel: {friendly}"}), 400)
    return sonar_name, None


# ---------------------------------------------------------------------------
# pycaw helpers (Windows audio sessions + peak meters)
# ---------------------------------------------------------------------------


# Sonar virtual device name keywords → our channel name
SONAR_DEVICE_CHANNEL = {
    "sonar - gaming": "game",
    "sonar - chat": "chat",
    "sonar - media": "media",
    "sonar - microphone": "mic",
    "sonar - aux": "aux",
}


def _audio_poll_loop():
    """Background thread: poll pycaw for audio sessions + peak levels.

    Only enumerates SONAR virtual devices (5 devices) instead of all
    system devices (17+). Runs in its own thread with persistent COM context.
    """
    pythoncom.CoInitialize()

    # Build device ID → channel map and cache the Sonar device IDs
    sonar_device_ids = {}  # device_id → channel
    try:
        devices = AudioUtilities.GetAllDevices()
        for d in devices:
            name_lower = d.FriendlyName.lower()
            for key, ch in SONAR_DEVICE_CHANNEL.items():
                if key in name_lower:
                    sonar_device_ids[d.id] = ch
                    break
    except Exception:
        pass

    print(f"Audio monitor: tracking {len(sonar_device_ids)} Sonar devices")

    # Cache process names to avoid psutil lookups every cycle
    pid_name_cache = {}

    while True:
        sessions = []
        try:
            enumerator = comtypes.CoCreateInstance(
                CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, CLSCTX_ALL
            )
            endpoints = enumerator.EnumAudioEndpoints(0, 1)
            count = endpoints.GetCount()

            for i in range(count):
                dev = endpoints.Item(i)
                dev_id = dev.GetId()

                # SKIP non-Sonar devices entirely — this is the key optimization
                channel = sonar_device_ids.get(dev_id)
                if channel is None:
                    continue

                try:
                    mgr_ptr = dev.Activate(
                        IAudioSessionManager2._iid_, CLSCTX_ALL, None
                    )
                    mgr = mgr_ptr.QueryInterface(IAudioSessionManager2)
                    sess_enum = mgr.GetSessionEnumerator()

                    for j in range(sess_enum.GetCount()):
                        ctl = sess_enum.GetSession(j)
                        try:
                            ctl2 = ctl.QueryInterface(IAudioSessionControl2)
                            pid = ctl2.GetProcessId()
                            if pid <= 0:
                                continue

                            # Cache process name lookups
                            if pid not in pid_name_cache:
                                try:
                                    pid_name_cache[pid] = psutil.Process(pid).name()
                                except Exception:
                                    pid_name_cache[pid] = f"pid-{pid}"

                            peak = 0.0
                            try:
                                meter = ctl.QueryInterface(IAudioMeterInformation)
                                peak = meter.GetPeakValue()
                            except Exception:
                                pass

                            sessions.append({
                                "pid": pid,
                                "name": pid_name_cache[pid],
                                "peak": round(peak, 4),
                                "channel": channel,
                            })
                        except Exception:
                            pass
                except Exception:
                    pass

        except Exception:
            pass

        _audio_cache["sessions"] = sessions
        _audio_cache["timestamp"] = time.time()

        time.sleep(_AUDIO_POLL_INTERVAL)


def _get_selected_configs_cached():
    """Get /configs/selected with a short cache to avoid hammering Sonar."""
    now = time.time() * 1000
    if _selected_cache["data"] is not None and now - _selected_cache["timestamp"] < _SELECTED_CACHE_MS:
        return _selected_cache["data"]
    try:
        data, _ = sonar_get("configs/selected")
        _selected_cache["data"] = data
        _selected_cache["timestamp"] = now
        return data
    except Exception:
        return _selected_cache["data"]


# ---------------------------------------------------------------------------
# Flask App
# ---------------------------------------------------------------------------

app = Flask(__name__, static_folder=".")
CORS(app)

# --- Frontend serving -------------------------------------------------------


@app.route("/")
def serve_index():
    return send_from_directory(".", "index.html")


@app.route("/static/<path:filename>")
def serve_static(filename):
    return send_from_directory(".", filename)


# --- Status -----------------------------------------------------------------


@app.route("/api/status")
def status():
    return jsonify({
        "running": sonar_connected,
        "sonar_url": SONAR_BASE_URL or "",
    })


# --- Volumes (Classic Mode) ------------------------------------------------


@app.route("/api/volumes")
def get_volumes():
    err = require_sonar()
    if err:
        return err
    try:
        data, code = sonar_get("volumeSettings/classic")
        devices = data.get("devices", {})
        result = {}
        for sonar_name, info in devices.items():
            classic = info.get("classic", {})
            result[sonar_name] = {
                "volume": classic.get("volume", 0),
                "muted": classic.get("muted", False),
            }
        masters = data.get("masters", {}).get("classic", {})
        result["master"] = {
            "volume": masters.get("volume", 0),
            "muted": masters.get("muted", False),
        }
        return jsonify(result)
    except Exception:
        return jsonify({"error": "Sonar unreachable"}), 503


@app.route("/api/volumes/<channel>", methods=["PUT"])
def set_volume(channel):
    err = require_sonar()
    if err:
        return err
    sonar_name, ch_err = resolve_channel(channel)
    if ch_err:
        return ch_err
    try:
        body = request.get_json(force=True)
        volume = body.get("volume", 0)
        _, code = sonar_put(f"volumeSettings/classic/{sonar_name}/volume/{volume}")
        return jsonify({"ok": True, "volume": volume}), code
    except Exception:
        return jsonify({"error": "Sonar unreachable"}), 503


# --- Mute -------------------------------------------------------------------


@app.route("/api/mute/<channel>", methods=["PUT"])
def set_mute(channel):
    err = require_sonar()
    if err:
        return err
    sonar_name, ch_err = resolve_channel(channel)
    if ch_err:
        return ch_err
    try:
        body = request.get_json(force=True)
        muted = str(body.get("muted", False)).lower()
        _, code = sonar_put(f"volumeSettings/classic/{sonar_name}/mute/{muted}")
        return jsonify({"ok": True, "muted": muted}), code
    except Exception:
        return jsonify({"error": "Sonar unreachable"}), 503


# --- EQ Presets -------------------------------------------------------------


@app.route("/api/presets/<channel>")
def get_presets(channel):
    err = require_sonar()
    if err:
        return err
    sonar_name, ch_err = resolve_channel(channel)
    if ch_err:
        return ch_err
    try:
        all_configs, _ = sonar_get("configs")

        # Get the REAL selected config from Sonar (not our in-memory tracking)
        selected_configs = _get_selected_configs_cached()
        selected_id = None
        if selected_configs:
            for sc in selected_configs:
                if sc.get("virtualAudioDevice") == sonar_name:
                    selected_id = sc.get("id")
                    break

        channel_configs = []
        for c in all_configs:
            if c.get("virtualAudioDevice") == sonar_name:
                channel_configs.append({
                    "id": c["id"],
                    "name": c["name"],
                    "isPreset": c.get("isPreset", False),
                    "isFavorite": c.get("isFavorite", False),
                    "image": c.get("image", ""),
                    "isActive": c["id"] == selected_id,
                    "virtualSurroundState": c.get("data", {}).get("virtualSurroundState", False),
                })
        return jsonify(channel_configs)
    except Exception:
        return jsonify({"error": "Sonar unreachable"}), 503


@app.route("/api/presets/<channel>", methods=["PUT"])
def set_preset(channel):
    """Activate a preset using PUT /configs/{id}/select."""
    err = require_sonar()
    if err:
        return err
    sonar_name, ch_err = resolve_channel(channel)
    if ch_err:
        return ch_err
    try:
        body = request.get_json(force=True)
        config_id = body.get("configId", "")

        # Select the preset — PUT /configs/{id}/select is the real activation endpoint
        result, code = sonar_put(f"configs/{config_id}/select")

        if code == 200:
            active_config_ids[sonar_name] = config_id
            # Invalidate selected cache so next read gets fresh state
            _selected_cache["timestamp"] = 0

        return jsonify(result or {"ok": True}), code
    except Exception:
        return jsonify({"error": "Sonar unreachable"}), 503


# --- Active Config Tracking -------------------------------------------------


@app.route("/api/active-config/<channel>")
def get_active_config(channel):
    """Get the currently selected preset from Sonar's real state."""
    err = require_sonar()
    if err:
        return err
    sonar_name, ch_err = resolve_channel(channel)
    if ch_err:
        return ch_err
    try:
        selected_configs = _get_selected_configs_cached()
        if selected_configs:
            for sc in selected_configs:
                if sc.get("virtualAudioDevice") == sonar_name:
                    return jsonify({
                        "configId": sc.get("id"),
                        "presetName": sc.get("name", "Custom"),
                    })
        return jsonify({"configId": None, "presetName": "Custom"})
    except Exception:
        return jsonify({"configId": None, "presetName": "Custom"})


# --- Spatial Audio ----------------------------------------------------------


@app.route("/api/spatial/<channel>")
def get_spatial(channel):
    err = require_sonar()
    if err:
        return err
    sonar_name, ch_err = resolve_channel(channel)
    if ch_err:
        return ch_err
    try:
        # Use /configs/selected to get the real active config
        selected_configs = _get_selected_configs_cached()
        if selected_configs:
            for sc in selected_configs:
                if sc.get("virtualAudioDevice") == sonar_name:
                    vs = sc.get("data", {}).get("virtualSurroundState", False)
                    return jsonify({"enabled": vs, "configId": sc["id"]})
        return jsonify({"enabled": False})
    except Exception:
        return jsonify({"error": "Sonar unreachable"}), 503


@app.route("/api/spatial/<channel>", methods=["PUT"])
def set_spatial(channel):
    err = require_sonar()
    if err:
        return err
    sonar_name, ch_err = resolve_channel(channel)
    if ch_err:
        return ch_err
    try:
        body = request.get_json(force=True)
        enabled = body.get("enabled", False)

        # Get the currently selected config for this channel
        selected_configs = _get_selected_configs_cached()
        if selected_configs:
            for sc in selected_configs:
                if sc.get("virtualAudioDevice") == sonar_name:
                    sc["data"]["virtualSurroundState"] = enabled
                    result, code = sonar_put("configs", sc)
                    return jsonify(result or {"ok": True}), code

        return jsonify({"error": "No config found for channel"}), 404
    except Exception:
        return jsonify({"error": "Sonar unreachable"}), 503


# --- Audio Sessions (pycaw) ------------------------------------------------


@app.route("/api/sessions")
def get_sessions():
    """Return cached audio sessions from background pycaw thread."""
    return jsonify(_audio_cache["sessions"])


# --- Audio Levels (same cache as sessions, just a separate endpoint) -------


@app.route("/api/levels")
def get_levels():
    """Return cached peak levels from background pycaw thread."""
    return jsonify(_audio_cache["sessions"])


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Sonar Edge Controller starting...")

    if not PYCAW_AVAILABLE:
        print("WARNING: pycaw not installed — audio sessions/levels disabled")
        print("  Install with: pip install pycaw comtypes")
    else:
        # Start background pycaw polling thread (single COM context, no per-request overhead)
        threading.Thread(target=_audio_poll_loop, daemon=True).start()

    # Run discovery in a background thread so the server starts immediately
    threading.Thread(target=discovery_loop, daemon=True).start()

    print(f"Server running at http://localhost:{FLASK_PORT}")
    app.run(host="127.0.0.1", port=FLASK_PORT, debug=False)
