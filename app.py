"""Piano Trigger: one trigger press = one note (chord) typed into the game.

Hold a trigger and the note stays held until you release it.
UI is a local web page (web/) opened in an Edge/Chrome app window,
so the whole look can be changed with custom CSS in Settings.
"""

import ctypes
import json
import math
import os
import struct
import subprocess
import sys
import threading
import time
import traceback
import wave
import webbrowser
import winsound
from ctypes import wintypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import keyboard

APP_TITLE = "Piano Trigger"
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
WEB = BASE / "web"
DATA = Path(os.environ.get("APPDATA", str(Path.home()))) / "PianoTrigger"
DATA.mkdir(parents=True, exist_ok=True)
if getattr(sys, "frozen", False):  # --noconsole: keep errors in a log file
    sys.stdout = sys.stderr = open(DATA / "log.txt", "a", encoding="utf-8", buffering=1)

# ----------------------------------------------------------------- storage
DEFAULTS = {
    "onTop": False,
    "loop": True,
    "inputMode": "scancode",  # "scancode" or "virtual"
    "holdMs": 28,  # minimum time keys stay down on a quick tap
    "maxChord": 6,  # unbracketed groups longer than this are split into single notes
    "viewMode": "standard",  # standard | compact (one line)
    "bareNotes": "single",  # single | chord: how groups without [brackets] are played
    "autoArm": True,  # arm triggers automatically when a song opens
    "boxes": True,  # draw notes inside boxes
    "animations": True,
    "clickOn": True,  # click sound on every triggered note
    "clickType": "soft",  # soft | tick | pop | wood
    "clickVolume": 40,  # 0-100
    "repeatDelayMs": 220,  # holding a trigger: pause before repeating
    "repeatRateMs": 60,  # holding a trigger: time between repeats
    "binds": [
        {"sc": 12, "name": "-"},
        {"sc": 13, "name": "="},
        {"sc": 26, "name": "["},
        {"sc": 27, "name": "]"},
    ],
    "css": "",
}
LIMITS = {
    "holdMs": (8, 200),
    "maxChord": (2, 12),
    "clickVolume": (0, 100),
    "repeatDelayMs": (60, 800),
    "repeatRateMs": (20, 400),
}


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


SETTINGS_FILE, SONGS_FILE = DATA / "settings.json", DATA / "songs.json"
cfg = {**DEFAULTS, **load_json(SETTINGS_FILE, {})}
songs = load_json(SONGS_FILE, [])


def save_cfg():
    save_json(SETTINGS_FILE, cfg)


def merge_settings(patch):
    for k, v in patch.items():
        if k not in DEFAULTS or k == "binds":
            continue
        if k in LIMITS:
            lo, hi = LIMITS[k]
            v = max(lo, min(hi, int(v)))
        elif k in ("onTop", "loop", "clickOn", "autoArm", "boxes", "animations"):
            v = bool(v)
        elif k == "bareNotes":
            v = v if v in ("single", "chord") else "single"
        elif k == "viewMode":
            v = v if v in ("standard", "compact") else "standard"
        elif k == "clickType":
            v = v if v in CLICK_TYPES else "soft"
        elif k == "inputMode":
            v = v if v in ("scancode", "virtual") else "scancode"
        else:
            v = str(v)
        cfg[k] = v
    save_cfg()


# --------------------------------------------------------------- click sound
CLICK_TYPES = ("soft", "tick", "pop", "wood")
SOUND_DIR = DATA / "sounds"
SOUND_DIR.mkdir(exist_ok=True)
RATE = 44100


def _click_samples(kind):
    length = {"soft": 0.05, "tick": 0.02, "pop": 0.06, "wood": 0.045}[kind]
    out = []
    for i in range(int(RATE * length)):
        t = i / RATE
        if kind == "soft":
            v = math.sin(2 * math.pi * 620 * t) * math.exp(-t * 90)
        elif kind == "tick":
            v = math.sin(2 * math.pi * 2200 * t) * math.exp(-t * 380)
        elif kind == "pop":
            v = math.sin(2 * math.pi * (900 * t - 6000 * t * t)) * math.exp(-t * 70)
        else:
            v = (
                (
                    math.sin(2 * math.pi * 1100 * t)
                    + 0.6 * math.sin(2 * math.pi * 1750 * t)
                )
                / 1.6
                * math.exp(-t * 140)
            )
        out.append(v * min(1.0, t / 0.001))  # 1 ms fade-in, no pop at the start
    return out


