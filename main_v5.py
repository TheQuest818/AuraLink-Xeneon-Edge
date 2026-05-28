"""
AuraLink Controller — Standalone Desktop App (pywebview)
Replaces Flask+browser with a native window using pywebview's JS API bridge.
All Python methods are called directly from JavaScript — no HTTP overhead.
"""

import ctypes
import ctypes.wintypes
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

# Module-level debug logger — writes to sonar_debug.log. Defined here so the
# audio polling thread can use it (the _log() defined inside main() is a closure
# and isn't visible from this scope).
def _debug_log(msg):
    try:
        if getattr(sys, "frozen", False):
            log_path = os.path.join(os.path.dirname(sys.executable), "sonar_debug.log")
        else:
            log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sonar_debug.log")
        with open(log_path, "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except Exception:
        pass

# Cache for /configs/selected
_selected_cache = {"data": None, "timestamp": 0}
_SELECTED_CACHE_MS = 3000

# Cursor parking state — populated by the tracker thread, read by restore_cursor.
# Holds the last cursor position observed OUTSIDE the Xeneon Edge so we can snap
# back there after a touch on AuraLink ends.
_cursor_state = {"safe_x": None, "safe_y": None}
_cursor_lock = threading.Lock()


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
    _debug_log(f"Audio monitor: tracking {len(sonar_device_ids)} Sonar devices (ids: {list(sonar_device_ids.values())})")

    pid_name_cache = {}
    _prev_game_names = None  # track last seen game-channel process set

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

        # --- Diagnostic logging for pause-on-game feature ---------------------
        # Log only when the set of processes on game channel changes — gives us
        # a signal for any future weirdness without flooding the log.
        try:
            game_names_only = sorted({s["name"] for s in sessions if s["channel"] == "game"})
            if _prev_game_names is None or game_names_only != _prev_game_names:
                game_now = sorted({(s["name"], round(s["peak"], 3)) for s in sessions if s["channel"] == "game"})
                _debug_log(f"GAME-CH change: {game_now}")
                _prev_game_names = game_names_only
        except Exception as _e:
            _debug_log(f"GAME-CH log error: {_e}")

        time.sleep(_AUDIO_POLL_INTERVAL)


# ---------------------------------------------------------------------------
# Discord RPC — persistent connection for instant voice control
# ---------------------------------------------------------------------------

import asyncio
import struct
import uuid

_discord_client = None
_discord_loop = None
_discord_ready = False
_discord_lock = threading.Lock()


def _discord_config_path():
    if getattr(sys, "frozen", False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "discord_config.json")


def _discord_load_config():
    """Load Discord OAuth credentials from discord_config.json.
    Returns dict with client_id + client_secret, or None if missing/invalid.
    This file is gitignored — never commit it. See discord_config.example.json."""
    try:
        with open(_discord_config_path(), "r") as f:
            cfg = json.load(f)
        if cfg.get("client_id") and cfg.get("client_secret"):
            return cfg
    except Exception:
        pass
    return None


def _get_discord_token_path():
    if getattr(sys, "frozen", False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "discord_rpc_token.json")


def _load_discord_token():
    try:
        path = _get_discord_token_path()
        if os.path.exists(path):
            with open(path, "r") as f:
                return json.load(f).get("access_token")
    except Exception:
        pass
    return None


def _save_discord_token(access_token):
    try:
        with open(_get_discord_token_path(), "w") as f:
            json.dump({"access_token": access_token}, f)
    except Exception:
        pass


def _discord_send(cmd, args=None):
    """Send an RPC command on the persistent connection."""
    nonce = str(uuid.uuid4())
    payload = json.dumps({"cmd": cmd, "args": args or {}, "nonce": nonce}).encode()
    header = struct.pack("<II", 1, len(payload))
    _discord_client.sock_writer.write(header + payload)
    return _discord_loop.run_until_complete(
        asyncio.wait_for(_discord_client.read_output(), timeout=5)
    )


def _discord_connect():
    """Connect and authenticate to Discord RPC. Called once at startup."""
    global _discord_client, _discord_loop, _discord_ready
    cfg = _discord_load_config()
    if not cfg:
        print("Discord RPC: discord_config.json missing or invalid — "
              "see discord_config.example.json")
        return
    from pypresence.baseclient import BaseClient

    _discord_loop = asyncio.new_event_loop()
    _discord_client = BaseClient(client_id=cfg["client_id"], loop=_discord_loop)
    _discord_loop.run_until_complete(_discord_client.handshake())

    # Try cached token
    token = _load_discord_token()
    if token:
        try:
            resp = _discord_send("AUTHENTICATE", {"access_token": token})
            if resp.get("evt") != "ERROR":
                _discord_ready = True
                print("Discord RPC: authenticated with cached token")
                return
        except Exception:
            pass
        # Token expired — reconnect pipe
        _discord_client = BaseClient(client_id=cfg["client_id"], loop=_discord_loop)
        _discord_loop.run_until_complete(_discord_client.handshake())

    # Full auth flow (first time or token expired)
    resp = _discord_send("AUTHORIZE", {
        "client_id": cfg["client_id"],
        "scopes": ["rpc", "rpc.voice.read", "rpc.voice.write"],
    })
    code = resp["data"]["code"]

    token_resp = requests.post("https://discord.com/api/oauth2/token", data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": "http://127.0.0.1",
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
    })
    access_token = token_resp.json()["access_token"]
    _save_discord_token(access_token)
    _discord_send("AUTHENTICATE", {"access_token": access_token})
    _discord_ready = True
    print("Discord RPC: authenticated (new token)")


def _discord_ensure_connected():
    """Ensure we have a live authenticated connection."""
    global _discord_ready
    if _discord_ready:
        # Quick check — try a lightweight command
        try:
            _discord_send("GET_VOICE_SETTINGS")
            return True
        except Exception:
            _discord_ready = False

    # Reconnect
    try:
        _discord_connect()
        return _discord_ready
    except Exception as e:
        print(f"Discord RPC reconnect failed: {e}")
        return False


def discord_toggle_mute():
    """Toggle Discord mute. Instant on persistent connection."""
    with _discord_lock:
        try:
            if not _discord_ensure_connected():
                return {"error": "Discord not connected"}
            voice = _discord_send("GET_VOICE_SETTINGS")
            is_muted = voice.get("data", {}).get("mute", False)
            _discord_send("SET_VOICE_SETTINGS", {"mute": not is_muted})
            return {"ok": True, "muted": not is_muted}
        except Exception as e:
            _discord_ready = False
            return {"error": str(e)}


def discord_toggle_deafen():
    """Toggle Discord deafen. Instant on persistent connection."""
    with _discord_lock:
        try:
            if not _discord_ensure_connected():
                return {"error": "Discord not connected"}
            voice = _discord_send("GET_VOICE_SETTINGS")
            is_deaf = voice.get("data", {}).get("deaf", False)
            _discord_send("SET_VOICE_SETTINGS", {"deaf": not is_deaf})
            return {"ok": True, "deafened": not is_deaf}
        except Exception as e:
            _discord_ready = False
            return {"error": str(e)}


def _discord_startup():
    """Background thread to establish Discord RPC on boot."""
    try:
        _discord_connect()
    except Exception as e:
        print(f"Discord RPC startup: {e} (will retry on first use)")


# ---------------------------------------------------------------------------
# Spotify — Now Playing widget data via Web API (spotipy)
# ---------------------------------------------------------------------------

