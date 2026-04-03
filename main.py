"""
AuraLink Controller — Standalone Desktop App (pywebview)
Replaces Flask+browser with a native window using pywebview's JS API bridge.
All Python methods are called directly from JavaScript — no HTTP overhead.
"""

import json
import os
import sys
import threading
import time

import requests
import urllib3
import webview

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

# Friendly name → Sonar internal channel name
CHANNELS = {
    "game": "game",
    "chat": "chatRender",
    "mic": "chatCapture",
    "media": "media",
}

# Sonar virtual device name keywords → our channel name
SONAR_DEVICE_CHANNEL = {
    "sonar - gaming": "game",
    "sonar - chat": "chat",
    "sonar - media": "media",
    "sonar - microphone": "mic",
    "sonar - aux": "aux",
}

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

_sonar_base_url = None
_sonar_connected = False
_active_config_ids = {}

# Background audio session cache
_audio_cache = {"sessions": [], "timestamp": 0}
_AUDIO_POLL_INTERVAL = 0.25

# Cache for /configs/selected
_selected_cache = {"data": None, "timestamp": 0}
_SELECTED_CACHE_MS = 3000

# ---------------------------------------------------------------------------
# Port Discovery
# ---------------------------------------------------------------------------


def discover_sonar() -> str:
    with open(GG_CORE_PROPS, "r") as f:
        core = json.load(f)
    gg_address = core["ggEncryptedAddress"]
    resp = requests.get(f"https://{gg_address}/subApps", verify=False, timeout=5)
    resp.raise_for_status()
    sub_apps = resp.json()
    return sub_apps["subApps"]["sonar"]["metadata"]["webServerAddress"]


def discovery_loop():
    global _sonar_base_url, _sonar_connected
    print("Looking for SteelSeries GG...")
    while True:
        try:
            url = discover_sonar()
            _sonar_base_url = url
            _sonar_connected = True
            print(f"Found Sonar at: {url}")
            return
        except Exception:
            time.sleep(10)


# ---------------------------------------------------------------------------
# Sonar HTTP helpers
# ---------------------------------------------------------------------------


def sonar_get(path: str):
    resp = requests.get(f"{_sonar_base_url}/{path}", verify=False, timeout=5)
    if resp.content:
        return resp.json(), resp.status_code
    return None, resp.status_code


def sonar_put(path: str, body=None):
    kwargs = {"verify": False, "timeout": 5}
    if body is not None:
        kwargs["json"] = body
    resp = requests.put(f"{_sonar_base_url}/{path}", **kwargs)
    if resp.content:
        return resp.json(), resp.status_code
    return None, resp.status_code


def _get_selected_configs_cached():
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
# pycaw background thread
# ---------------------------------------------------------------------------


def _audio_poll_loop():
    pythoncom.CoInitialize()

    sonar_device_ids = {}
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


# ---------------------------------------------------------------------------
# pywebview JS API — exposed to window.pywebview.api.*
# ---------------------------------------------------------------------------