def click_path(kind, volume):
    vol = int(round(volume / 5) * 5)
    path = SOUND_DIR / f"{kind}_{vol}.wav"
    if not path.exists():
        amp = 32767 * 0.9 * vol / 100
        frames = b"".join(
            struct.pack("<h", int(max(-1.0, min(1.0, v)) * amp))
            for v in _click_samples(kind)
        )
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(frames)
    return path


def play_click():
    if not cfg["clickOn"] or cfg["clickVolume"] <= 0:
        return
    try:
        winsound.PlaySound(
            str(click_path(cfg["clickType"], cfg["clickVolume"])),
            winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT,
        )
    except Exception:
        traceback.print_exc()


# ------------------------------------------------------------- key injection
user32 = ctypes.windll.user32
KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE = 0x0002, 0x0008


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _IU(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _IU)]


user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.SetWindowPos.argtypes = [
    wintypes.HWND,
    wintypes.HWND,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.UINT,
]

SC = {}
for _row, _start in (("qwertyuiop", 0x10), ("asdfghjkl", 0x1E), ("zxcvbnm", 0x2C)):
    for _i, _c in enumerate(_row):
        SC[_c] = _start + _i
for _i, _c in enumerate("1234567890"):
    SC[_c] = 0x02 + _i
SHIFT_KEY = (0x2A, 0xA0)  # (scancode, VK_LSHIFT)
SHIFTED_DIGITS = dict(zip("!@#$%^&*()", "1234567890"))


def key_of(ch):
    return SC[ch], ord(ch.upper())


def send(keys, up, mode):
    if not keys:
        return
    arr = (INPUT * len(keys))()
    for n, (sc, vk) in enumerate(keys):
        flags = KEYEVENTF_KEYUP if up else 0
        if mode == "virtual":
            arr[n].type = 1
            arr[n].ki = KEYBDINPUT(vk, user32.MapVirtualKeyW(vk, 0), flags, 0, 0)
        else:
            arr[n].type = 1
            arr[n].ki = KEYBDINPUT(0, sc, flags | KEYEVENTF_SCANCODE, 0, 0)
    user32.SendInput(len(keys), arr, ctypes.sizeof(INPUT))


def split_step(step):
    """'pfiF' -> (plain=['p','f','i'], shifted=['f'])"""
    plain, shifted = [], []
    for ch in step:
        if ch in SHIFTED_DIGITS:
            shifted.append(SHIFTED_DIGITS[ch])
        elif ch.isascii() and ch.isalpha():
            (shifted if ch.isupper() else plain).append(ch.lower())
        elif ch.isascii() and ch.isdigit():
            plain.append(ch)
    return list(dict.fromkeys(plain)), list(dict.fromkeys(shifted))


