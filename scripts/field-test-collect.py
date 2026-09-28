#!/usr/bin/env python3
"""Read-only Linux process-tree samples; JSONL stdout, no extra dependencies.

CPU percent is per logical CPU (100% = one fully occupied CPU). Interface
counters are host/interface scoped, not application traffic; never sum overlay
and physical interfaces as distinct payload. Raw output contains PIDs and
interface names but no command arguments, environment, addresses or payloads.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import time


def process_stat(pid):
    text = Path(f"/proc/{pid}/stat").read_text()
    fields = text[text.rfind(")") + 2:].split()
    return {
        "pid": pid, "ppid": int(fields[1]), "name": text[text.find("(")+1:text.rfind(")")], "start_ticks": int(fields[19]),
        "cpu_ticks": int(fields[11]) + int(fields[12]),
        "rss_bytes": int(fields[21]) * os.sysconf("SC_PAGE_SIZE"),
    }


def process_tree(root_pid):
    found = {}
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            found[int(path.name)] = process_stat(int(path.name))
        except (OSError, ValueError, IndexError):
            continue
    selected = {root_pid} if root_pid in found else set()
    while True:
        children = {pid for pid, stat in found.items() if stat["ppid"] in selected}
        added = children - selected
        if not added:
            break
        selected.update(added)
    return [found[pid] for pid in sorted(selected)]


def io_counters(pid):
    try:
        values = dict(line.split(": ", 1) for line in Path(f"/proc/{pid}/io").read_text().splitlines())
        return {key: int(values[key]) for key in ["read_bytes", "write_bytes", "rchar", "wchar"]}
    except (OSError, KeyError, ValueError) as error:
        return {"availability": "unavailable", "reason": type(error).__name__}


def interfaces():
    result = {}
    for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
        name, counters = line.split(":", 1)
        values = counters.split()
        result[name.strip()] = {"rx_bytes": int(values[0]), "tx_bytes": int(values[8])}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--samples", type=int, default=31)
    parser.add_argument("--interval", type=float, default=1)
    args = parser.parse_args()
    if args.pid <= 0 or args.samples < 1 or args.interval < 0.1:
        parser.error("positive PID/sample count and interval >= 0.1 required")
    previous, last_time, initial_identity = {}, None, None
    hz = os.sysconf("SC_CLK_TCK")
    started = time.monotonic()
    print(json.dumps({"kind": "metadata", "run_id": args.run_id,
        "sources": ["/proc/PID/stat", "/proc/PID/io", "/proc/net/dev", "/proc/loadavg"],
        "interval_seconds": args.interval, "cpu_percent_convention": "100 percent = one logical CPU",
        "memory_scope": "per-process RSS; summing may double-count shared pages",
        "network_scope": "host interfaces, not app-attributed; overlay/underlay must not be summed",
        "disk_scope": "per-process cumulative bytes; rchar/wchar include cached/syscall traffic",
        "gpu": "not collected", "media": "not collected", "clock": "UTC labels, monotonic durations"}), flush=True)
    for index in range(args.samples):
        time.sleep(max(0, started + index * args.interval - time.monotonic()))
        sample_start = time.monotonic()
        processes = process_tree(args.pid)
        root = next((p for p in processes if p["pid"] == args.pid), None)
        if initial_identity is None and root is not None:
            initial_identity = root["start_ticks"]
        alive = root is not None and root["start_ticks"] == initial_identity
        if not alive:
            processes = []
        current = {}
        for stat in processes:
            key = (stat["pid"], stat["start_ticks"])
            old = previous.get(key)
            stat["cpu_percent"] = None if old is None or last_time is None else max(0, (stat["cpu_ticks"] - old) / hz / (sample_start - last_time) * 100)
            stat["io"] = io_counters(stat["pid"])
            current[key] = stat["cpu_ticks"]
        record = {"kind": "sample", "run_id": args.run_id, "index": index,
            "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "monotonic_seconds": sample_start, "elapsed_seconds": sample_start - started,
            "root_alive": alive, "processes": processes, "interfaces": interfaces(),
            "host_loadavg": Path("/proc/loadavg").read_text().split()[:3]}
        record["collector_read_seconds"] = time.monotonic() - sample_start
        print(json.dumps(record), flush=True)
        previous, last_time = current, sample_start


if __name__ == "__main__":
    main()
