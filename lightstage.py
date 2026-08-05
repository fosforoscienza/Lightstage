#!/usr/bin/env python3
"""LightStage — controllo essenziale per fari DMX UkFog UV+RGB a 8 canali.

Avvio:  python lightstage.py
Poi apri http://127.0.0.1:8123 nel browser (si apre da solo).

Il segnale DMX viene inviato in continuo su un cavo USB-DMX di tipo
FTDI / Open DMX (250000 baud, 8N2, break prima di ogni frame).
Senza cavo collegato l'app funziona comunque in modalità anteprima.
"""

import atexit
import json
import os
import re
import socket
import sys
import threading
import time
import webbrowser

from flask import Flask, jsonify, request

try:
    import serial
    from serial.tools import list_ports
except ImportError:  # pyserial assente: solo anteprima
    serial = None
    list_ports = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SHOW_FILE = os.path.join(BASE_DIR, "show.json")
HOST = "0.0.0.0"  # raggiungibile anche da telefoni/PC sulla stessa rete
PORT = 8123
NUM_PRESETS = 10
NUM_CHANNELS = 8
MAX_ADDRESS = 512 - NUM_CHANNELS + 1  # 505
DMX_FPS = 30

# Layout tipico dei fari UkFog UV+RGB a 8 canali: modificabile
# dall'interfaccia (pulsante "Canali") se il tuo modello è diverso.
DEFAULT_CHANNELS = [
    {"label": "Dimmer", "role": "dimmer"},
    {"label": "Rosso", "role": "red"},
    {"label": "Verde", "role": "green"},
    {"label": "Blu", "role": "blue"},
    {"label": "UV", "role": "uv"},
    {"label": "Strobo", "role": "other"},
    {"label": "Macro", "role": "other"},
    {"label": "Velocità", "role": "other"},
]
ROLES = {"dimmer", "red", "green", "blue", "uv", "white", "other"}

app = Flask(__name__, static_folder="static", static_url_path="")

lock = threading.RLock()
show = {
    "next_id": 1,
    "fixtures": [],  # {id, name, address, values[8], x, y, rot}
    "presets": [None] * NUM_PRESETS,  # {name, values: {id: [8]}}
    "channels": [dict(c) for c in DEFAULT_CHANNELS],
    "blackout": False,
}
_dirty = threading.Event()


# ---------------------------------------------------------------- uscita DMX
class DmxSender(threading.Thread):
    """Invia il frame DMX in loop continuo sulla porta seriale."""

    def __init__(self):
        super().__init__(daemon=True)
        self._frame = bytes(513)  # byte 0 = start code
        self._frame_lock = threading.Lock()
        self._serial = None
        self.port = None
        self.error = None

    def set_frame(self, frame):
        with self._frame_lock:
            self._frame = bytes(frame)

    WRITE_TIMEOUT_HINT = (
        "la porta non accetta dati (write timeout): quasi sicuramente non è "
        "il cavo USB-DMX. Scegli la porta del cavo — 'USB Serial Port (COMx)' "
        "su Windows, /dev/ttyUSB0 su Linux, /dev/cu.usbserial-… su Mac — e "
        "non una porta interna (ttyS0/COM1) o Bluetooth."
    )

    def connect(self, port):
        if serial is None:
            self.error = "pyserial non installato (pip install pyserial)"
            return False
        self.disconnect()
        ser = None
        try:
            ser = serial.Serial(
                port,
                baudrate=250000,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_TWO,
                timeout=1,
                write_timeout=1,
                xonxoff=False,
                rtscts=False,
                dsrdtr=False,
            )
            try:
                ser.rts = False
                ser.dtr = False
            except Exception:
                pass
            ser.reset_output_buffer()
            # frame di prova: se la porta non trasmette meglio scoprirlo subito
            ser.break_condition = True
            time.sleep(0.001)
            ser.break_condition = False
            time.sleep(0.0001)
            ser.write(bytes(513))
        except serial.SerialTimeoutException:
            if ser is not None:
                try:
                    ser.close()
                except Exception:
                    pass
            self.error = self.WRITE_TIMEOUT_HINT
            return False
        except Exception as exc:
            if ser is not None:
                try:
                    ser.close()
                except Exception:
                    pass
            self.error = str(exc)
            return False
        self._serial = ser
        self.port = port
        self.error = None
        return True

    def disconnect(self):
        ser = self._serial
        self._serial = None
        self.port = None
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass

    @property
    def connected(self):
        return self._serial is not None

    def run(self):
        while True:
            ser = self._serial
            if ser is None:
                time.sleep(0.2)
                continue
            with self._frame_lock:
                frame = self._frame
            try:
                ser.break_condition = True
                time.sleep(0.001)  # break (minimo 88 µs)
                ser.break_condition = False
                time.sleep(0.0001)  # mark after break
                ser.write(frame)
            except Exception as exc:
                if serial is not None and isinstance(exc, serial.SerialTimeoutException):
                    self.error = self.WRITE_TIMEOUT_HINT
                else:
                    self.error = f"errore sulla porta: {exc}"
                self.disconnect()
                continue
            time.sleep(max(0.0, 1.0 / DMX_FPS - 0.003))


