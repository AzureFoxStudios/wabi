#!/usr/bin/env python3
"""Reject tracked operator state by pathname without reading sensitive contents."""
import pathlib
import subprocess
import sys


def is_runtime_file(name):
    path = pathlib.PurePosixPath(name)
    parts = path.parts
    # This source-controlled word list is shipped application data.
    if name == 'core/crates/wabi-server/data/blacklist.txt':
        return False
    if any(part in {'data', 'uploads'} for part in parts[:-1]):
        return True
    base = path.name
    if base in {'jwt_secret', 'root_key', 'server_owner.json'}:
        return True
    if base == '.env' or base.startswith('.env.') or '.env.' in base or base.endswith('.env'):
        return not base.endswith('.example')
    return False


def main():
    result = subprocess.run(['git', 'ls-files', '-z'], check=True, capture_output=True)
    names = result.stdout.decode('utf-8', errors='surrogateescape').split('\0')
    rejected = [name for name in names if name and is_runtime_file(name)]
    for name in rejected:
        print(f'Operator runtime file is tracked: {name!r}', file=sys.stderr)
    if rejected:
        print('Preserve local data; remove it from the Git index before continuing.', file=sys.stderr)
        return 1
    print('Tracked runtime-file guard passed (pathnames only; not a history or content audit).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