class SonarAPI:
    """Every public method is callable from JavaScript as:
       await window.pywebview.api.method_name(args)
    pywebview auto-serializes return values to JSON."""

    def __init__(self):
        self._window = None

    def set_window(self, window):
        self._window = window

    def get_status(self):
        return {
            "running": _sonar_connected,
            "sonar_url": _sonar_base_url or "",
        }

    def get_volumes(self):
        if not _sonar_connected:
            return {"error": "Sonar unreachable"}
        try:
            data, _ = sonar_get("volumeSettings/classic")
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
            return result
        except Exception:
            return {"error": "Sonar unreachable"}

    def set_volume(self, channel, volume):
        if not _sonar_connected:
            return {"error": "Sonar unreachable"}
        sonar_name = CHANNELS.get(channel)
        if not sonar_name:
            return {"error": f"Unknown channel: {channel}"}
        try:
            _, code = sonar_put(f"volumeSettings/classic/{sonar_name}/volume/{volume}")
            return {"ok": True, "volume": volume}
        except Exception:
            return {"error": "Sonar unreachable"}

    def set_mute(self, channel, muted):
        if not _sonar_connected:
            return {"error": "Sonar unreachable"}
        sonar_name = CHANNELS.get(channel)
        if not sonar_name:
            return {"error": f"Unknown channel: {channel}"}
        try:
            muted_str = str(muted).lower()
            _, code = sonar_put(f"volumeSettings/classic/{sonar_name}/mute/{muted_str}")
            return {"ok": True, "muted": muted}
        except Exception:
            return {"error": "Sonar unreachable"}

    def get_presets(self, channel):
        if not _sonar_connected:
            return {"error": "Sonar unreachable"}
        sonar_name = CHANNELS.get(channel)
        if not sonar_name:
            return {"error": f"Unknown channel: {channel}"}
        try:
            all_configs, _ = sonar_get("configs")
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
            return channel_configs
        except Exception:
            return {"error": "Sonar unreachable"}

    def set_preset(self, channel, config_id):
        if not _sonar_connected:
            return {"error": "Sonar unreachable"}
        sonar_name = CHANNELS.get(channel)
        if not sonar_name:
            return {"error": f"Unknown channel: {channel}"}
        try:
            result, code = sonar_put(f"configs/{config_id}/select")
            if code == 200:
                _active_config_ids[sonar_name] = config_id
                _selected_cache["timestamp"] = 0
            return result or {"ok": True}
        except Exception:
            return {"error": "Sonar unreachable"}

    def get_active_config(self, channel):
        if not _sonar_connected:
            return {"configId": None, "presetName": "Custom"}
        sonar_name = CHANNELS.get(channel)
        if not sonar_name:
            return {"configId": None, "presetName": "Custom"}
        try:
            selected_configs = _get_selected_configs_cached()
            if selected_configs:
                for sc in selected_configs:
                    if sc.get("virtualAudioDevice") == sonar_name:
                        return {
                            "configId": sc.get("id"),
                            "presetName": sc.get("name", "Custom"),
                        }
            return {"configId": None, "presetName": "Custom"}
        except Exception:
            return {"configId": None, "presetName": "Custom"}

    def get_spatial(self, channel):
        if not _sonar_connected:
            return {"error": "Sonar unreachable"}
        sonar_name = CHANNELS.get(channel)
        if not sonar_name:
            return {"error": f"Unknown channel: {channel}"}
        try:
            selected_configs = _get_selected_configs_cached()
            if selected_configs:
                for sc in selected_configs:
                    if sc.get("virtualAudioDevice") == sonar_name:
                        vs = sc.get("data", {}).get("virtualSurroundState", False)
                        return {"enabled": vs, "configId": sc["id"]}
            return {"enabled": False}
        except Exception:
            return {"error": "Sonar unreachable"}

    def set_spatial(self, channel, enabled):
        if not _sonar_connected:
            return {"error": "Sonar unreachable"}
        sonar_name = CHANNELS.get(channel)
        if not sonar_name:
            return {"error": f"Unknown channel: {channel}"}
        try:
            selected_configs = _get_selected_configs_cached()
            if selected_configs:
                for sc in selected_configs:
                    if sc.get("virtualAudioDevice") == sonar_name:
                        sc["data"]["virtualSurroundState"] = enabled
                        result, code = sonar_put("configs", sc)
                        return result or {"ok": True}
            return {"error": "No config found for channel"}
        except Exception:
            return {"error": "Sonar unreachable"}

    def get_sessions(self):
        return _audio_cache["sessions"]

    def get_levels(self):
        return _audio_cache["sessions"]

    def pick_bg_image(self):
        """Open native file picker for a background image, return base64 data URL."""
        if not self._window:
            return {"error": "No window"}
        try:
            import base64
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=('Image Files (*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp)',),
            )
            if not result or len(result) == 0:
                return {"cancelled": True}

            file_path = result[0]
            ext = os.path.splitext(file_path)[1].lower()
            mime_map = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.bmp': 'image/bmp', '.gif': 'image/gif', '.webp': 'image/webp',
            }
            mime = mime_map.get(ext, 'image/png')

            with open(file_path, 'rb') as f:
                data = f.read()

            data_url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
            return {"dataUrl": data_url}
        except Exception as e:
            return {"error": str(e)}

    def close_app(self):
        """Shut down the app cleanly."""
        os._exit(0)


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import ctypes
    from ctypes import wintypes

    # Do NOT call SetProcessDPIAware — pywebview and Win32 both work in
    # virtualized (logical) coordinates by default. With 150% scaling the
    # Xeneon Edge appears as 2560x720 at (614,-720) in logical space.
    # Calling SetProcessDPIAware would shift to physical pixels (3840x1080
    # at (921,-1080)) which breaks pywebview's coordinate system.

    # Debug log — noconsole eats stdout so write to file
    _log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sonar_debug.log")
    if getattr(sys, "frozen", False):
        _log_path = os.path.join(os.path.dirname(sys.executable), "sonar_debug.log")

    def _log(msg):
        with open(_log_path, "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")

    _log("=== AuraLink Controller starting ===")

    if not PYCAW_AVAILABLE:
        _log("WARNING: pycaw not installed")
    else:
        threading.Thread(target=_audio_poll_loop, daemon=True).start()

    threading.Thread(target=discovery_loop, daemon=True).start()

    api = SonarAPI()

    if getattr(sys, "frozen", False):
        base_dir = sys._MEIPASS
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
    html_path = os.path.join(base_dir, "index.html")

    # ---------------------------------------------------------------------------
    # Find the Xeneon Edge (2560x720 logical) — use rcMonitor for FULL bounds
    # ---------------------------------------------------------------------------
    edge_x, edge_y, edge_w, edge_h = 0, 0, 2560, 720
    edge_found = False

    monitors = []
    def _monitor_cb(hMon, hdcMon, lprcMon, dwData):
        r = lprcMon[0]
        monitors.append((r.left, r.top, r.right - r.left, r.bottom - r.top))
        return True

    _MonEnumProc = ctypes.WINFUNCTYPE(
        ctypes.c_int, ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(wintypes.RECT),
        ctypes.c_double,
    )
    ctypes.windll.user32.EnumDisplayMonitors(
        None, None, _MonEnumProc(_monitor_cb), 0
    )
    _log(f"Monitors found: {monitors}")

    for x, y, w, h in monitors:
        if w == 2560 and h == 720:
            edge_x, edge_y, edge_w, edge_h = x, y, w, h
            edge_found = True
            _log(f"Xeneon Edge matched at ({x},{y}) {w}x{h}")
            break

    if not edge_found:
        # Fallback: pick the widest monitor that isn't the tallest (likely the bar)
        by_aspect = sorted(monitors, key=lambda m: m[2]/m[3], reverse=True)
        if by_aspect:
            edge_x, edge_y, edge_w, edge_h = by_aspect[0]
            _log(f"Xeneon Edge fallback (widest aspect): ({edge_x},{edge_y}) {edge_w}x{edge_h}")

    # ---------------------------------------------------------------------------
    # Cursor guard
    # ---------------------------------------------------------------------------
    def _cursor_guard():
        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        get_pos = ctypes.windll.user32.GetCursorPos
        set_pos = ctypes.windll.user32.SetCursorPos
        last_safe = POINT(0, 0)
        get_pos(ctypes.byref(last_safe))

        while True:
            pos = POINT(0, 0)
            get_pos(ctypes.byref(pos))
            on_edge = (edge_x <= pos.x < edge_x + edge_w and
                       edge_y <= pos.y < edge_y + edge_h)
            if on_edge:
                set_pos(last_safe.x, last_safe.y)
            else:
                last_safe.x = pos.x
                last_safe.y = pos.y
            time.sleep(0.016)

    threading.Thread(target=_cursor_guard, daemon=True).start()

    # ---------------------------------------------------------------------------
    # After window opens: log viewport info for debugging
    # ---------------------------------------------------------------------------
    def _on_started():
        try:
            time.sleep(1)
            result = window.evaluate_js(
                "JSON.stringify({iw: window.innerWidth, ih: window.innerHeight, "
                "ow: window.outerWidth, oh: window.outerHeight, "
                "sw: screen.width, sh: screen.height, "
                "dpr: window.devicePixelRatio})"
            )
            _log(f"Viewport info: {result}")
        except Exception as e:
            _log(f"evaluate_js error: {e}")

    # ---------------------------------------------------------------------------
    # Create window on the Xeneon Edge — fullscreen=True at creation
    # ---------------------------------------------------------------------------
    window = webview.create_window(
        "AuraLink",
        html_path,
        x=edge_x,
        y=edge_y,
        width=edge_w,
        height=edge_h,
        fullscreen=True,
        easy_drag=False,
        js_api=api,
    )
    api.set_window(window)

    # Persistent storage for localStorage (colors, channel order, fonts, etc.)
    if getattr(sys, "frozen", False):
        storage = os.path.join(os.path.dirname(sys.executable), "webview_data")
    else:
        storage = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webview_data")
    os.makedirs(storage, exist_ok=True)
    _log(f"Storage path: {storage}")

    webview.start(
        func=_on_started,
        storage_path=storage,
        private_mode=False,   # CRITICAL: default True wipes localStorage each launch
        http_port=39821,      # Fixed port so HTTP origin stays the same across restarts
        debug=False,
    )