_spotify_client = None
_spotify_lock = threading.Lock()
_spotify_cache = {"data": None, "timestamp": 0}
_SPOTIFY_CACHE_MS = 4800  # ~5s polling budget — much friendlier to dev-app quotas
_spotify_rate_limited_until = 0  # epoch seconds; set when Spotify returns 429


def _spotify_base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _spotify_config_path():
    return os.path.join(_spotify_base_dir(), "spotify_config.json")


def _spotify_token_path():
    return os.path.join(_spotify_base_dir(), "spotify_token_cache")


def _spotify_load_config():
    try:
        with open(_spotify_config_path(), "r") as f:
            cfg = json.load(f)
        if cfg.get("client_id") and cfg.get("client_secret"):
            return cfg
    except Exception:
        pass
    return None


def _spotify_connect():
    """Create the spotipy client. Triggers OAuth browser flow on first run."""
    global _spotify_client
    cfg = _spotify_load_config()
    if not cfg:
        print("Spotify: spotify_config.json missing or invalid")
        return None
    try:
        import spotipy
        from spotipy.oauth2 import SpotifyOAuth

        # `streaming` enables the Web Playback SDK (AuraLink as its own device).
        # `user-read-email` + `user-read-private` are required by the SDK.
        scope = (
            "user-read-currently-playing user-read-playback-state "
            "user-modify-playback-state streaming user-read-email user-read-private"
        )
        # If a cache from the old (smaller) scope exists, drop it so the user
        # is reprompted with the streaming scope this time.
        try:
            tok_path = _spotify_token_path()
            if os.path.exists(tok_path):
                with open(tok_path, "r") as _tf:
                    _cached = json.load(_tf)
                if "streaming" not in (_cached.get("scope") or ""):
                    os.remove(tok_path)
        except Exception:
            pass

        auth = SpotifyOAuth(
            client_id=cfg["client_id"],
            client_secret=cfg["client_secret"],
            redirect_uri=cfg.get("redirect_uri", "http://127.0.0.1:8888/callback"),
            scope=scope,
            cache_path=_spotify_token_path(),
            open_browser=True,
        )
        # retries=0 + status_retries=0 prevents spotipy from sleeping for huge
        # Retry-After durations on 429 (Spotify can return retry-afters of hours
        # for dev-app daily quota caps, which would freeze the whole UI).
        _spotify_client = spotipy.Spotify(
            auth_manager=auth, requests_timeout=5,
            retries=0, status_retries=0, backoff_factor=0,
        )
        # Trigger token fetch (OAuth flow on first run) WITHOUT making any API
        # call — if we're rate-limited an API call would null the client.
        try:
            auth.get_access_token(as_dict=True, check_cache=True)
            print("Spotify: authenticated")
        except Exception as _ae:
            print(f"Spotify token fetch warning: {_ae}")
        return _spotify_client
    except Exception as e:
        print(f"Spotify connect failed: {e}")
        _spotify_client = None
        return None


def _spotify_startup():
    """Background thread: connect on boot so OAuth happens early."""
    try:
        _spotify_connect()
    except Exception as e:
        print(f"Spotify startup: {e}")


def _spotify_now_playing():
    """Return a flat dict describing current playback for the frontend."""
    global _spotify_rate_limited_until
    if _spotify_client is None:
        if not _spotify_connect():
            return {"connected": False}

    # Honour previous 429 — back off entirely until the window passes
    now = time.time()
    if now < _spotify_rate_limited_until:
        return {
            "connected": False,
            "rate_limited": True,
            "retry_in_sec": int(_spotify_rate_limited_until - now),
        }

    try:
        data = _spotify_client.current_playback()
        if not data or not data.get("item"):
            return {"connected": True, "has_track": False, "is_playing": False}

        item = data["item"]
        album = item.get("album", {})
        images = album.get("images") or []
        # images are sorted largest first by Spotify
        art = images[0]["url"] if images else ""

        return {
            "connected": True,
            "has_track": True,
            "is_playing": bool(data.get("is_playing")),
            "title": item.get("name", ""),
            "artists": ", ".join(a.get("name", "") for a in item.get("artists", [])),
            "album": album.get("name", ""),
            "album_art": art,
            "progress_ms": int(data.get("progress_ms") or 0),
            "duration_ms": int(item.get("duration_ms") or 0),
            "shuffle": bool(data.get("shuffle_state")),
            "repeat": data.get("repeat_state", "off"),
            "device": (data.get("device") or {}).get("name", ""),
            "track_id": item.get("id", ""),
        }
    except Exception as e:
        # On 429, record a backoff window so we stop hammering the API
        msg = str(e)
        if "429" in msg or "rate" in msg.lower():
            try:
                import spotipy as _sp
                if isinstance(e, _sp.SpotifyException):
                    headers = getattr(e, "headers", {}) or {}
                    retry_after = int(headers.get("Retry-After") or headers.get("retry-after") or 60)
                else:
                    retry_after = 60
            except Exception:
                retry_after = 60
            # Cap to a sane ceiling so the UI isn't perma-broken
            retry_after = min(retry_after, 3600)
            _spotify_rate_limited_until = time.time() + retry_after
            return {"connected": False, "rate_limited": True, "retry_in_sec": retry_after}
        return {"connected": False, "error": msg}


# ---------------------------------------------------------------------------
# Local now-playing via GSMTC (GlobalSystemMediaTransportControls)
# ---------------------------------------------------------------------------
# When Spotify is running on this PC, GSMTC reads the local media session
# directly — no network round-trip, no API tokens, no 30s polling delay.
# The Web API polling (above) stays as fallback for true remote-device cases
# (e.g. playback on a phone). Updates pushed to JS via window._gsmtcUpdate.

try:
    import asyncio as _gsmtc_asyncio
    import base64 as _gsmtc_b64
    from datetime import datetime as _gsmtc_datetime, timezone as _gsmtc_tz
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as _GSMTCManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as _GSMTCStatus,
    )
    from winrt.windows.media import MediaPlaybackAutoRepeatMode as _GSMTCRepeatMode
    from winrt.windows.storage.streams import DataReader as _GSMTCDataReader
    GSMTC_AVAILABLE = True
except Exception:
    GSMTC_AVAILABLE = False

_gsmtc_cache = {
    "connected": False,
    "has_track": False,
    "is_playing": False,
    "title": "",
    "artists": "",
    "album": "",
    "album_art": "",
    "progress_ms": 0,
    "duration_ms": 0,
    "shuffle": False,
    "repeat": "off",
    "device": "Local",
    "track_id": "",
    "source": "",
}
_gsmtc_lock = threading.Lock()
_gsmtc_window_ref = None  # set in main() after window is created
_GSMTC_POLL_SEC = 0.5


def _gsmtc_set_window(window):
    """Called from main() after the pywebview window exists."""
    global _gsmtc_window_ref
    _gsmtc_window_ref = window


def _gsmtc_push_payload_locked():
    """Build a JSON-safe payload from the cache. Caller must hold the lock."""
    return {k: v for k, v in _gsmtc_cache.items() if not k.startswith("_")}


def _gsmtc_push_to_js(payload):
    """Call window._gsmtcUpdate(payload) via evaluate_js. Safe to call from
    background thread — pywebview marshals to the UI thread internally."""
    if _gsmtc_window_ref is None:
        return
    try:
        js = "window._gsmtcUpdate && window._gsmtcUpdate(" + json.dumps(payload) + ")"
        _gsmtc_window_ref.evaluate_js(js)
    except Exception as e:
        _debug_log(f"GSMTC: evaluate_js failed: {e}")