# -------------------------------------------------------------------- engine
class Engine:
    def __init__(self):
        self.lock = threading.Lock()
        self.inject = threading.Lock()
        self.steps, self.index = [], 0
        self.armed = False
        self.seq = 0
        self.held = {}  # scancode -> Event (trigger currently down)
        self.ignore = {}  # scancode -> time until our own injected events are ignored
        self.blockers = {}  # trigger scancode -> function that removes its key block
        self.sync_lock = threading.Lock()
        self.down = {}  # scancode -> token of the note that is holding it
        self.shifted = set()  # scancodes currently held together with Shift
        self.shift_down = False
        self.capturing = False
        self.ended = False
        self.toast_seq, self.toast_text = 0, ""

    def toast(self, text):
        self.toast_seq += 1
        self.toast_text = text

    def state(self):
        return {
            "armed": self.armed,
            "index": self.index,
            "total": len(self.steps),
            "seq": self.seq,
            "capturing": self.capturing,
            "binds": cfg["binds"],
            "toast": {"seq": self.toast_seq, "text": self.toast_text},
        }

    def load(self, steps, index):
        with self.lock:
            self.steps = [str(s) for s in steps]
            self.index = max(0, min(int(index), len(self.steps)))
            self.ended = False

    def seek(self, index):
        with self.lock:
            self.index = max(0, min(int(index), len(self.steps)))
            self.ended = False

    def take(self):
        with self.lock:
            n = len(self.steps)
            if not n:
                return None
            if self.index >= n:
                if cfg["loop"]:
                    self.index = 0
                else:
                    if not self.ended:
                        self.ended = True
                        self.toast("End of song")
                    return None
            step = self.steps[self.index]
            self.index += 1
            self.ended = False
            return step

    def press(self, step):
        """Press the keys of one note and return a function that releases them.

        Several notes can overlap (fast playing with two fingers), so Shift and
        repeated keys are tracked globally instead of per note.
        """
        plain, shifted = split_step(step)
        mode = cfg["inputMode"]
        pk = [key_of(c) for c in plain]
        sk = [key_of(c) for c in shifted]
        used = [sc for sc, _ in pk + sk + [SHIFT_KEY]]
        token = object()
        for sc in used:
            self.ignore[sc] = float("inf")  # ignore our own events while held
        with self.inject:
            self.seq += 1
            if pk:
                if self.shift_down:  # plain keys must not pick up a leftover Shift
                    send([SHIFT_KEY], True, mode)
                    self.shift_down = False
                send(
                    [k for k in pk if k[0] in self.down], True, mode
                )  # same key still held: re-strike it
                send(pk, False, mode)
                for sc, _ in pk:
                    self.down[sc] = token
                    self.shifted.discard(sc)
            if sk:
                if not self.shift_down:
                    send([SHIFT_KEY], False, mode)
                    self.shift_down = True
                    time.sleep(0.002)
                send([k for k in sk if k[0] in self.down], True, mode)
                send(sk, False, mode)
                for sc, _ in sk:
                    self.down[sc] = token
                    self.shifted.add(sc)
        play_click()

        def release():
            with self.inject:
                mine = list(
                    {k[0]: k for k in sk + pk if self.down.get(k[0]) is token}.values()
                )
                send(mine, True, mode)
                for sc, _ in mine:
                    del self.down[sc]
                    self.shifted.discard(sc)
                if self.shift_down and not self.shifted:
                    send([SHIFT_KEY], True, mode)
                    self.shift_down = False
            until = time.time() + 0.15
            for sc in used:
                busy = self.shift_down if sc == SHIFT_KEY[0] else sc in self.down
                if not busy:
                    self.ignore[sc] = until

        return release

    def runner(self, ev):
        step = self.take()
        if step is None:
            return
        t0 = time.time()
        release = self.press(step)
        ev.wait()  # keys stay down while the trigger is held
        left = cfg["holdMs"] / 1000 - (time.time() - t0)
        if left > 0:
            time.sleep(left)  # a quick tap still lasts at least holdMs
        release()

    def on_event(self, e):
        try:
            sc = e.scan_code
            if e.event_type == keyboard.KEY_UP:
                ev = self.held.pop(sc, None)
                if ev:
                    ev.set()
                return
            if self.ignore.get(sc, 0) > time.time() or sc in self.held:
                return
            if self.capturing:
                self.held[sc] = threading.Event()
                self.capturing = False
                if sc == 1:
                    self.toast("Cancelled")
                elif any(b["sc"] == sc for b in cfg["binds"]):
                    self.toast("That key is already a trigger")
                else:
                    name = e.name or f"key {sc}"
                    cfg["binds"].append({"sc": sc, "name": name})
                    save_cfg()
                    threading.Thread(target=self.sync_blockers, daemon=True).start()
                    self.toast(f"Trigger added: {name}")
                return
            if not self.armed or sc not in {b["sc"] for b in cfg["binds"]}:
                return
            ev = threading.Event()
            self.held[sc] = ev
            threading.Thread(target=self.runner, args=(ev,), daemon=True).start()
        except Exception:
            traceback.print_exc()

    def sync_blockers(self):
        """Armed trigger keys must not reach the game (otherwise '-' types a silent note)."""
        with self.sync_lock:
            want = {b["sc"] for b in cfg["binds"]}
            for sc in list(self.blockers):
                if sc not in want:
                    try:
                        self.blockers.pop(sc)()
                    except Exception:
                        traceback.print_exc()
            for sc in want - set(self.blockers):
                try:
                    self.blockers[sc] = keyboard.hook_key(
                        sc, lambda e, _sc=sc: self.on_trigger_key(e), suppress=True
                    )
                except Exception:
                    traceback.print_exc()

    def on_trigger_key(self, e):
        """Runs inside the keyboard hook for trigger keys: True = let the key through."""
        try:
            block = self.armed and not self.capturing
            self.on_event(e)
            return not block
        except Exception:
            traceback.print_exc()
            return True

    def on_global(self, e):
        if e.scan_code in self.blockers:  # handled by on_trigger_key
            return
        self.on_event(e)


engine = Engine()


# ----------------------------------------------------------- window on top
EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


