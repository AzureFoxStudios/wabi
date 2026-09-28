#!/usr/bin/env python3
"""Disposable loopback TCP byte meter for the three-site field harness.

The target is a private HTTP Authority endpoint. The process accepts only
loopback connections and reports counters on stdin requests; it never logs
request paths, headers, credentials, or body contents.
"""

import json
import select
import socket
import socketserver
import sys
import threading


TARGET = (sys.argv[1], int(sys.argv[2]))
COUNTERS = [0, 0]  # Anchor -> Authority, Authority -> Anchor.
COUNTER_LOCK = threading.Lock()


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.create_connection(TARGET, timeout=10) as upstream:
                upstream.settimeout(None)
                pair = (self.request, upstream)
                while True:
                    readable, _, _ = select.select(pair, [], [], 1)
                    for index, source in enumerate(pair):
                        if source not in readable:
                            continue
                        data = source.recv(65536)
                        if not data:
                            return
                        pair[1 - index].sendall(data)
                        with COUNTER_LOCK:
                            COUNTERS[index] += len(data)
        except OSError:
            # The Anchor receives the normal upstream disconnect/failure.
            return


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(('127.0.0.1', 0), Relay) as server:
    print(json.dumps({'event': 'bound', 'port': server.server_address[1]}), flush=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for line in sys.stdin:
        command = line.strip()
        if command == 'snapshot':
            with COUNTER_LOCK:
                print(json.dumps({'event': 'snapshot',
                                  'toAuthority': COUNTERS[0],
                                  'fromAuthority': COUNTERS[1]}), flush=True)
        elif command == 'stop':
            break
    server.shutdown()
