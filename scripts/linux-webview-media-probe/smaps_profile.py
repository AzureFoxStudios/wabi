#!/usr/bin/env python3
"""PSS of a process tree, split by process and by kind of mapping. Usage: smaps_profile.py ROOT_PID LABEL OUT.json [--exclude NAME ...]"""
import json, os, re, sys
root, label, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
exclude = sys.argv[5:] if len(sys.argv) > 4 and sys.argv[4] == '--exclude' else []

def children(pid):
    kids = []
    for task in os.listdir(f'/proc/{pid}/task'):
        try: kids += [int(x) for x in open(f'/proc/{pid}/task/{task}/children').read().split()]
        except OSError: pass
    return kids
def tree(pid):
    pids = [pid]
    for kid in children(pid): pids += tree(kid)
    return pids
def kind(name):
    if not name or name.startswith('[anon'): return 'anonymous'
    if name == '[heap]': return 'heap'
    if name.startswith('[stack'): return 'stack'
    if name.startswith('['): return name
    if 'nvidia' in name.lower(): return 'nvidia: ' + os.path.basename(name).split('.so')[0]
    if name.startswith('/dev/'): return 'device: ' + name
    if name.startswith('/memfd:') or '(deleted)' in name or name.startswith('/SYSV') or '/dev/shm' in name: return 'shared memory: ' + re.sub(r'[0-9a-f]{6,}|\d+', '#', name.split(' ')[0])[:40]
    base = os.path.basename(name)
    if '.so' in base: return 'lib: ' + base.split('.so')[0]
    return 'file: ' + base[:48]
procs = []
for pid in tree(root):
    try:
        cmd = open(f'/proc/{pid}/cmdline').read().split('\0')
        name = os.path.basename(cmd[0]) if cmd and cmd[0] else open(f'/proc/{pid}/comm').read().strip()
        if any(x in name for x in exclude): continue
        kinds, cur = {}, None
        for line in open(f'/proc/{pid}/smaps'):
            m = re.match(r'^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+\s*(.*)$', line)
            if m: cur = kind(m.group(1).strip()); continue
            if line.startswith('Pss:'): kinds[cur] = kinds.get(cur, 0) + int(line.split()[1])
        procs.append({'pid': pid, 'name': name, 'pss_kb': sum(kinds.values()), 'kinds': kinds})
    except (OSError, PermissionError): pass
total = sum(p['pss_kb'] for p in procs)
json.dump({'label': label, 'total_kb': total, 'processes': procs}, open(out, 'w'), indent=1)
print(f'{label}: {total/1024:.1f} MB')
for p in sorted(procs, key=lambda p: -p['pss_kb']):
    if p['pss_kb'] < 1024: continue
    top = sorted(p['kinds'].items(), key=lambda kv: -kv[1])[:10]
    print(f"  {p['name']:<28} {p['pss_kb']/1024:7.1f} MB   " + ', '.join(f'{k} {v/1024:.1f}' for k, v in top))