def find_window():
    found = []

    def cb(h, _):
        if user32.IsWindowVisible(h):
            n = user32.GetWindowTextLengthW(h)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(h, buf, n + 1)
                if buf.value.startswith(APP_TITLE):
                    found.append(h)
        return True

    user32.EnumWindows(EnumProc(cb), 0)
    return found[0] if found else None


def apply_topmost(flag, tries=40):
    for _ in range(tries):
        h = find_window()
        if h:
            # HWND_TOPMOST = -1, HWND_NOTOPMOST = -2; NOSIZE|NOMOVE|NOACTIVATE
            user32.SetWindowPos(
                h, wintypes.HWND(-1 if flag else -2), 0, 0, 0, 0, 0x0013
            )
            on = bool(user32.GetWindowLongW(h, -20) & 0x8)  # WS_EX_TOPMOST
            print("topmost:", flag, "hwnd:", h, "actual:", on)
            return on == flag
        time.sleep(0.25)
    print("topmost: window not found")
    return False


# ----------------------------------------------------------------------- API
def route(path, body):
    if path == "init":
        return {"songs": songs, "settings": cfg, "state": engine.state()}
    if path == "state":
        return engine.state()
    if path == "songs/save":
        s = {
            k: body["song"].get(k, "" if k != "pos" else 0)
            for k in ("id", "title", "notes", "pos", "transcription")
        }
        for i, old in enumerate(songs):
            if old["id"] == s["id"]:
                songs[i] = s
                break
        else:
            songs.append(s)
        save_json(SONGS_FILE, songs)
        return {"ok": True}
    if path == "songs/delete":
        songs[:] = [s for s in songs if s["id"] != body["id"]]
        save_json(SONGS_FILE, songs)
        return {"ok": True}
    if path == "settings":
        merge_settings(body)
        out = dict(cfg)
        if "onTop" in body:
            out["topmostOk"] = apply_topmost(cfg["onTop"], tries=8)
        if any(k.startswith("click") for k in body):
            play_click()  # preview
        return out
    if path == "load":
        engine.load(body["steps"], body.get("index", 0))
    elif path == "arm":
        engine.armed = bool(body["armed"])
        if not engine.armed:
            for ev in list(engine.held.values()):
                ev.set()
    elif path == "seek":
        engine.seek(body["index"])
    elif path == "capture/start":
        engine.capturing = True
    elif path == "capture/cancel":
        engine.capturing = False
    elif path == "binds/remove":
        cfg["binds"] = [b for b in cfg["binds"] if b["sc"] != body["sc"]]
        save_cfg()
        engine.sync_blockers()
    elif path == "openfolder":
        os.startfile(DATA)
    return engine.state()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".otf": "font/otf",
        ".js": "text/javascript",
        ".css": "text/css",
    }

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _safe(self):
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return host.startswith("127.0.0.1:") and (
            origin is None or origin == f"http://{host}"
        )

    def _api(self, body):
        if not self._safe():
            self.send_error(403)
            return
        try:
            data = json.dumps(route(self.path[5:].split("?")[0], body)).encode()
            code = 200
        except Exception:
            traceback.print_exc()
            data, code = b'{"error":true}', 500
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._api({})
        elif self._safe():
            super().do_GET()
        else:
            self.send_error(403)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        self._api(body)


def find_browser():
    names = (
        "Microsoft/Edge/Application/msedge.exe",
        "Google/Chrome/Application/chrome.exe",
    )
    for name in names:
        for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
            root = os.environ.get(env)
            if root and (Path(root) / name).exists():
                return str(Path(root) / name)
    return None


def main():
    ctypes.windll.winmm.timeBeginPeriod(1)  # accurate sleeps (default is ~15 ms)
    keyboard.hook(engine.on_global)
    engine.sync_blockers()
    click_path(cfg["clickType"], cfg["clickVolume"])  # pre-build the click sound
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    exe = find_browser()
    if not exe:
        print("Edge/Chrome not found, opening default browser:", url)
        webbrowser.open(url)
        threading.Event().wait()
    proc = subprocess.Popen(
        [
            exe,
            f"--app={url}",
            f"--user-data-dir={DATA / 'profile'}",
            "--window-size=1000,680",
            "--no-first-run",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
        ]
    )
    if cfg["onTop"]:
        threading.Thread(target=apply_topmost, args=(True,), daemon=True).start()
    proc.wait()
    keyboard.unhook_all()
    os._exit(0)


if __name__ == "__main__":
    main()