async def _gsmtc_extract_thumbnail_async(thumbnail_ref):
    """Extract MediaProperties.thumbnail as a base64 data URL. '' on failure."""
    if thumbnail_ref is None:
        return ""
    try:
        stream = await thumbnail_ref.open_read_async()
        size = stream.size
        if not size:
            return ""
        reader = _GSMTCDataReader(stream)
        await reader.load_async(int(size))
        buf = bytearray(int(size))
        reader.read_bytes(buf)
        mime = stream.content_type or "image/jpeg"
        return f"data:{mime};base64,{_gsmtc_b64.b64encode(bytes(buf)).decode('ascii')}"
    except Exception:
        return ""


async def _gsmtc_read_state_async(session):
    """Read media + playback + timeline. Returns a dict or None on failure."""
    try:
        media = await session.try_get_media_properties_async()
        info = session.get_playback_info()
        timeline = session.get_timeline_properties()

        try:
            is_playing = (info.playback_status == _GSMTCStatus.PLAYING)
        except Exception:
            is_playing = False

        # Timeline values are timedeltas
        try:
            position_ms = int(timeline.position.total_seconds() * 1000)
        except Exception:
            position_ms = 0
        try:
            duration_ms = int(timeline.end_time.total_seconds() * 1000)
        except Exception:
            duration_ms = 0

        # Spotify only broadcasts position on play/pause/seek/track-change
        # (roughly every 14s), not continuously. timeline.position is the
        # snapshot at timeline.last_updated_time — not "right now". Compute
        # the actual current position by adding elapsed real time, so the
        # value JS receives is already correct without further interpolation
        # mismatch. Only interpolate forward when playing.
        if is_playing:
            try:
                last_updated = timeline.last_updated_time
                # winrt DateTime comes through as a tz-aware Python datetime.
                # Fall back to naive subtraction if it's tz-naive.
                if last_updated.tzinfo is not None:
                    now_utc = _gsmtc_datetime.now(_gsmtc_tz.utc)
                else:
                    now_utc = _gsmtc_datetime.utcnow()
                elapsed_ms = int((now_utc - last_updated).total_seconds() * 1000)
                if 0 < elapsed_ms < 24 * 60 * 60 * 1000:  # sanity cap at 24h
                    position_ms += elapsed_ms
            except Exception:
                pass
        # Clamp to [0, duration]
        if duration_ms > 0:
            if position_ms < 0:
                position_ms = 0
            elif position_ms > duration_ms:
                position_ms = duration_ms

        try:
            shuffle = bool(info.is_shuffle_active) if info.is_shuffle_active is not None else False
        except Exception:
            shuffle = False

        # Translate auto_repeat_mode enum → string. Values:
        #   none (0) → 'off' | track (1) → 'track' | list (2) → 'context'
        try:
            mode = info.auto_repeat_mode
            if mode is None:
                repeat = "off"
            elif mode == _GSMTCRepeatMode.track:
                repeat = "track"
            elif mode == _GSMTCRepeatMode.list:
                repeat = "context"
            else:
                repeat = "off"
        except Exception:
            repeat = "off"

        try:
            source = session.source_app_user_model_id or ""
        except Exception:
            source = ""

        return {
            "title": media.title or "",
            "artists": media.artist or "",
            "album": media.album_title or "",
            "is_playing": is_playing,
            "progress_ms": position_ms,
            "duration_ms": duration_ms,
            "shuffle": shuffle,
            "repeat": repeat,
            "source": source,
            "_thumbnail_ref": media.thumbnail,
        }
    except Exception:
        return None


async def _gsmtc_loop_async():
    """Poll GetCurrentSession every _GSMTC_POLL_SEC. Filter to Spotify only.
    Push to JS on any change. Thumbnail extracted only on track change."""
    try:
        manager = await _GSMTCManager.request_async()
    except Exception as e:
        _debug_log(f"GSMTC: manager init failed: {e}")
        return

    _debug_log("GSMTC: monitor started")
    prev_track_key = None
    prev_payload = None

    while True:
        try:
            session = None
            try:
                session = manager.get_current_session()
            except Exception:
                session = None

            if session is None:
                with _gsmtc_lock:
                    if _gsmtc_cache["has_track"] or _gsmtc_cache["connected"]:
                        _gsmtc_cache.update({
                            "connected": False, "has_track": False,
                            "is_playing": False, "title": "", "artists": "",
                            "album": "", "album_art": "", "progress_ms": 0,
                            "duration_ms": 0, "source": "",
                        })
                        payload = _gsmtc_push_payload_locked()
                    else:
                        payload = None
                if payload is not None and payload != prev_payload:
                    _gsmtc_push_to_js(payload)
                    prev_payload = payload
                await _gsmtc_asyncio.sleep(_GSMTC_POLL_SEC)
                continue

            state = await _gsmtc_read_state_async(session)
            if state is None:
                await _gsmtc_asyncio.sleep(_GSMTC_POLL_SEC)
                continue

            # Source filter: only Spotify for now. If the foreground media is
            # something else (browser, etc.), clear the cache so the widget
            # doesn't show stale Spotify data.
            source_lower = state["source"].lower()
            if "spotify" not in source_lower:
                with _gsmtc_lock:
                    was_spotify = "spotify" in _gsmtc_cache.get("source", "").lower()
                    if was_spotify or _gsmtc_cache["has_track"]:
                        _gsmtc_cache.update({
                            "connected": True, "has_track": False,
                            "is_playing": False, "title": "", "artists": "",
                            "album": "", "album_art": "", "progress_ms": 0,
                            "duration_ms": 0, "source": state["source"],
                        })
                        payload = _gsmtc_push_payload_locked()
                    else:
                        payload = None
                if payload is not None and payload != prev_payload:
                    _gsmtc_push_to_js(payload)
                    prev_payload = payload
                prev_track_key = None
                await _gsmtc_asyncio.sleep(_GSMTC_POLL_SEC)
                continue

            # Thumbnail: extract only when track identity changes (title+artist).
            track_key = (state["title"], state["artists"])
            thumb_ref = state.pop("_thumbnail_ref", None)
            if track_key != prev_track_key:
                state["album_art"] = await _gsmtc_extract_thumbnail_async(thumb_ref)
                prev_track_key = track_key
            else:
                with _gsmtc_lock:
                    state["album_art"] = _gsmtc_cache.get("album_art", "")

            state["connected"] = True
            state["has_track"] = True
            state["device"] = "Local"
            state["track_id"] = ""

            # Build payload + diff against previous push. Exclude progress_ms
            # from the diff — JS interpolates between updates so we don't need
            # to spam a push every 500ms just because the playhead moved.
            with _gsmtc_lock:
                _gsmtc_cache.update(state)
                payload = _gsmtc_push_payload_locked()

            diff_keys = ("connected", "has_track", "is_playing", "title",
                         "artists", "album", "album_art", "duration_ms",
                         "shuffle", "repeat", "source")
            should_push = (prev_payload is None or
                           any(payload.get(k) != prev_payload.get(k) for k in diff_keys))
            # Also push if progress jumped backwards (seek) — JS interpolation
            # can't account for that on its own.
            if not should_push and prev_payload is not None:
                if payload["progress_ms"] + 1500 < prev_payload.get("progress_ms", 0):
                    should_push = True

            if should_push:
                _gsmtc_push_to_js(payload)
                prev_payload = payload

        except Exception as e:
            _debug_log(f"GSMTC loop error: {e}")

        await _gsmtc_asyncio.sleep(_GSMTC_POLL_SEC)


