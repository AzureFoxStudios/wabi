#!/usr/bin/env python3
"""WebKitGTK media capability probe.

Loads probe.js in a WebKit2 4.1 webview (the engine Tauri/wry uses on Linux)
with a chosen combination of settings and permission handling, and writes the
result as JSON. It stands in for the desktop shell: same engine, the
`tauri://localhost` origin registered as secure, and the app's CSP.

Needs PyGObject with the WebKit2 4.1, Gtk 3 and Soup 3 typelibs, and (for the
relay and memory modes) `npm ci` in frontend/ so opus-recorder is present.

Headless, nothing on screen:
    WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -- \
        python3 probe.py --origin tauri --csp --permissions allow --out /tmp/matrix.json

Modes (--mode): matrix (capability table), relay (Wabi's relay audio path with
the production encoder, decoder and playback worklet), mem (process-tree memory
idle / in a voice call / with video), glmem (cost of a WebGL context), gesture
(screen share through a synthesised click; opens the desktop's screen picker).

Do not run the camera or gesture paths with nobody at the machine: the desktop
shows a prompt, and an unanswered camera prompt is stored as a refusal.
Results and what they meant: docs/plans/2026-11-20-linux-desktop-media.md.
"""
import argparse
import http.server
import json
import os
import sys
import threading

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("Soup", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Soup, WebKit2  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
# The CSP the desktop app ships in src-tauri/tauri.conf.json.
APP_CSP = (
    "default-src 'self'; connect-src 'self' ws: wss: http: https:; "
    "img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; "
    "style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:"
)
FILES = {
    "/": ("text/html", b"<!doctype html><meta charset=utf-8><title>probe</title><body><script src=\"/probe.js\"></script>"),
    "/probe.js": ("application/javascript", open(os.path.join(HERE, "probe.js"), "rb").read()),
    "/worklet.js": ("application/javascript", open(os.path.join(HERE, "worklet.js"), "rb").read()),
}
# Production relay pieces, read straight from the checkout (read-only).
WABI_FRONTEND = os.path.normpath(os.path.join(HERE, "..", "..", "frontend"))
for _served, _source, _mime in (
    ("/_app/recorder.min.js", "node_modules/opus-recorder/dist/recorder.min.js", "application/javascript"),
    ("/_app/encoderWorker.min.js", "node_modules/opus-recorder/dist/encoderWorker.min.js", "application/javascript"),
    ("/_app/decoderWorker.min.js", "node_modules/opus-recorder/dist/decoderWorker.min.js", "application/javascript"),
    ("/_app/decoderWorker.min.wasm", "node_modules/opus-recorder/dist/decoderWorker.min.wasm", "application/wasm"),
    ("/_app/audio-worklet-playback.js", "src/lib/audio-worklet-playback.js", "application/javascript"),
):
    try:
        FILES[_served] = (_mime, open(os.path.join(WABI_FRONTEND, _source), "rb").read())
    except OSError:
        pass


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--origin", choices=["http", "tauri"], default="tauri")
    p.add_argument("--media-stream", choices=["default", "on", "off"], default="default")
    p.add_argument("--webrtc", choices=["default", "on", "off"], default="default")
    p.add_argument("--permissions", choices=["unhandled", "allow", "deny"], default="unhandled")
    p.add_argument("--mock", action="store_true")
    p.add_argument("--csp", action="store_true")
    p.add_argument("--mode", choices=["matrix", "gesture", "relay", "mem", "glmem"], default="matrix")
    p.add_argument("--gesture-audio", action="store_true")
    p.add_argument("--wait", type=int, default=20000)
    p.add_argument("--skip", default="")
    p.add_argument("--hw", default="")
    p.add_argument("--stress", action="store_true")
    p.add_argument("--webgl", action="store_true")
    p.add_argument("--timeout", type=int, default=240)
    p.add_argument("--out", required=True)
    return p.parse_args()


def tree_pss():
    """Proportional set size (kB) of this process and every descendant."""
    children, names = {}, {}
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/stat") as fh:
                stat = fh.read()
        except OSError:
            continue
        close = stat.rfind(")")
        names[int(pid)] = stat[stat.find("(") + 1:close]
        children.setdefault(int(stat[close + 2:].split()[1]), []).append(int(pid))
    out, stack = {}, [os.getpid()]
    while stack:
        pid = stack.pop()
        try:
            with open(f"/proc/{pid}/smaps_rollup") as fh:
                for line in fh:
                    if line.startswith("Pss:"):
                        out[f"{names.get(pid, '?')}:{pid}"] = int(line.split()[1])
                        break
        except OSError:
            out[f"{names.get(pid, '?')}:{pid}"] = None
        stack.extend(children.get(pid, []))
    return out


def main():
    args = parse()
    log = {"args": vars(args), "permissionRequests": [], "console": [], "progress": []}
    result = {"harness": log, "result": None}

    def finish(reason):
        log["finish"] = reason
        with open(args.out, "w") as fh:
            json.dump(result, fh, indent=2, default=str)
        Gtk.main_quit()

    data_manager = WebKit2.WebsiteDataManager.new_ephemeral()
    context = WebKit2.WebContext.new_with_website_data_manager(data_manager)

    if args.origin == "tauri":
        # Same registration wry performs for Tauri's custom protocol.
        context.get_security_manager().register_uri_scheme_as_secure("tauri")

        def on_scheme(request):
            path = request.get_path() or "/"
            mime, body = FILES.get(path, ("text/plain", b"not found"))
            stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(body))
            response = WebKit2.URISchemeResponse.new(stream, len(body))
            response.set_content_type(mime)
            headers = Soup.MessageHeaders.new(Soup.MessageHeadersType.RESPONSE)
            if args.csp:
                headers.append("Content-Security-Policy", APP_CSP)
            response.set_http_headers(headers)
            response.set_status(200 if path in FILES else 404, None)
            request.finish_with_response(response)

        context.register_uri_scheme("tauri", on_scheme)
        base = "tauri://localhost/"
    else:
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                path = self.path.split("?")[0]
                mime, body = FILES.get(path, ("text/plain", b"not found"))
                self.send_response(200 if path in FILES else 404)
                self.send_header("Content-Type", mime)
                if args.csp:
                    self.send_header("Content-Security-Policy", APP_CSP)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/"

    ucm = WebKit2.UserContentManager()
    ucm.register_script_message_handler("probe")
    view = WebKit2.WebView(web_context=context, user_content_manager=ucm)

    settings = view.get_settings()
    # What wry 0.54 sets on Linux.
    settings.set_enable_webgl(True)
    settings.set_enable_webaudio(True)
    settings.set_enable_write_console_messages_to_stdout(False)
    if args.media_stream != "default":
        settings.set_enable_media_stream(args.media_stream == "on")
    if args.webrtc != "default":
        settings.set_enable_webrtc(args.webrtc == "on")
    if args.mock:
        settings.set_enable_mock_capture_devices(True)
    log["effectiveSettings"] = {
        "enable-media-stream": settings.get_enable_media_stream(),
        "enable-webrtc": settings.get_enable_webrtc(),
        "enable-mock-capture-devices": settings.get_enable_mock_capture_devices(),
    }
    log["webkit"] = f"{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}"

    def on_permission(_view, request):
        entry = {"type": type(request).__name__}
        if isinstance(request, WebKit2.UserMediaPermissionRequest):
            entry["audio"] = request.props.is_for_audio_device
            entry["video"] = request.props.is_for_video_device
            try:
                entry["display"] = WebKit2.user_media_permission_is_for_display_device(request)
                entry["audioAndVideo"] = WebKit2.user_media_permission_is_for_audio_device(request) and WebKit2.user_media_permission_is_for_video_device(request)
            except Exception as error:  # noqa: BLE001
                entry["displayErr"] = str(error)
        entry["action"] = args.permissions
        log["permissionRequests"].append(entry)
        if args.permissions == "allow":
            request.allow()
            return True
        if args.permissions == "deny":
            request.deny()
            return True
        return False  # unhandled: WebKit's default applies (what the app does today)

    view.connect("permission-request", on_permission)

    def on_query_permission(_view, query):
        entry = {"type": "PermissionStateQuery", "name": query.get_name(), "action": args.permissions}
        log["permissionRequests"].append(entry)
        if args.permissions == "allow":
            query.finish(WebKit2.PermissionState.GRANTED)
            return True
        return False

    try:
        view.connect("query-permission-state", on_query_permission)
    except Exception as error:  # noqa: BLE001
        log["queryPermissionSignal"] = str(error)

    def on_message(_ucm, js_result):
        try:
            message = json.loads(js_result.get_js_value().to_string())
        except Exception as error:  # noqa: BLE001
            log["console"].append(f"bad message: {error}")
            return
        kind = message.get("kind")
        if kind == "progress":
            name = message["payload"]["name"]
            log["progress"].append(name)
            result.setdefault("partial", {})[name] = message["payload"].get("value")
            print(f"[probe] {name}", file=sys.stderr, flush=True)
        elif kind == "ready":
            print("[probe] ready, synthesising click", file=sys.stderr, flush=True)
            GLib.timeout_add(600, click)
        elif kind == "sample":
            log.setdefault("memory", []).append({"label": message["payload"]["label"], "pss_kb": tree_pss()})
            print(f"[probe] sample {message['payload']['label']}", file=sys.stderr, flush=True)
        elif kind == "done":
            result["result"] = message["payload"]
            finish("done")

    ucm.connect("script-message-received::probe", on_message)

    def click():
        window_gdk = view.get_window()
        if window_gdk is None:
            log["click"] = "no gdk window"
            return False
        seat = Gdk.Display.get_default().get_default_seat()
        pointer = seat.get_pointer()
        for kind in (Gdk.EventType.BUTTON_PRESS, Gdk.EventType.BUTTON_RELEASE):
            event = Gdk.Event.new(kind)
            event.button.window = window_gdk
            event.button.send_event = 1
            event.button.time = Gdk.CURRENT_TIME
            event.button.x = 200
            event.button.y = 200
            event.button.x_root = 200
            event.button.y_root = 200
            event.button.button = 1
            event.button.state = 0
            event.set_device(pointer)
            Gtk.main_do_event(event)
        log["click"] = "sent"
        return False

    def on_load_failed(_view, _event, uri, error):
        log["console"].append(f"load failed {uri}: {error.message}")
        return False

    view.connect("load-failed", on_load_failed)

    def on_process_terminated(_view, reason):
        log["console"].append(f"web process terminated: {reason}")
        finish("web-process-terminated")

    view.connect("web-process-terminated", on_process_terminated)

    window = Gtk.Window(title="Wabi media probe")
    window.set_default_size(640, 480)
    window.add(view)
    window.connect("destroy", lambda *_: finish("window-closed"))
    window.show_all()
    window.present()
    view.grab_focus()

    query = f"?mode={args.mode}&audio={'1' if args.gesture_audio else '0'}&wait={args.wait}&skip={args.skip}&hw={args.hw}&stress={'1' if args.stress else '0'}&webgl={'1' if args.webgl else '0'}"
    view.load_uri(base + query)

    sizes = [(640, 480), (900, 600), (500, 400), (1000, 700), (700, 500)]
    state = {"i": 0}

    def resize():
        state["i"] += 1
        w, h = sizes[state["i"] % len(sizes)]
        window.resize(w, h)
        log["resizes"] = state["i"]
        return True

    if args.stress:
        GLib.timeout_add(400, resize)

    def on_timeout():
        finish("harness-timeout")
        return False

    GLib.timeout_add_seconds(args.timeout, on_timeout)
    Gtk.main()


if __name__ == "__main__":
    main()
