import os
import re

root = "src"
for dirpath, _, files in os.walk(root):
    for f in files:
        if not f.endswith(".svelte"):
            continue
        path = os.path.join(dirpath, f)
        src = open(path, encoding="utf-8").read()
        props = set(re.findall(r"export\s+let\s+(\w+)", src))
        dollars = set(re.findall(r"\$([A-Za-z_][A-Za-z0-9_]*)", src))
        skip = {
            "props",
            "state",
            "derived",
            "effect",
            "bindable",
            "host",
            "inspect",
            "lib",
            "app",
            "env",
        }
        overlap = sorted(name for name in props.intersection(dollars) if name not in skip)
        if overlap:
            print(f"{path}: {overlap}")
