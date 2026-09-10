"""Disposable integration candidate. Never updates a remote branch or main."""
import json
import os
import pathlib
import subprocess
import urllib.request

OUT = pathlib.Path(os.environ['RUNNER_TEMP']) / 'pr-audit'
OUT.mkdir(exist_ok=True)
REPO = os.environ['GITHUB_REPOSITORY']
EXPECTED = {
    158: '31bcf2becc7cbc5360bcef7d468ebb23c707089b',
    159: '18626a98615726494b86322c0b283956942afd3d',
    160: 'c18006e1651869a78225408735a99774f8c96af4',
    161: 'e06fc0353d3354f7c18f8f9f935f6ac3898076f0',
    162: 'e6a6e26055f1993691b8d4e4401e1c7852d1ba95',
    163: '65e34994e784ebf00fd95a16c0a5d5db23867fcb',
    164: '6a1e7ebd59370444959b7a6b223f2cb1b08ad69e',
    165: 'f705db9ee7eefe17a52382be24416aae7cc46f18',
    166: 'e9d9ac535d17d58ed278a9aff4a34c168366ba89',
    167: '5ac417d62c04f82a89553e45493a5d429ebf1a49',
    168: 'c05b202a0575b59e4d7d6e9391ba3ea13a1f4496',
    169: '65d71a70cfae5feb33ed5c30573eb9b4dc479ddf',
    170: '799d707daa459085e3b370df94d9964aed33afa1',
    171: '242b4f53ef288c4848ba7766306aa05ffda29da3',
    172: '46119885b23445d50c475375018342fe76aa7b5c',
    173: 'c006b4b5ae189b76a96a5c103560f0425a581c22',
    175: 'f7bcf490cd6df56a63e2a464cf77ff09fd162ef6',
    179: 'ec715a636be6f0b8f93f85b475dad034cd199762',
}

def api(path):
    request = urllib.request.Request('https://api.github.com/repos/' + REPO + '/' + path,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)

def git(*args, check=True):
    return subprocess.run(['git', *args], check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

MISSING = object()
def merge_json(base, ours, theirs, path=''):
    """Three-way merge by JSON key, refusing actual conflicting value edits.

    This only resolves adjacent-line conflicts in the two reviewed npm files.
    Arrays and package integrity strings are values, never concatenated/guessed.
    """
    if ours == theirs or theirs == base:
        return ours
    if ours == base:
        return theirs
    if all(isinstance(value, dict) for value in (base, ours, theirs)):
        result = {}
        for key in dict.fromkeys([*ours, *theirs, *base]):
            value = merge_json(base.get(key, MISSING), ours.get(key, MISSING),
                               theirs.get(key, MISSING), path + '/' + key)
            if value is not MISSING:
                result[key] = value
        return result
    raise ValueError('Both sides changed the same JSON value: ' + path)

# Prove the resolver retains unrelated edits and refuses differing same-key edits.
assert merge_json({'a': 1, 'b': 1}, {'a': 2, 'b': 1}, {'a': 1, 'b': 3}) == {'a': 2, 'b': 3}
try:
    merge_json({'a': 1}, {'a': 2}, {'a': 3})
except ValueError:
    pass
else:
    raise AssertionError('JSON resolver accepted a conflicting dependency value')

git('config', 'user.name', 'Wabi integration audit')
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
git('fetch', 'origin', 'main')
base = git('rev-parse', 'origin/main').stdout.strip()
git('switch', '--detach', base)
report = {'base': base, 'prs': [], 'candidate': None, 'remoteWrites': False}
for number, expected in EXPECTED.items():
    pr = api(f'pulls/{number}')
    row = {key: pr[key] for key in ['number', 'title', 'state', 'draft']}
    row.update(head=pr['head']['sha'], branch=pr['head']['ref'], files=[])
    report['prs'].append(row)
    if pr['state'] != 'open':
        row['outcome'] = 'already merged' if pr.get('merged') else 'closed without merge'
        row['merge_commit'] = pr.get('merge_commit_sha')
        print(f"PR #{number}: {row['outcome']}", flush=True)
        continue
    if row['head'] != expected:
        row['outcome'] = 'head moved; requires another review'
        continue
    page = 1
    while True:
        files = api(f'pulls/{number}/files?per_page=100&page={page}')
        row['files'].extend(files)
        if len(files) < 100:
            break
        page += 1
    git('fetch', 'origin', f'pull/{number}/head:refs/remotes/pr/{number}')
    actual = git('rev-parse', f'refs/remotes/pr/{number}').stdout.strip()
    if actual != expected:
        row['outcome'] = 'head moved while fetching; requires another review'
        continue
    row['before'] = git('rev-parse', 'HEAD').stdout.strip()
    merged = git('merge', '--no-ff', '--no-edit', '-m', f'Merge PR #{number}: {pr["title"]}', actual, check=False)
    (OUT / f'merge-{number}.log').write_text(merged.stdout)
    if merged.returncode:
        conflicts = git('diff', '--name-only', '--diff-filter=U').stdout.splitlines()
        row['conflicts'] = conflicts
        allowed = {'frontend/package.json', 'frontend/package-lock.json'}
        if number in (168, 170) and conflicts and set(conflicts) <= allowed:
            try:
                resolved = {}
                for path in conflicts:
                    values = [json.loads(git('show', f':{stage}:{path}').stdout) for stage in (1, 2, 3)]
                    resolved[path] = merge_json(*values)
                for path, value in resolved.items():
                    pathlib.Path(path).write_text(json.dumps(value, indent=2) + '\n')
                    git('add', '--', path)
                git('commit', '--no-edit')
                row['outcome'] = 'resolved disjoint JSON keys; all overlapping values agreed'
            except Exception as error:
                row['outcome'] = 'conflict'
                row['error'] = str(error)
                git('merge', '--abort', check=False)
        else:
            row['outcome'] = 'conflict'
            git('merge', '--abort', check=False)
    else:
        row['outcome'] = 'clean candidate merge'
    print(f"PR #{number}: {row['outcome']} — {row['title']}", flush=True)
report['candidate'] = git('rev-parse', 'HEAD').stdout.strip()
(OUT / 'report.json').write_text(json.dumps(report, indent=2))
(OUT / 'base.txt').write_text(base + '\n')
(OUT / 'candidate.diff').write_text(git('diff', base, 'HEAD').stdout)
(OUT / 'candidate-tree.txt').write_text(git('ls-tree', '-r', 'HEAD').stdout)
for path in git('diff', '--name-only', base, 'HEAD').stdout.splitlines():
    source = pathlib.Path(path)
    if source.is_file():
        target = OUT / 'candidate-files' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
blocked = [row['number'] for row in report['prs'] if row['outcome'] not in (
    'already merged', 'clean candidate merge', 'resolved disjoint JSON keys; all overlapping values agreed')]
(OUT / 'assembly-status.txt').write_text('assembly=' + ('0' if not blocked else ','.join(map(str, blocked))) + '\n')