def _gsmtc_thread_entry():
    if not GSMTC_AVAILABLE:
        _debug_log("GSMTC: winrt unavailable, skipping local now-playing")
        return
    try:
        _gsmtc_asyncio.run(_gsmtc_loop_async())
    except Exception as e:
        _debug_log(f"GSMTC thread crashed: {e}")


# --- GSMTC transport-control write helpers ---------------------------------
# Run on whatever thread the JS API call lands on (pywebview's bridge thread);
# each helper spins up a short-lived asyncio loop to await the winrt call.

async def _gsmtc_get_session_async():
    try:
        manager = await _GSMTCManager.request_async()
        return manager.get_current_session()
    except Exception:
        return None


async def _gsmtc_set_shuffle_async(active):
    session = await _gsmtc_get_session_async()
    if session is None:
        return False
    try:
        return bool(await session.try_change_shuffle_active_async(bool(active)))
    except Exception as e:
        _debug_log(f"GSMTC set shuffle failed: {e}")
        return False


async def _gsmtc_set_repeat_async(mode_str):
    """mode_str: 'off' | 'track' | 'context'/'list'."""
    session = await _gsmtc_get_session_async()
    if session is None:
        return False
    mode_map = {
        "off":     _GSMTCRepeatMode.none,
        "track":   _GSMTCRepeatMode.track,
        "context": _GSMTCRepeatMode.list,
        "list":    _GSMTCRepeatMode.list,
    }
    target = mode_map.get(str(mode_str).lower(), _GSMTCRepeatMode.none)
    try:
        return bool(await session.try_change_auto_repeat_mode_async(target))
    except Exception as e:
        _debug_log(f"GSMTC set repeat failed: {e}")
        return False


# ---------------------------------------------------------------------------
# SendInput structs (must be module-level so classes can reference each other)
# ---------------------------------------------------------------------------

class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                 ("mouseData", ctypes.wintypes.DWORD), ("dwFlags", ctypes.wintypes.DWORD),
                 ("time", ctypes.wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", ctypes.wintypes.WORD), ("wScan", ctypes.wintypes.WORD),
                 ("dwFlags", ctypes.wintypes.DWORD), ("time", ctypes.wintypes.DWORD),
                 ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", ctypes.wintypes.DWORD), ("wParamL", ctypes.wintypes.WORD),
                 ("wParamH", ctypes.wintypes.WORD)]

class _INPUTunion(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("hi", _HARDWAREINPUT)]