dmx = DmxSender()


def rebuild_universe():
    """Ricostruisce il frame DMX dai valori dei fari (merge HTP se sovrapposti)."""
    frame = bytearray(513)
    if not show["blackout"]:
        for f in show["fixtures"]:
            for i, v in enumerate(f["values"]):
                ch = f["address"] + i
                if 1 <= ch <= 512:
                    frame[ch] = max(frame[ch], v)
    dmx.set_frame(frame)


# -------------------------------------------------------------- persistenza
def sanitize_values(raw):
    vals = [0] * NUM_CHANNELS
    if isinstance(raw, list):
        for i in range(min(NUM_CHANNELS, len(raw))):
            try:
                vals[i] = max(0, min(255, int(raw[i])))
            except (TypeError, ValueError):
                pass
    return vals


def load_show():
    if not os.path.exists(SHOW_FILE):
        return
    try:
        with open(SHOW_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:
        print(f"Attenzione: show.json non leggibile ({exc}), riparto da zero.")
        return
    fixtures = []
    for f in data.get("fixtures", []):
        try:
            fixtures.append({
                "id": int(f["id"]),
                "name": str(f.get("name", "Faro"))[:24],
                "address": max(1, min(MAX_ADDRESS, int(f.get("address", 1)))),
                "values": sanitize_values(f.get("values")),
                "x": max(0.0, min(1.0, float(f.get("x", 0.5)))),
                "y": max(0.0, min(1.0, float(f.get("y", 0.2)))),
                "rot": float(f.get("rot", 0)) % 360,
            })
        except (KeyError, TypeError, ValueError):
            continue
    presets = [None] * NUM_PRESETS
    for i, p in enumerate(data.get("presets", [])[:NUM_PRESETS]):
        if isinstance(p, dict) and "values" in p:
            presets[i] = {
                "name": str(p.get("name", f"Preset {i + 1}"))[:24],
                "values": {
                    str(k): sanitize_values(v)
                    for k, v in dict(p["values"]).items()
                },
            }
    channels = []
    for i, c in enumerate(data.get("channels", [])[:NUM_CHANNELS]):
        label = str(c.get("label", f"CH{i + 1}"))[:16] if isinstance(c, dict) else f"CH{i + 1}"
        role = c.get("role") if isinstance(c, dict) else "other"
        channels.append({"label": label, "role": role if role in ROLES else "other"})
    while len(channels) < NUM_CHANNELS:
        channels.append(dict(DEFAULT_CHANNELS[len(channels)]))
    show["fixtures"] = fixtures
    show["presets"] = presets
    show["channels"] = channels
    show["blackout"] = bool(data.get("blackout", False))
    show["next_id"] = max([f["id"] for f in fixtures], default=0) + 1


def write_show():
    with lock:
        data = json.dumps(show, ensure_ascii=False, indent=2)
    tmp = SHOW_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(data)
    os.replace(tmp, SHOW_FILE)


def mark_dirty():
    _dirty.set()


def _saver():
    """Salva show.json al massimo una volta al secondo."""
    while True:
        _dirty.wait()
        time.sleep(1.0)
        _dirty.clear()
        try:
            write_show()
        except Exception as exc:
            print(f"Errore nel salvataggio di show.json: {exc}")


# ----------------------------------------------------------------- endpoint
def dmx_state():
    ports = []
    if list_ports is not None:
        detected = sorted(list_ports.comports(), key=lambda p: p.device)
        devices = {p.device for p in detected}
        for p in detected:
            # su macOS ogni porta compare due volte: usa /dev/cu.*, non /dev/tty.*
            if p.device.startswith("/dev/tty.") and \
                    p.device.replace("/dev/tty.", "/dev/cu.", 1) in devices:
                continue
            info = " ".join(filter(None, [p.device, p.description,
                                          p.manufacturer, getattr(p, "product", None)]))
            likely = (
                bool(re.search(r"ftdi|ft232|usb|dmx|ch340|cp210|serial", info, re.I))
                and not re.search(r"bluetooth", info, re.I)
                and not re.match(r"^(/dev/ttyS\d|COM1$)", p.device)
            )
            ports.append({
                "device": p.device,
                "description": p.description or "n/a",
                "likely": likely,
            })
        ports.sort(key=lambda p: (not p["likely"], p["device"]))
    return {
        "available": serial is not None,
        "connected": dmx.connected,
        "port": dmx.port,
        "error": dmx.error,
        "ports": ports,
    }


def find_fixture(fid):
    for f in show["fixtures"]:
        if f["id"] == fid:
            return f
    return None


@app.get("/")
def index():
    return app.send_static_file("index.html")


def lan_url():
    """URL da usare da telefoni/altri computer sulla stessa rete."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # nessun dato inviato: serve solo l'IP locale
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        return None
    if ip.startswith("127."):
        return None
    return f"http://{ip}:{PORT}"


@app.get("/api/state")
def get_state():
    with lock:
        return jsonify({
            "fixtures": show["fixtures"],
            "presets": show["presets"],
            "channels": show["channels"],
            "blackout": show["blackout"],
            "dmx": dmx_state(),
            "lan_url": lan_url(),
        })


@app.post("/api/fixtures")
def add_fixture():
    body = request.get_json(silent=True) or {}
    with lock:
        fid = show["next_id"]
        show["next_id"] += 1
        try:
            address = max(1, min(MAX_ADDRESS, int(body.get("address", 1))))
        except (TypeError, ValueError):
            address = 1
        fixture = {
            "id": fid,
            "name": str(body.get("name") or f"Faro {fid}")[:24],
            "address": address,
            "values": sanitize_values(body.get("values")),
            "x": max(0.0, min(1.0, float(body.get("x", 0.5)))),
            "y": max(0.0, min(1.0, float(body.get("y", 0.2)))),
            "rot": float(body.get("rot", 0)) % 360,
        }
        show["fixtures"].append(fixture)
        rebuild_universe()
        mark_dirty()
        return jsonify({"fixture": fixture})


@app.put("/api/fixtures/<int:fid>")
def update_fixture(fid):
    body = request.get_json(silent=True) or {}
    with lock:
        f = find_fixture(fid)
        if f is None:
            return jsonify({"error": "faro non trovato"}), 404
        if "name" in body:
            f["name"] = str(body["name"])[:24] or f["name"]
        if "address" in body:
            try:
                f["address"] = max(1, min(MAX_ADDRESS, int(body["address"])))
            except (TypeError, ValueError):
                pass
        for key in ("x", "y"):
            if key in body:
                try:
                    f[key] = max(0.0, min(1.0, float(body[key])))
                except (TypeError, ValueError):
                    pass
        if "rot" in body:
            try:
                f["rot"] = float(body["rot"]) % 360
            except (TypeError, ValueError):
                pass
        rebuild_universe()
        mark_dirty()
        return jsonify({"fixture": f})


@app.put("/api/fixtures/<int:fid>/values")
def update_values(fid):
    body = request.get_json(silent=True) or {}
    with lock:
        f = find_fixture(fid)
        if f is None:
            return jsonify({"error": "faro non trovato"}), 404
        f["values"] = sanitize_values(body.get("values"))
        rebuild_universe()
        mark_dirty()
        return jsonify({"fixture": f})


@app.delete("/api/fixtures/<int:fid>")
def delete_fixture(fid):
    with lock:
        f = find_fixture(fid)
        if f is None:
            return jsonify({"error": "faro non trovato"}), 404
        show["fixtures"].remove(f)
        for p in show["presets"]:
            if p is not None:
                p["values"].pop(str(fid), None)
        rebuild_universe()
        mark_dirty()
        return jsonify({"ok": True})


@app.post("/api/presets/<int:slot>")
def save_preset(slot):
    if not 0 <= slot < NUM_PRESETS:
        return jsonify({"error": "slot non valido"}), 400
    body = request.get_json(silent=True) or {}
    with lock:
        show["presets"][slot] = {
            "name": str(body.get("name") or f"Preset {slot + 1}")[:24],
            "values": {str(f["id"]): list(f["values"]) for f in show["fixtures"]},
        }
        mark_dirty()
        return jsonify({"presets": show["presets"]})


@app.post("/api/presets/<int:slot>/load")
def load_preset(slot):
    with lock:
        if not 0 <= slot < NUM_PRESETS or show["presets"][slot] is None:
            return jsonify({"error": "preset vuoto"}), 404
        values = show["presets"][slot]["values"]
        for f in show["fixtures"]:
            saved = values.get(str(f["id"]))
            if saved is not None:
                f["values"] = sanitize_values(saved)
        rebuild_universe()
        mark_dirty()
        return jsonify({"fixtures": show["fixtures"]})


@app.delete("/api/presets/<int:slot>")
def delete_preset(slot):
    if not 0 <= slot < NUM_PRESETS:
        return jsonify({"error": "slot non valido"}), 400
    with lock:
        show["presets"][slot] = None
        mark_dirty()
        return jsonify({"presets": show["presets"]})


@app.put("/api/channels")
def update_channels():
    body = request.get_json(silent=True) or {}
    raw = body.get("channels")
    if not isinstance(raw, list) or len(raw) != NUM_CHANNELS:
        return jsonify({"error": "servono 8 canali"}), 400
    channels = []
    for i, c in enumerate(raw):
        label = str(c.get("label") or f"CH{i + 1}")[:16]
        role = c.get("role") if c.get("role") in ROLES else "other"
        channels.append({"label": label, "role": role})
    with lock:
        show["channels"] = channels
        mark_dirty()
        return jsonify({"channels": channels})


@app.put("/api/blackout")
def set_blackout():
    body = request.get_json(silent=True) or {}
    with lock:
        show["blackout"] = bool(body.get("on"))
        rebuild_universe()
        mark_dirty()
        return jsonify({"blackout": show["blackout"]})


@app.get("/api/dmx")
def get_dmx():
    return jsonify(dmx_state())


@app.post("/api/dmx/connect")
def dmx_connect():
    body = request.get_json(silent=True) or {}
    port = body.get("port")
    if not port:
        return jsonify({"error": "porta mancante", **dmx_state()}), 400
    dmx.connect(str(port))
    return jsonify(dmx_state())


@app.post("/api/dmx/disconnect")
def dmx_disconnect():
    dmx.disconnect()
    return jsonify(dmx_state())


# --------------------------------------------------------------------- main
def main():
    load_show()
    with lock:
        rebuild_universe()
    dmx.start()
    threading.Thread(target=_saver, daemon=True).start()
    atexit.register(write_show)
    local = f"http://127.0.0.1:{PORT}"
    print(f"LightStage in esecuzione  (Ctrl+C per uscire)")
    print(f"  Su questo computer:                {local}")
    remote = lan_url()
    if remote:
        print(f"  Da telefoni/PC sulla stessa rete:  {remote}")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(local)).start()
    app.run(host=HOST, port=PORT, debug=False, threaded=True)


if __name__ == "__main__":
    main()
