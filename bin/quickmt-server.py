#!/usr/bin/env python3
"""quickmt: a small local translation service for subtranslate step 2.

Loads CTranslate2 models once and answers HTTP on 127.0.0.1:8098:

    GET  /health              -> {"ok": true, ...}
    POST /translate {"lines": ["..."], "beam": 4} -> {"out": ["..."]}
    POST /back      {"lines": ["..."]}            -> {"out": ["..."]}

The en->ar model is loaded at startup so /health means "ready".  The ar->en
model is loaded on the first /back request, because back-translation is only
used to score candidates and costs another ~400 MB of RAM.

Everything stays on device.  Logs go to ~/quickmt.log.
"""

import argparse
import atexit
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
MODEL_ROOT = os.environ.get(
    "QUICKMT_MODELS", os.path.join(HOME, ".local", "share", "subtranslate", "models")
)
EN_AR_DIR = os.path.join(MODEL_ROOT, "quickmt-en-ar")
AR_EN_DIR = os.path.join(MODEL_ROOT, "quickmt-ar-en")
PORT = int(os.environ.get("QUICKMT_PORT", "8098"))
THREADS = int(os.environ.get("QUICKMT_THREADS", "4"))
BEAM = int(os.environ.get("QUICKMT_BEAM", "4"))
LOG_PATH = os.environ.get("QUICKMT_LOG", os.path.join(HOME, "quickmt.log"))
PID_PATH = os.environ.get(
    "QUICKMT_PID", os.path.join(HOME, ".config", "subgrab", "quickmt.pid")
)
MAX_LINES = 128
MAX_BYTES = 1 << 20


def log(message):
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > MAX_BYTES:
            os.replace(LOG_PATH, LOG_PATH + ".1")
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))
    except Exception:
        pass


class Model:
    def __init__(self, directory, label):
        self.directory = directory
        self.label = label
        self.lock = threading.Lock()
        self.translator = None
        self.source = None
        self.target = None
        self.compute_type = None

    def load(self):
        if self.translator is not None:
            return
        import ctranslate2
        import sentencepiece as spm

        src_path = os.path.join(self.directory, "src.spm.model")
        tgt_path = os.path.join(self.directory, "tgt.spm.model")
        if not (os.path.exists(src_path) and os.path.exists(tgt_path)):
            raise RuntimeError("model files missing in %s" % self.directory)

        self.source = spm.SentencePieceProcessor(model_file=src_path)
        self.target = spm.SentencePieceProcessor(model_file=tgt_path)

        last = None
        for compute_type in ("int8", "int8_float32", "float32"):
            try:
                self.translator = ctranslate2.Translator(
                    self.directory,
                    device="cpu",
                    compute_type=compute_type,
                    inter_threads=1,
                    intra_threads=THREADS,
                )
                self.compute_type = compute_type
                break
            except Exception as exc:  # int8 needs a compatible model
                last = exc
        if self.translator is None:
            raise last
        log("%s loaded compute_type=%s threads=%d" % (self.label, self.compute_type, THREADS))

    def translate(self, lines, beam):
        self.load()
        out = []
        for start in range(0, len(lines), MAX_LINES):
            chunk = lines[start : start + MAX_LINES]
            tokens = [self.source.encode(text, out_type=str) for text in chunk]
            with self.lock:
                results = self.translator.translate_batch(
                    tokens,
                    beam_size=beam,
                    max_batch_size=32,
                    batch_type="examples",
                    max_decoding_length=256,
                    replace_unknowns=True,
                )
            out.extend(self.target.decode(r.hypotheses[0]) for r in results)
        return out


en_ar = Model(EN_AR_DIR, "en-ar")
ar_en = Model(AR_EN_DIR, "ar-en")
ar_en_load = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "quickmt/1.0"

    def log_message(self, fmt, *args):
        log("%s %s" % (self.address_string(), fmt % args))

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self.send_json(
                200,
                {
                    "ok": True,
                    "pid": os.getpid(),
                    "port": PORT,
                    "en_ar": en_ar.translator is not None,
                    "ar_en": ar_en.translator is not None,
                    "threads": THREADS,
                },
            )
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ("/translate", "/back"):
            self.send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            self.send_json(400, {"error": "bad json: %s" % exc})
            return

        lines = payload.get("lines")
        if not isinstance(lines, list) or not all(isinstance(x, str) for x in lines):
            self.send_json(400, {"error": "lines must be a list of strings"})
            return

        try:
            beam = max(1, min(10, int(payload.get("beam", BEAM))))
        except Exception:
            beam = BEAM

        started = time.time()
        try:
            if path == "/translate":
                out = en_ar.translate(lines, beam)
            else:
                with ar_en_load:
                    ar_en.load()
                out = ar_en.translate(lines, beam)
        except Exception as exc:
            log("error %s: %s" % (path, exc))
            self.send_json(500, {"error": str(exc)})
            return

        self.send_json(
            200,
            {"out": out, "elapsed_ms": int((time.time() - started) * 1000)},
        )


def write_pid():
    try:
        os.makedirs(os.path.dirname(PID_PATH), exist_ok=True)
        with open(PID_PATH, "w", encoding="ascii") as fh:
            fh.write("%d\n" % os.getpid())
    except Exception:
        pass


def remove_pid():
    try:
        with open(PID_PATH, encoding="ascii") as fh:
            if int(fh.read().strip() or 0) == os.getpid():
                os.unlink(PID_PATH)
    except Exception:
        pass


def check():
    started = time.time()
    en_ar.load()
    load_s = time.time() - started
    lines = [
        "My name is Wolfgang and I live in Berlin.",
        "Close the door, please.",
        "We leave at dawn.",
    ]
    started = time.time()
    out = en_ar.translate(lines, BEAM)
    elapsed = time.time() - started
    rss = 0
    try:
        with open("/proc/self/status", encoding="ascii") as fh:
            for row in fh:
                if row.startswith("VmHWM:"):
                    rss = int(row.split()[1])
    except Exception:
        pass
    print(
        json.dumps(
            {
                "compute_type": en_ar.compute_type,
                "threads": THREADS,
                "beam": BEAM,
                "load_seconds": round(load_s, 2),
                "translate_seconds": round(elapsed, 3),
                "peak_rss_mb": round(rss / 1024, 1),
                "out": out,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def main():
    global PORT, THREADS, BEAM
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--threads", type=int, default=THREADS)
    parser.add_argument("--beam", type=int, default=BEAM)
    parser.add_argument("--check", action="store_true", help="load, translate 3 lines, exit")
    args = parser.parse_args()
    PORT, THREADS, BEAM = args.port, args.threads, args.beam

    if args.check:
        check()
        return 0

    log("starting on 127.0.0.1:%d threads=%d beam=%d" % (PORT, THREADS, BEAM))
    started = time.time()
    en_ar.load()
    log("ready in %.1fs" % (time.time() - started))

    write_pid()
    atexit.register(remove_pid)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        remove_pid()
    return 0


if __name__ == "__main__":
    sys.exit(main())