class _INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.wintypes.DWORD), ("union", _INPUTunion)]


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

    # --- Audio Output Device Switching (via Sonar classicRedirections) -----

    def get_audio_outputs(self):
        """Return list of active render audio devices."""
        try:
            data, _ = sonar_get("audioDevices")
            outputs = []
            for d in data:
                if d.get("dataFlow") == "render" and d.get("state") == "active":
                    # Skip Sonar virtual devices
                    if "Sonar" in d.get("friendlyName", ""):
                        continue
                    outputs.append({
                        "id": d["id"],
                        "name": d["friendlyName"],
                    })
            return outputs
        except Exception:
            return []

    def get_current_output(self):
        """Return the device ID currently used by Sonar's game channel."""
        try:
            data, _ = sonar_get("classicRedirections")
            for r in data:
                if r["id"] == "game":
                    return r.get("deviceId", "")
            return ""
        except Exception:
            return ""

    def switch_audio_output(self, device_id):
        """Switch all Sonar channels to a different output device."""
        import urllib.parse
        try:
            encoded = urllib.parse.quote(device_id, safe="")
            results = []
            for ch in ["game", "chat", "media", "aux"]:
                _, code = sonar_put(
                    f"classicRedirections/{ch}/deviceId/{encoded}"
                )
                results.append(code)
            if all(c == 200 for c in results):
                return {"ok": True, "deviceId": device_id}
            return {"error": f"Some channels failed: {results}"}
        except Exception as e:
            return {"error": str(e)}

    def get_sessions(self):
        return _audio_cache["sessions"]

    def get_levels(self):
        return _audio_cache["sessions"]

    # --- Hotkey & Media Key Sending ----------------------------------------

    _VK_MAP = {
        'ctrl': 0xA2, 'lctrl': 0xA2, 'rctrl': 0xA3,
        'shift': 0xA0, 'lshift': 0xA0, 'rshift': 0xA1,
        'alt': 0xA4, 'lalt': 0xA4, 'ralt': 0xA5,
        'win': 0x5B, 'tab': 0x09, 'enter': 0x0D, 'return': 0x0D,
        'escape': 0x1B, 'esc': 0x1B, 'space': 0x20, 'backspace': 0x08,
        'delete': 0x2E, 'insert': 0x2D, 'home': 0x24, 'end': 0x23,
        'pageup': 0x21, 'pagedown': 0x22,
        'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27,
        'f1': 0x70, 'f2': 0x71, 'f3': 0x72, 'f4': 0x73,
        'f5': 0x74, 'f6': 0x75, 'f7': 0x76, 'f8': 0x77,
        'f9': 0x78, 'f10': 0x79, 'f11': 0x7A, 'f12': 0x7B,
        'printscreen': 0x2C, 'prtsc': 0x2C, 'numlock': 0x90, 'scrolllock': 0x91,
        '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
        '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
    }
    # Add a-z dynamically
    for _c in range(26):
        _VK_MAP[chr(ord('a') + _c)] = 0x41 + _c

    _MEDIA_VK = {
        'play_pause': 0xB3,
        'next': 0xB0,
        'prev': 0xB1,
        'stop': 0xB2,
        'vol_up': 0xAF,
        'vol_down': 0xAE,
        'vol_mute': 0xAD,
    }

    def _send_vk(self, vk, flags=0):
        inp = _INPUT()
        inp.type = 1  # INPUT_KEYBOARD
        inp.union.ki.wVk = vk
        inp.union.ki.dwFlags = flags
        ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))

    def send_hotkey(self, keys):
        """Send a keyboard shortcut via pyautogui for cross-app compatibility."""
        try:
            import pyautogui
            pyautogui.FAILSAFE = False
            pyautogui.hotkey(*[k.lower().strip() for k in keys])
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def show_desktop(self):
        """Show desktop (Win+D) but keep AuraLink visible on the Xeneon Edge."""
        try:
            import pyautogui
            pyautogui.FAILSAFE = False
            pyautogui.hotkey('win', 'd')
            time.sleep(0.3)
            if self._window:
                self._window.restore()
                self._window.on_top = True
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def restore_cursor(self):
        """Snap the OS cursor back to its last-known position on a non-AuraLink
        monitor. Called from JS on every touch-end so the cursor doesn't get
        stranded on the Xeneon Edge after a tap or slider release."""
        try:
            with _cursor_lock:
                x = _cursor_state.get("safe_x")
                y = _cursor_state.get("safe_y")
            if x is None or y is None:
                return {"ok": False, "error": "no safe position"}
            ctypes.windll.user32.SetCursorPos(int(x), int(y))
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def send_media_key(self, action):
        """Send a media key press. For playback actions (play_pause/next/prev),
        route through the Spotify Web API when Spotify has an active track,
        since Windows media keys are unreliable with the Spotify desktop client.
        Falls back to SendInput-based VK media keys otherwise (volume, stop,
        or any non-Spotify scenario)."""
        # Spotify Web API path
        if action in ('play_pause', 'next', 'prev') and _spotify_client is not None:
            cached = _spotify_cache.get("data")
            if cached and cached.get("connected") and cached.get("has_track"):
                with _spotify_lock:
                    try:
                        if action == 'play_pause':
                            if cached.get('is_playing'):
                                _spotify_client.pause_playback()
                            else:
                                _spotify_client.start_playback()
                        elif action == 'next':
                            _spotify_client.next_track()
                        elif action == 'prev':
                            _spotify_client.previous_track()
                        _spotify_cache["timestamp"] = 0  # force UI refresh
                        return {"ok": True, "via": "spotify"}
                    except Exception:
                        pass  # fall through to media keys

        # VK media key fallback
        try:
            vk = self._MEDIA_VK.get(action)
            if vk is None:
                return {"error": f"Unknown media action: {action}"}
            self._send_vk(vk)
            self._send_vk(vk, 0x0002)
            return {"ok": True, "via": "media_key"}
        except Exception as e:
            return {"error": str(e)}

    def discord_get_voice_state(self):
        """Get current Discord mute/deafen state without changing anything."""
        with _discord_lock:
            try:
                if not _discord_ensure_connected():
                    return {"error": "Discord not connected"}
                voice = _discord_send("GET_VOICE_SETTINGS")
                data = voice.get("data", {})
                return {"ok": True, "muted": data.get("mute", False), "deafened": data.get("deaf", False)}
            except Exception as e:
                return {"error": str(e)}

    def discord_toggle_mute(self):
        """Toggle Discord mute via local RPC — works in background."""
        return discord_toggle_mute()

    def discord_toggle_deafen(self):
        """Toggle Discord deafen via local RPC — works in background."""
        return discord_toggle_deafen()

    # --- Spotify Now Playing -----------------------------------------------

    def spotify_now_playing(self):
        """Cached current playback (~1Hz) for the now-playing widget."""
        with _spotify_lock:
            now = time.time() * 1000
            cached = _spotify_cache["data"]
            if cached is not None and now - _spotify_cache["timestamp"] < _SPOTIFY_CACHE_MS:
                return cached
            data = _spotify_now_playing()
            _spotify_cache["data"] = data
            _spotify_cache["timestamp"] = now
            return data

    def get_local_now_playing(self):
        """Snapshot of the GSMTC cache (local media session). Returns the
        same shape as spotify_now_playing(). Used by JS on boot to populate
        the widget before the first GSMTC push fires."""
        with _gsmtc_lock:
            return {k: v for k, v in _gsmtc_cache.items() if not k.startswith("_")}

    def gsmtc_toggle_shuffle(self):
        """Flip shuffle on the local media session (Spotify desktop, etc.).
        Reads current state from cache, sends the inverted value to GSMTC.
        Next poll cycle (≤500ms) will reconcile the displayed state."""
        if not GSMTC_AVAILABLE:
            return {"ok": False, "error": "GSMTC unavailable"}
        with _gsmtc_lock:
            current = bool(_gsmtc_cache.get("shuffle", False))
        target = not current
        try:
            ok = _gsmtc_asyncio.run(_gsmtc_set_shuffle_async(target))
            return {"ok": bool(ok), "shuffle": target}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def gsmtc_cycle_repeat(self):
        """Cycle repeat: off → context (repeat all) → track (repeat one) → off.
        Matches the Spotify desktop button cycle."""
        if not GSMTC_AVAILABLE:
            return {"ok": False, "error": "GSMTC unavailable"}
        with _gsmtc_lock:
            current = str(_gsmtc_cache.get("repeat", "off")).lower()
        next_mode = {
            "off":     "context",
            "context": "track",
            "list":    "track",
            "track":   "off",
        }.get(current, "off")
        try:
            ok = _gsmtc_asyncio.run(_gsmtc_set_repeat_async(next_mode))
            return {"ok": bool(ok), "repeat": next_mode}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def spotify_search(self, query, kind="track"):
        """Search Spotify by query. kind: 'track' | 'artist' | 'album'."""
        global _spotify_client
        if _spotify_client is None:
            if not _spotify_connect():
                return {"error": "Not connected to Spotify"}
        q = (query or "").strip()
        if not q:
            return {"results": []}
        if kind not in ("track", "artist", "album"):
            kind = "track"
        try:
            data = _spotify_client.search(q=q, type=kind, limit=10)
            results = []
            if kind == "track":
                for t in data.get("tracks", {}).get("items", []):
                    album = t.get("album", {})
                    images = album.get("images") or []
                    results.append({
                        "kind": "track",
                        "uri": t.get("uri", ""),
                        "title": t.get("name", ""),
                        "subtitle": ", ".join(a.get("name", "") for a in t.get("artists", [])),
                        "extra": album.get("name", ""),
                        "art": images[-1]["url"] if images else "",
                        "duration_ms": t.get("duration_ms", 0),
                    })
            elif kind == "artist":
                for a in data.get("artists", {}).get("items", []):
                    images = a.get("images") or []
                    followers = (a.get("followers") or {}).get("total", 0)
                    results.append({
                        "kind": "artist",
                        "uri": a.get("uri", ""),
                        "title": a.get("name", ""),
                        "subtitle": f"{followers:,} followers" if followers else "Artist",
                        "extra": "",
                        "art": images[-1]["url"] if images else "",
                    })
            else:  # album
                for al in data.get("albums", {}).get("items", []):
                    images = al.get("images") or []
                    results.append({
                        "kind": "album",
                        "uri": al.get("uri", ""),
                        "title": al.get("name", ""),
                        "subtitle": ", ".join(a.get("name", "") for a in al.get("artists", [])),
                        "extra": (al.get("release_date") or "")[:4],
                        "art": images[-1]["url"] if images else "",
                    })
            return {"results": results}
        except Exception as e:
            return {"error": str(e)}

    def spotify_play_uri(self, uri, device_id=None):
        """Start playback of a track / artist / album URI. Requires Premium.
        If device_id is provided (e.g. AuraLink's own Web Playback SDK device),
        try it first; on 404 (device not found / went idle), fall back to any
        active Spotify Connect device."""
        global _spotify_client
        if _spotify_client is None:
            if not _spotify_connect():
                return {"error": "Not connected to Spotify"}
        if not uri:
            return {"error": "No URI"}

        def _do_play(dev_id):
            if uri.startswith("spotify:track:"):
                _spotify_client.start_playback(device_id=dev_id, uris=[uri])
            else:
                _spotify_client.start_playback(device_id=dev_id, context_uri=uri)

        target_id = device_id
        target_name = "AuraLink" if device_id else ""
        last_error = None

        # Try the requested device — direct play, no transfer (transfer kicks
        # the SDK device offline momentarily, causing spurious 404s).
        if target_id:
            try:
                _do_play(target_id)
                _spotify_cache["timestamp"] = 0
                return {"ok": True, "device": target_name}
            except Exception as e:
                last_error = e
                msg = str(e)
                # Only retry on device-related failures
                if "404" not in msg and "Device not found" not in msg and "NO_ACTIVE_DEVICE" not in msg.upper():
                    return {"error": msg}

        # Retry path: refresh devices, prefer the originally-requested one
        # (if Spotify now reports it), else any active, else first available.
        try:
            devices = _spotify_client.devices().get("devices", [])
            if not devices:
                return {"error": "No Spotify device available. SDK may still be connecting — try again."}

            chosen = None
            # First preference: the device we originally asked for (it may have just registered)
            if target_id:
                chosen = next((d for d in devices if d.get("id") == target_id), None)
            # Else: any active device
            if chosen is None:
                chosen = next((d for d in devices if d.get("is_active")), None)
            # Else: first device in the list
            if chosen is None:
                chosen = devices[0]

            # Brief settle so Spotify finalises any state change
            time.sleep(0.25)
            _do_play(chosen["id"])
            _spotify_cache["timestamp"] = 0
            same_dev = (chosen["id"] == target_id)
            return {
                "ok": True,
                "device": chosen.get("name", ""),
                "fallback": not same_dev,
                "retry": same_dev,
            }
        except Exception as e:
            base = str(last_error) if last_error else str(e)
            return {"error": base}

    def spotify_get_access_token(self):
        """Return a fresh access token for the Web Playback SDK to use.
        spotipy's auth_manager handles refresh automatically."""
        global _spotify_client
        if _spotify_client is None:
            if not _spotify_connect():
                return None
        try:
            token_info = _spotify_client.auth_manager.get_access_token(as_dict=True, check_cache=True)
            if isinstance(token_info, dict):
                return token_info.get("access_token")
            return token_info  # spotipy <2.x returned a string
        except Exception:
            return None

    def js_log(self, msg):
        """JS-side debug bridge — writes a tagged line to sonar_debug.log."""
        try:
            log_path = os.path.join(
                os.path.dirname(sys.executable) if getattr(sys, "frozen", False)
                else os.path.dirname(os.path.abspath(__file__)),
                "sonar_debug.log",
            )
            with open(log_path, "a") as f:
                f.write(f"{time.strftime('%H:%M:%S')} JS: {msg}\n")
        except Exception:
            pass
        return {"ok": True}

    # --- Elgato Key Light Control ------------------------------------------

    def elgato_discover(self):
        """Scan local network for Elgato Key Light devices."""
        import socket
        import concurrent.futures
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
            subnet = ".".join(local_ip.split(".")[:3])

            def check(ip):
                try:
                    r = requests.get(f"http://{ip}:9123/elgato/accessory-info", timeout=0.5)
                    if r.status_code == 200:
                        info = r.json()
                        return {"ip": ip, "name": info.get("displayName", ip)}
                except Exception:
                    pass
                return None

            found = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=50) as ex:
                futures = [ex.submit(check, f"{subnet}.{i}") for i in range(1, 255)]
                for f in concurrent.futures.as_completed(futures):
                    result = f.result()
                    if result:
                        found.append(result)
            return found
        except Exception as e:
            return []

    def elgato_toggle(self, ip):
        """Toggle a Key Light on/off."""
        try:
            r = requests.get(f"http://{ip}:9123/elgato/lights", timeout=2)
            data = r.json()
            light = data["lights"][0]
            new_on = 0 if light["on"] else 1
            requests.put(f"http://{ip}:9123/elgato/lights", json={
                "numberOfLights": 1,
                "lights": [{"on": new_on, "brightness": light["brightness"], "temperature": light["temperature"]}],
            }, timeout=2)
            return {"ok": True, "on": bool(new_on)}
        except Exception as e:
            return {"error": str(e)}

    def elgato_get_state(self, ip):
        """Get current Key Light state."""
        try:
            r = requests.get(f"http://{ip}:9123/elgato/lights", timeout=1)
            light = r.json()["lights"][0]
            return {"ok": True, "on": bool(light["on"]), "brightness": light["brightness"]}
        except Exception:
            return {"error": "Light not reachable"}

    # --- Meld Studio Control -------------------------------------------------

    _MELD_WS_URL = "ws://127.0.0.1:13376"
    _MELD_EXE = r"C:\Users\User\AppData\Local\Microsoft\WindowsApps\meldstudio.exe"

    def _meld_send(self, method_name, args=None):
        """Connect to Meld Studio via Qt WebChannel and invoke a method."""
        import websocket
        try:
            ws = websocket.create_connection(self._MELD_WS_URL, timeout=3)

            # Qt WebChannel init (type 3) — MUST include id field
            ws.send(json.dumps({"type": 3, "id": 0}))
            init_resp = json.loads(ws.recv())

            # Find the method's numeric index from the meld object
            meld_obj = init_resp.get("data", {}).get("meld", {})
            methods = meld_obj.get("methods", [])
            method_idx = None
            for m in methods:
                if isinstance(m, list) and len(m) >= 2 and m[0] == method_name:
                    method_idx = m[1]
                    break

            if method_idx is None:
                ws.close()
                return {"error": f"Method '{method_name}' not found"}

            # Invoke method (type 6)
            ws.send(json.dumps({
                "type": 6,
                "object": "meld",
                "method": method_idx,
                "args": args or [],
                "id": 1,
            }))

            # Read response (type 10)
            ws.settimeout(3)
            try:
                resp = json.loads(ws.recv())
            except Exception:
                resp = {}
            ws.close()
            return {"ok": True, "data": resp.get("data")}
        except ConnectionRefusedError:
            return {"error": "Meld Studio not running"}
        except Exception as e:
            return {"error": str(e)}

    def _meld_get_property(self, prop_name):
        """Get a property value from the meld object."""
        import websocket
        try:
            ws = websocket.create_connection(self._MELD_WS_URL, timeout=2)
            ws.send(json.dumps({"type": 3, "id": 0}))
            init_resp = json.loads(ws.recv())
            meld_obj = init_resp.get("data", {}).get("meld", {})

            # Properties: [index, name, signalInfo, value]
            props = meld_obj.get("properties", [])
            for p in props:
                if isinstance(p, list) and len(p) >= 4 and p[1] == prop_name:
                    ws.close()
                    return p[3]

            ws.close()
            return None
        except Exception:
            return None

    def meld_launch(self):
        """Launch Meld Studio."""
        try:
            os.startfile(self._MELD_EXE)
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def meld_toggle_record(self):
        """Toggle Meld Studio recording."""
        return self._meld_send("toggleRecord")

    def meld_toggle_stream(self):
        """Toggle Meld Studio streaming."""
        return self._meld_send("toggleStream")

    def meld_get_state(self):
        """Get current Meld Studio recording/streaming state."""
        import websocket
        try:
            ws = websocket.create_connection(self._MELD_WS_URL, timeout=2)
            ws.send(json.dumps({"type": 3, "id": 0}))
            init_resp = json.loads(ws.recv())
            meld_obj = init_resp.get("data", {}).get("meld", {})
            ws.close()

            # Properties: [index, name, signalInfo, value]
            props = meld_obj.get("properties", [])
            state = {"ok": True, "running": True, "recording": False, "streaming": False}
            for p in props:
                if isinstance(p, list) and len(p) >= 4:
                    if p[1] == "isRecording":
                        state["recording"] = bool(p[3])
                    elif p[1] == "isStreaming":
                        state["streaming"] = bool(p[3])
            return state
        except ConnectionRefusedError:
            return {"ok": True, "running": False, "recording": False, "streaming": False}
        except Exception:
            return {"ok": True, "running": False, "recording": False, "streaming": False}

    def pick_bg_image(self):
        """Open native file picker for a background image OR video.
        Images return as base64 data URL (stored in localStorage).
        Videos are copied into bg/ next to the HTML and served via pywebview's
        built-in HTTP server — JS references them by relative URL."""
        if not self._window:
            return {"error": "No window"}
        try:
            import base64
            import shutil
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=(
                    'Media (*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp;*.mp4;*.webm;*.mov;*.mkv)',
                    'Image Files (*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp)',
                    'Video Files (*.mp4;*.webm;*.mov;*.mkv)',
                ),
            )
            if not result or len(result) == 0:
                return {"cancelled": True}

            file_path = result[0]
            ext = os.path.splitext(file_path)[1].lower()
            video_exts = {'.mp4', '.webm', '.mov', '.mkv'}

            # Locate the directory pywebview serves over its HTTP server.
            # That's the directory the runtime HTML lives in.
            if getattr(sys, "frozen", False):
                served_dir = sys._MEIPASS
            else:
                served_dir = os.path.dirname(os.path.abspath(__file__))
            bg_dir = os.path.join(served_dir, "bg")

            # Wipe any previous bg media so we never leave stale files behind
            try:
                if os.path.isdir(bg_dir):
                    for fname in os.listdir(bg_dir):
                        try:
                            os.remove(os.path.join(bg_dir, fname))
                        except Exception:
                            pass
            except Exception:
                pass

            # --- Video branch ---
            if ext in video_exts:
                video_mime_map = {
                    '.mp4': 'video/mp4', '.webm': 'video/webm',
                    '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
                }
                mime = video_mime_map.get(ext, 'video/mp4')
                os.makedirs(bg_dir, exist_ok=True)
                dest_name = f"bg_video{ext}"
                dest_path = os.path.join(bg_dir, dest_name)
                shutil.copy2(file_path, dest_path)
                cache_tag = str(int(time.time()))
                return {
                    "type": "video",
                    "url": f"bg/{dest_name}?v={cache_tag}",
                    "mime": mime,
                }

            # --- Image branch ---
            mime_map = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.bmp': 'image/bmp', '.gif': 'image/gif', '.webp': 'image/webp',
            }
            mime = mime_map.get(ext, 'image/png')

            with open(file_path, 'rb') as f:
                data = f.read()

            data_url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
            return {"type": "image", "dataUrl": data_url}
        except Exception as e:
            return {"error": str(e)}

    def pick_pause_image(self):
        """Open native file picker for the 'pause-while-gaming' fallback image.
        Image-only. Copied to bg/pause_image.<ext> and served by pywebview's
        HTTP server. Returns {url, mime}. Pairs with clear_pause_image."""
        if not self._window:
            return {"error": "No window"}
        try:
            import shutil
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=(
                    'Image Files (*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp)',
                ),
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

            if getattr(sys, "frozen", False):
                served_dir = sys._MEIPASS
            else:
                served_dir = os.path.dirname(os.path.abspath(__file__))
            bg_dir = os.path.join(served_dir, "bg")
            os.makedirs(bg_dir, exist_ok=True)

            # Remove any prior pause_image.* so we don't leave stale files
            try:
                for fname in os.listdir(bg_dir):
                    if fname.startswith("pause_image."):
                        try:
                            os.remove(os.path.join(bg_dir, fname))
                        except Exception:
                            pass
            except Exception:
                pass

            dest_name = f"pause_image{ext}"
            dest_path = os.path.join(bg_dir, dest_name)
            shutil.copy2(file_path, dest_path)
            cache_tag = str(int(time.time()))
            return {
                "url": f"bg/{dest_name}?v={cache_tag}",
                "mime": mime,
            }
        except Exception as e:
            return {"error": str(e)}

    def clear_pause_image(self):
        """Delete any saved pause-while-gaming image."""
        try:
            if getattr(sys, "frozen", False):
                served_dir = sys._MEIPASS
            else:
                served_dir = os.path.dirname(os.path.abspath(__file__))
            bg_dir = os.path.join(served_dir, "bg")
            if os.path.isdir(bg_dir):
                for fname in os.listdir(bg_dir):
                    if fname.startswith("pause_image."):
                        try:
                            os.remove(os.path.join(bg_dir, fname))
                        except Exception:
                            pass
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def _extract_icon_base64(self, exe_path, size=48):
        """Extract icon from an .exe or .lnk and return as base64 PNG data URL."""
        try:
            import base64
            import io
            import win32gui
            import win32ui
            import win32con
            import win32api
            from PIL import Image

            # Resolve .lnk shortcuts to their target
            if exe_path.lower().endswith('.lnk'):
                try:
                    import pythoncom
                    from win32com.shell import shell, shellcon
                    link = pythoncom.CoCreateInstance(
                        shell.CLSID_ShellLink, None,
                        pythoncom.CLSCTX_INPROC_SERVER, shell.IID_IShellLink
                    )
                    link.QueryInterface(pythoncom.IID_IPersistFile).Load(exe_path)
                    target, _ = link.GetPath(shellcon.SLGP_RAWPATH)
                    if target:
                        exe_path = target
                except Exception:
                    pass

            # Extract icon handle from the executable
            large_icons, _ = win32gui.ExtractIconEx(exe_path, 0, 1)
            if not large_icons:
                return None
            hicon = large_icons[0]

            # Create device context and bitmap
            hdc = win32ui.CreateDCFromHandle(win32gui.GetDC(0))
            hbmp = win32ui.CreateBitmap()
            hbmp.CreateCompatibleBitmap(hdc, size, size)
            hdc_mem = hdc.CreateCompatibleDC()
            hdc_mem.SelectObject(hbmp)

            # Fill with black background, draw icon
            hdc_mem.FillSolidRect((0, 0, size, size), 0x000000)
            win32gui.DrawIconEx(hdc_mem.GetHandleOutput(), 0, 0, hicon,
                                size, size, 0, None, 0x0003)

            # Get bitmap bits → PIL Image
            bmpinfo = hbmp.GetInfo()
            bmpstr = hbmp.GetBitmapBits(True)
            img = Image.frombuffer('RGBA',
                                   (bmpinfo['bmWidth'], bmpinfo['bmHeight']),
                                   bmpstr, 'raw', 'BGRA', 0, 1)

            # Save as PNG to memory
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            buf.seek(0)

            # Cleanup
            hdc_mem.DeleteDC()
            win32gui.ReleaseDC(0, hdc.GetHandleOutput())
            win32gui.DestroyIcon(hicon)

            return f"data:image/png;base64,{base64.b64encode(buf.read()).decode()}"
        except Exception:
            return None

    def pick_app_executable(self):
        """Open native file picker for an app (.exe or .lnk), return path, name, and icon."""
        if not self._window:
            return {"error": "No window"}
        try:
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=('Applications (*.exe;*.lnk)',),
            )
            if not result or len(result) == 0:
                return {"cancelled": True}

            file_path = result[0]
            display_name = os.path.splitext(os.path.basename(file_path))[0]
            icon_data = self._extract_icon_base64(file_path)
            return {"path": file_path, "name": display_name, "icon": icon_data}
        except Exception as e:
            return {"error": str(e)}

    def launch_app(self, path):
        """Launch an application by path using Windows shell."""
        try:
            os.startfile(path)
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def kill_app(self, name, path=None):
        """Kill a running app by name or path using taskkill."""
        import subprocess
        try:
            # Get the exe filename from the path if available
            exe_name = None
            if path:
                # Resolve .lnk shortcuts
                if path.lower().endswith('.lnk'):
                    try:
                        import win32com.client
                        shell = win32com.client.Dispatch("WScript.Shell")
                        shortcut = shell.CreateShortCut(path)
                        exe_name = os.path.basename(shortcut.Targetpath)
                    except Exception:
                        pass
                else:
                    exe_name = os.path.basename(path)

            # Build list of names to try killing
            targets = []
            if exe_name:
                targets.append(exe_name)
            targets.append(name + ".exe")
            targets.append(name)

            for target in targets:
                if not target.lower().endswith('.exe'):
                    target = target + '.exe'
                result = subprocess.run(
                    ['taskkill', '/F', '/IM', target],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    return {"ok": True, "name": name}

            return {"error": f"'{name}' not running"}
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Hardware Monitor (Libre Hardware Monitor JSON API)
    # ------------------------------------------------------------------

    def get_hardware_sensors(self):
        """Fetch key sensor data from Libre Hardware Monitor's HTTP API."""
        import urllib.request
        try:
            with urllib.request.urlopen('http://localhost:8085/data.json', timeout=2) as resp:
                data = json.loads(resp.read().decode())

            sensors = {
                "cpu_temp": self._find_sensor(data, "Core (Tctl", "Temperature")
                            or self._find_sensor(data, "CPU Package", "Temperature")
                            or self._find_sensor(data, "Core Average", "Temperature"),
                "gpu_temp": self._find_sensor(data, "GPU Core", "Temperature"),
                "cpu_load": self._find_sensor(data, "CPU Total", "Load"),
                "gpu_load": self._find_sensor(data, "GPU Core", "Load"),
                "ram_load": self._find_sensor(data, "Memory", "Load"),
                "gpu_vram": self._find_sensor(data, "GPU Memory", "Load")
                            or self._find_sensor(data, "D3D Dedicated Memory", "Load"),
                "cpu_power": self._find_sensor(data, "CPU Package", "Power")
                             or self._find_sensor(data, "Package", "Power"),
                "gpu_power": self._find_sensor(data, "12VHPWR Connector", "Power")
                             or self._find_sensor(data, "GPU Package", "Power")
                             or self._find_sensor(data, "GPU Power", "Power"),
                "mobo_temp": self._find_sensor(data, "Motherboard", "Temperature"),
                "ram_temp": self._find_sensor(data, "DIMM #1", "Temperature")
                            or self._find_sensor(data, "DIMM", "Temperature"),
            }
            return sensors
        except Exception:
            return {"error": "Libre Hardware Monitor not detected"}

    def _find_sensor(self, node, text_match, sensor_type):
        """Recursively find first sensor matching name and type, return its value."""
        text_match_lower = text_match.lower()

        def _search(n):
            text = n.get("Text", "")
            if text_match_lower in text.lower() and n.get("Type") == sensor_type:
                raw = n.get("Value", "")
                # Parse "46.4 °C" or "15.4 %" or "49.7 W" → float
                try:
                    return float(raw.split()[0].replace(",", "."))
                except (ValueError, IndexError):
                    return 0.0
            for child in n.get("Children", []):
                result = _search(child)
                if result is not None:
                    return result
            return None

        return _search(node)

    def _find_all_sensors(self, node, sensor_type):
        """Find all sensors of a given type, return list of {name, value}."""
        results = []

        def _search(n):
            if n.get("Type") == sensor_type:
                raw = n.get("Value", "")
                try:
                    val = float(raw.split()[0].replace(",", "."))
                except (ValueError, IndexError):
                    val = 0.0
                name = n.get("Text", "Unknown")
                if val > 0:
                    results.append({"name": name, "value": val})
            for child in n.get("Children", []):
                _search(child)

        _search(node)
        return results

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

    threading.Thread(target=_discord_startup, daemon=True).start()
    _log("Discord RPC connecting in background")

    threading.Thread(target=_spotify_startup, daemon=True).start()
    _log("Spotify connecting in background")

    threading.Thread(target=discovery_loop, daemon=True).start()

    api = SonarAPI()

    if getattr(sys, "frozen", False):
        base_dir = sys._MEIPASS
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
    html_path = os.path.join(base_dir, "index_v5.html")

    # Cache-bust style/script refs so WebView2 always picks up edits across launches
    try:
        cache_tag = str(int(time.time()))
        with open(html_path, "r", encoding="utf-8") as _hf:
            _html = _hf.read()
        _html = _html.replace('href="style_v5.css"', f'href="style_v5.css?v={cache_tag}"')
        _html = _html.replace('src="app_v5.js"', f'src="app_v5.js?v={cache_tag}"')
        runtime_html_path = os.path.join(base_dir, "_index_v5_runtime.html")
        with open(runtime_html_path, "w", encoding="utf-8") as _hf:
            _hf.write(_html)
        html_path = runtime_html_path
        _log(f"Wrote cache-busted HTML (v={cache_tag})")
    except Exception as _e:
        _log(f"Cache-bust failed (using original HTML): {_e}")

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
    # Cursor parking tracker — records the cursor's last position OUTSIDE the
    # Xeneon Edge so SonarAPI.restore_cursor() can snap back there after each
    # touch ends. Does NOT auto-teleport mid-touch (would fight slider drags).
    # ---------------------------------------------------------------------------
    # Fallback position: center of the first monitor that isn't the Xeneon Edge.
    fallback_x, fallback_y = 100, 100
    for mx, my, mw, mh in monitors:
        if (mx, my, mw, mh) != (edge_x, edge_y, edge_w, edge_h):
            fallback_x = mx + mw // 2
            fallback_y = my + mh // 2
            break

    def _cursor_tracker():
        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        get_pos = ctypes.windll.user32.GetCursorPos
        pos = POINT(0, 0)

        # Seed with current cursor position if off-edge, else fallback.
        get_pos(ctypes.byref(pos))
        seed_on_edge = (edge_x <= pos.x < edge_x + edge_w and
                        edge_y <= pos.y < edge_y + edge_h)
        with _cursor_lock:
            if seed_on_edge:
                _cursor_state["safe_x"] = fallback_x
                _cursor_state["safe_y"] = fallback_y
            else:
                _cursor_state["safe_x"] = pos.x
                _cursor_state["safe_y"] = pos.y

        while True:
            get_pos(ctypes.byref(pos))
            on_edge = (edge_x <= pos.x < edge_x + edge_w and
                       edge_y <= pos.y < edge_y + edge_h)
            if not on_edge:
                with _cursor_lock:
                    _cursor_state["safe_x"] = pos.x
                    _cursor_state["safe_y"] = pos.y
            time.sleep(0.1)

    threading.Thread(target=_cursor_tracker, daemon=True).start()

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
    _gsmtc_set_window(window)

    # Start local-now-playing monitor (GSMTC). Spotify desktop / browser /
    # any media app pushes updates with ~500ms latency vs. the Web API's 30s.
    if GSMTC_AVAILABLE:
        threading.Thread(target=_gsmtc_thread_entry, daemon=True).start()
    else:
        _log("GSMTC unavailable — local now-playing will fall back to Web API only")

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
        debug=True,           # Enables right-click → Inspect (WebView2 devtools)
    )
