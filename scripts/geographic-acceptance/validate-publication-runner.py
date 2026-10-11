"""Source-only remote runner validation. Root reviews and schedules; never local.

Imports the exact reviewed driver/core; only disposable paths, fixture limits
and workload callbacks are rebound. No Cargo, Git, Wabi, keys or deployments.
"""
from pathlib import Path
import base64, contextlib, fcntl, gzip, hashlib, importlib.util, json, os
import select, shutil, signal, stat, sys, time, traceback

ROOT = Path('/home/Ronin/.cache/wabi-geographic-authority-validation')
E = ROOT / 'evidence'
SEED = ROOT / 'seed'
CASES = ROOT / 'cases'
DRIVER_SHA = '6b08e33b67f24c741bdc65cdf96e49eecc6bd8d4ad840e8d545260c615f38b8f'
CORE_SHA = '90ea737d0df6e8e57ebcfe777ebb0374a1ad43c3657126d7b937331876aa83e8'
STAGING_SHA = '647487de4dbfa077686aa9895d08a8f2548c7967bf510a4bf4e159b035b7b14d'
CAP = 256 * 2**20
CORE = None
BUNDLE = None
PACKET_SHA = None
OWNER = None
WORKERS = []
LOCK_FD = None
LOCK_ID = None
CASE_NAMES = ('callbacks', 'deadline', 'interrupted', 'adopted', 'cap', 'floor',
    'large', 'missing_phase', 'missing_result', 'corrupt_result', 'missing_owned',
    'corrupt_owned', 'missing_start', 'orphan_result', 'orphan_log', 'orphan_start',
    'replaced_lock', 'missing_lock')


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(65536), b''): value.update(block)
    return value.hexdigest()


def private(path, cap=4 * 2**20):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        assert stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
        assert before.st_nlink == 1 and not before.st_mode & 0o077 and before.st_size <= cap
        data = stream.read(cap + 1)
        after = os.fstat(stream.fileno())
        named = Path(path).lstat()
        fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        assert len(data) == before.st_size and fields(before) == fields(after) == fields(named)
        return data


def create(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(value); stream.flush(); os.fsync(stream.fileno())


def directory(path, private_mode=True):
    value = Path(path).lstat()
    assert stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid()
    assert not value.st_mode & (0o077 if private_mode else 0o022)
    return [value.st_dev, value.st_ino]


def load_module(path, expected, name):
    assert digest(private(path)) == expected
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def environment():
    result = {name: os.environ[name] for name in ('HOME', 'USER', 'LOGNAME') if name in os.environ}
    assert result['USER'] == 'Ronin' and Path(result['HOME']).resolve() == Path('/var/home/Ronin')
    result.update(PATH='/usr/bin:/bin', LANG='C.UTF-8', TZ='UTC', TMPDIR=str(ROOT))
    return result


def guard():
    assert directory(ROOT.parent, False) == OWNER['parentIdentity']
    assert directory(ROOT) == OWNER['rootIdentity']
    assert sha(ROOT / 'bundle.json') == PACKET_SHA
    for item in BUNDLE['files']:
        assert sha(ROOT / item['name']) == item['sha256']
    if LOCK_FD is not None:
        held = os.fstat(LOCK_FD); named = (ROOT / '.validation.lock').lstat()
        assert [held.st_dev, held.st_ino] == [named.st_dev, named.st_ino] == LOCK_ID
        assert stat.S_ISREG(named.st_mode) and named.st_uid == os.getuid() and named.st_nlink == 1
    size = sum(Path(parent, name).lstat().st_size for parent, dirs, files in os.walk(ROOT)
        for name in dirs + files)
    assert size <= CAP and shutil.disk_usage(ROOT).free >= 8 * 2**30


def initialize(packet_sha):
    global BUNDLE, PACKET_SHA, OWNER, CORE
    PACKET_SHA = packet_sha
    assert os.environ.get('USER') == 'Ronin' and os.getuid() != 0
    assert os.uname().nodename.lower() != 'dotronin'
    assert Path('/home/Ronin').resolve() == Path('/var/home/Ronin')
    data = private(ROOT / 'bundle.json')
    assert digest(data) == packet_sha
    BUNDLE = json.loads(data)
    OWNER = json.loads(private(ROOT / 'ownership.json'))
    assert OWNER['uid'] == os.getuid() and OWNER['packetSha256'] == packet_sha
    guard()
    CORE = load_module(SEED / 'owned_process.py', CORE_SHA, 'validation_process_core')
    CORE.ROOT = ROOT
    CORE.environment = environment
    CORE.enable_subreaper()
    def interrupted(sig, frame): raise InterruptedError('Validation interrupted: ' + str(sig))
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM): signal.signal(sig, interrupted)


def bootstrap(packet_sha):
    os.umask(0o077)
    data = sys.stdin.buffer.read(4 * 2**20 + 1)
    assert len(data) <= 4 * 2**20 and digest(data) == packet_sha
    bundle = json.loads(data)
    assert bundle['approvedRoot'] == str(ROOT) and bundle['schemaVersion'] == 1
    assert {f['name'] for f in bundle['files']} == {'validation.py', 'authority-staging.json'}
    assert len(bundle['files']) == 2
    assert os.getuid() != 0 and os.environ.get('USER') == 'Ronin'
    assert os.uname().nodename.lower() != 'dotronin'
    assert Path(os.environ['HOME']).resolve() == Path('/var/home/Ronin')
    assert Path('/home/Ronin').resolve() == Path('/var/home/Ronin')
    parent_id = directory(ROOT.parent, False)
    parent = os.open(ROOT.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        assert [os.fstat(parent).st_dev, os.fstat(parent).st_ino] == parent_id
        os.mkdir(ROOT.name, mode=0o700, dir_fd=parent)
        root = os.open(ROOT.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            value = os.fstat(root)
            ownership = {'uid': os.getuid(), 'packetSha256': packet_sha, 'parentIdentity': parent_id,
                'rootIdentity': [value.st_dev, value.st_ino], 'path': str(ROOT), 'runnerPid': os.getpid(),
                'runnerStartTicks': int(Path('/proc', str(os.getpid()), 'stat').read_text().rsplit(')', 1)[1].split()[19])}
            os.fsync(root); os.fsync(parent)
            print(json.dumps({'validationOwnershipPinned': ownership}), flush=True)
        finally: os.close(root)
    finally: os.close(parent)
    create(ROOT / 'bundle.json', data)
    create(ROOT / 'ownership.json', encoded(ownership))
    for path in (E, SEED, CASES): path.mkdir(mode=0o700)
    for item in bundle['files']:
        content = base64.b64decode(item['base64'], validate=True)
        assert len(content) == item['bytes'] and digest(content) == item['sha256']
        create(ROOT / item['name'], content)
    staging = private(ROOT / 'authority-staging.json')
    assert digest(staging) == STAGING_SHA
    packet = json.loads(staging)
    assert len(packet['files']) == 6
    for item in packet['files']:
        content = base64.b64decode(item['base64'], validate=True)
        assert item['name'] in ('source.json', 'payload.json', 'owned_process.py', 'driver.py', 'collector.py', 'cleanup.py')
        assert len(content) == item['bytes'] and digest(content) == item['sha256']
        create(SEED / item['name'], content)
    create(ROOT / '.validation.lock', b'')
    initialize(packet_sha)


def case_fixture(name):
    root = CASES / name
    root.mkdir(mode=0o700)
    for path in (root / 'target', root / 'cargo-home', root / 'fixtures', root / '.acceptance',
            root / '.acceptance/attempt1'): path.mkdir(mode=0o700)
    evidence = root / '.acceptance/attempt1'
    files = json.loads(private(ROOT / 'authority-staging.json'))['files']
    packet = {'schemaVersion': 1, 'approvedRoot': str(root), 'files': files}
    packet_sha = digest(encoded(packet))
    for item in files: create(evidence / item['name'], base64.b64decode(item['base64'], validate=True))
    paths = (CASES, root, root / 'target', root / 'cargo-home', root / 'fixtures', root / '.acceptance', evidence)
    create(evidence / 'bootstrap.json', encoded({'packetSha256': packet_sha,
        'roots': {str(path): directory(path) for path in paths},
        'files': [{k: v for k, v in item.items() if k != 'base64'} for item in files]}))
    ownership = {'uid': os.getuid(), 'packetSha256': packet_sha,
        'parent': {'path': str(CASES), 'identity': directory(CASES)},
        'root': {'path': str(root), 'identity': directory(root)}}
    create(E / (name + '-original-ownership.json'), encoded(ownership))
    return root, packet_sha, ownership


CHILD = r'''
import fcntl,json,os,signal,sys,time
from pathlib import Path
mode,folder,lock_name=sys.argv[1:]
folder=Path(folder)
def write(name,value):
 fd=os.open(folder/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
def held():
 fd=os.open(lock_name,os.O_RDWR|os.O_NOFOLLOW)
 try:
  try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return True
  else:fcntl.flock(fd,fcntl.LOCK_UN);return False
 finally:os.close(fd)
def term(sig,frame):
 if not (folder/'term.json').exists():write('term.json',{'pid':os.getpid(),'signal':sig,'targetLockHeld':held()})
 if mode!='deadline':sys.exit(0)
signal.signal(signal.SIGTERM,term)
blocked=[int(s) for s in signal.pthread_sigmask(signal.SIG_BLOCK,set())]
assert not set(blocked)&{int(signal.SIGHUP),int(signal.SIGINT),int(signal.SIGTERM)}
assert held()
if mode=='adopted':
 read_end,write_end=os.pipe();child=os.fork()
 if child==0:
  os.close(read_end);os.setsid()
  write('ready.json',{'pid':os.getpid(),'ticks':int(Path('/proc',str(os.getpid()),'stat').read_text().rsplit(')',1)[1].split()[19]),'changedSession':True,'targetLockHeld':held()})
  os.write(write_end,b'1');os.close(write_end);os.kill(os.getpid(),signal.SIGSTOP)
  while True:time.sleep(.02)
 os.close(write_end);assert os.read(read_end,1)==b'1';os.close(read_end);os._exit(7)
write('ready.json',{'pid':os.getpid(),'blocked':blocked,'targetLockHeld':held(),'environmentNames':sorted(os.environ)})
if mode=='large':
 for i in range(1280):sys.stdout.buffer.write(b'X'*65536)
 sys.stdout.buffer.flush();sys.exit(0)
if mode=='cap':
 fd=os.open(folder/'growth.bin',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:
  for i in range(32):f.write(b'G'*65536)
  f.flush();os.fsync(f.fileno())
if mode in ('deadline','interrupted','cap'):
 while True:time.sleep(.02)
print(json.dumps({'actualEnvironmentNames':sorted(os.environ),'targetLockHeld':held(),'blocked':blocked}))
'''


def worker(packet_sha, name, phase, ownership, options):
    initialize(packet_sha)
    assert name in CASE_NAMES and phase in ('prepare', 'fetch', 'run', 'collect', 'cleanup')
    root = CASES / name
    driver = load_module(SEED / 'driver.py', DRIVER_SHA, 'exact_reviewed_driver')
    driver.ROOT, driver.PARENT, driver.EVIDENCE = root, CASES, root / '.acceptance/attempt1'
    driver.TARGET, driver.CACHE, driver.FIXTURES = root / 'target', root / 'cargo-home', root / 'fixtures'
    driver.CAP = options.get('cap', 128 * 2**20)
    driver.FIXTURE_CAP = options.get('fixtureCap', 8 * 2**20)
    driver.FLOOR = options.get('floor', 8 * 2**30)
    def action():
        if phase == 'prepare':
            until = time.monotonic() + 10
            ack = driver.FIXTURES / 'prepare-pin-ack.json'
            while not ack.exists():
                driver.roots(); driver.resources()
                assert time.monotonic() < until, 'Original pin not independently acknowledged'
                time.sleep(.02)
            assert json.loads(private(ack))['targetLockIdentity'] == list(driver.SLOT_ID)
        if options.get('zeroIntervals'):
            driver.roots(); measured = driver.resources(True)
            return {'accepted': True, 'validationScope': 'Actual empty control stage, no subprocess interval', 'resources': measured}
        mode = options.get('childMode', 'normal')
        folder = driver.FIXTURES / phase
        folder.mkdir(mode=0o700)
        old_mask = None
        if name == 'callbacks':
            old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGHUP, signal.SIGINT, signal.SIGTERM})
        try:
            exit_code, log = driver.managed([sys.executable, '-c', CHILD, mode, str(folder),
                str(driver.TARGET / '.acceptance.lock')], 'callback', 0.5 if mode == 'deadline' else 30,
                'test' if phase == 'run' else 'tools')
            assert exit_code == 0
            return {'accepted': exit_code == 0, 'validationOnly': True, 'childMode': mode,
                'actualLogSha256': driver.sha(log), 'noCompilerOrWabi': True}
        finally:
            if old_mask is not None: signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
    # Exact dispatch, slot, initialize, managed and collect/cleanup definitions
    # run unchanged. Only expensive workload callbacks are tiny fixture actions.
    driver.prepare = action
    driver.fetch = action
    driver.run = action
    driver.dispatch(phase, ownership['packetSha256'], ownership, options.get('savedArchiveSha256'))


def launch(name, phase, ownership, options=None, expected_exit_zero=True):
    options = options or {}
    log_path = E / (name + '-' + phase + '.log')
    command = [sys.executable, str(ROOT / 'validation.py'), 'worker', PACKET_SHA, name, phase,
        json.dumps(ownership), json.dumps(options)]
    owner = None
    saved_pin = False
    started = time.monotonic()
    interrupted = False
    with os.fdopen(os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as log:
        try:
            owner = CORE.OwnedSession.spawn(command, log, protect_leader_lock=True)
            WORKERS.append(owner.record)
            while owner.child.poll() is None:
                owner.scan(); guard()
                assert time.monotonic() - started < 180, 'Actual validation phase deadline'
                # Retain flushed original target identity separately while the
                # actual prepare runner is alive; never re-pin a later name.
                if phase == 'prepare' and not saved_pin:
                    with log_path.open('rb') as observed: lines = observed.read(2**20).splitlines()
                    for line in lines:
                        try: value = json.loads(line)
                        except json.JSONDecodeError: continue
                        if value.get('targetLockOwnershipPinned'):
                            assert value['runnerPid'] == owner.child.pid
                            assert value['runnerStartTicks'] == owner.record['leaderStartTicks']
                            assert value['rootIdentity'] == ownership['root']['identity']
                            assert value['packetSha256'] == ownership['packetSha256']
                            create(E / (name + '-original-target-lock.json'), encoded(value))
                            ownership['targetLockIdentity'] = value['targetLockIdentity']
                            create(CASES / name / 'fixtures/prepare-pin-ack.json', encoded(value))
                            saved_pin = True
                if options.get('childMode') == 'interrupted' and not interrupted:
                    if (CASES / name / 'fixtures' / phase / 'ready.json').exists():
                        member = owner.members[(owner.child.pid, owner.record['leaderStartTicks'])]
                        signal.pidfd_send_signal(member['fd'], signal.SIGTERM, None, 0)
                        interrupted = True
                time.sleep(.02)
            code = owner.wait_leader()
        finally:
            for active in CORE.ACTIVE:
                if all(saved is not active.record for saved in WORKERS): WORKERS.append(active.record)
            if owner is None and CORE.ACTIVE: owner = CORE.ACTIVE[-1]
            if CORE.ACTIVE: CORE.drain_active('validation_phase_actual_drain')
            log.flush(); os.fsync(log.fileno())
            if owner is not None:
                create(E / (name + '-' + phase + '-owned.json'), encoded(owner.record))
    assert not CORE.ACTIVE and not CORE.kernel_children(os.getpid())
    assert owner.record['drained'] and (code == 0) == expected_exit_zero
    if phase == 'prepare':
        assert saved_pin, 'No independently saved original target lock; retain uncertain fixture'
    if options.get('childMode') == 'interrupted': assert interrupted
    return code


def verify_archive(path, collection):
    assert sha(path) == collection['sha256'] and path.stat().st_size == collection['bytes']
    with gzip.open(path, 'rb') as stream:
        def exact(value): assert stream.read(len(value)) == value
        exact(b'{"schemaVersion":1,"scope":"Actual evidence/public source only; generated fixture identities/data excluded","files":[')
        for index, item in enumerate(collection['fileManifest']):
            if index: exact(b',')
            prefix = {'path': item['path'], 'bytes': item['bytes']}
            exact(json.dumps(prefix, sort_keys=True, separators=(',', ':')).encode()[:-1] + b',"base64":"')
            remaining = (item['bytes'] + 2) // 3 * 4
            checksum = hashlib.sha256(); count = 0
            while remaining:
                amount = min(65536, remaining)
                block = stream.read(amount); assert len(block) == amount
                decoded = base64.b64decode(block, validate=True)
                checksum.update(decoded); count += len(decoded); remaining -= amount
            assert count == item['bytes'] and checksum.hexdigest() == item['sha256']
            exact(b'","sha256":' + json.dumps(item['sha256']).encode() + b'}')
        exact(b']}'); assert not stream.read(1)


def copy_evidence(root, name):
    saved = E / name
    saved.mkdir(mode=0o700)
    for path in (root / '.acceptance/attempt1').iterdir():
        if path.name in ('source.json', 'payload.json', 'driver.py', 'collector.py', 'cleanup.py', 'owned_process.py'): continue
        assert path.is_file() and not path.is_symlink()
        dest = saved / path.name
        with path.open('rb') as source, os.fdopen(os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as output:
            shutil.copyfileobj(source, output, 65536); output.flush(); os.fsync(output.fileno())
        assert sha(dest) == sha(path)
    observations = []
    for path in (root / 'fixtures').rglob('*.json'):
        value = json.loads(private(path))
        observations.append({'path': str(path.relative_to(root)), 'sha256': sha(path), 'value': value})
    create(saved / 'actual-fixture-observations.json', encoded(observations))
    return observations


def execute_case(name):
    root, packet_sha, ownership = case_fixture(name)
    zero = name in ('missing_phase', 'orphan_result')
    launch(name, 'prepare', ownership, {'zeroIntervals': zero})
    lock_path = root / 'target/.acceptance.lock'
    original_fd = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW)
    assert [os.fstat(original_fd).st_dev, os.fstat(original_fd).st_ino] == ownership['targetLockIdentity']
    try:
        evidence = root / '.acceptance/attempt1'
        expected_collect = True
        limits = {}
        if name == 'callbacks':
            launch(name, 'fetch', ownership)
            launch(name, 'run', ownership)
        elif name in ('deadline', 'interrupted', 'adopted', 'cap', 'large'):
            if name == 'cap': limits = {'fixtureCap': 128 * 1024}
            launch(name, 'fetch', ownership, {**limits, 'childMode': name}, name == 'large')
        elif name == 'floor':
            # An impossible fixture threshold proves refusal without allocating
            # storage or depending on another process's changing free bytes.
            limits = {'floor': shutil.disk_usage(ROOT).total + 1}
            launch(name, 'fetch', ownership, limits, False)
        elif name in ('missing_phase', 'missing_result', 'corrupt_result', 'missing_owned', 'corrupt_owned', 'missing_start'):
            kind = name.split('_', 1)[1]
            if kind == 'phase': path = evidence / 'prepare-phase.json'
            elif kind == 'result': path = evidence / 'prepare-result.json'
            else:
                result = json.loads(private(evidence / 'prepare-result.json'))
                interval = result['intervals'][0]
                path = evidence / (interval + ('-owned.json' if kind == 'owned' else '-start.json'))
            if name.startswith('corrupt'):
                with path.open('wb') as output: output.write(b'{'); output.flush(); os.fsync(output.fileno())
            else: path.unlink()
            expected_collect = False
        elif name.startswith('orphan_'):
            suffix = {'orphan_result': 'extra-result.json', 'orphan_log': 'extra.log', 'orphan_start': 'extra-start.json'}[name]
            create(evidence / suffix, b'{"scope":"intentionally unmatched fixture evidence"}\n')
            expected_collect = False
        elif name in ('replaced_lock', 'missing_lock'):
            lock_path.rename(root / 'target/original-retained.lock')
            if name == 'replaced_lock': create(lock_path, b'')
            expected_collect = False
        launch(name, 'collect', ownership, limits, expected_collect)
        observations = copy_evidence(root, name)
        if name in ('deadline', 'interrupted', 'adopted', 'cap'):
            terms = [item['value'] for item in observations if item['path'].endswith('/term.json')]
            assert terms and all(item['targetLockHeld'] and item['signal'] == int(signal.SIGTERM) for item in terms)
        if expected_collect:
            collection = json.loads(private(evidence / 'collection.json'))
            verify_archive(evidence / 'collected.json.gz', collection)
            if name == 'large':
                logs = [item for item in collection['fileManifest'] if item['path'].endswith('.log')]
                assert max(item['bytes'] for item in logs) > 16 * 2**20
                assert sum(item['bytes'] for item in logs) > 64 * 2**20
            if name == 'cap': assert not collection['actualResources']['withinGrowthCaps']
            if name == 'floor': assert not collection['actualResources']['freeFloorSatisfied']
            launch(name, 'cleanup', ownership, {**limits, 'savedArchiveSha256': collection['sha256']})
            assert not root.exists() and not root.is_symlink()
        else:
            assert root.is_dir() and not (evidence / 'collected.json.gz').exists()
        return {'name': name, 'accepted': True, 'expectedCollectionSucceeded': expected_collect,
            'actualWorkerProofs': [item for item in WORKERS if name in item['intendedCommand']],
            'fixtureRootRetained': root.exists(), 'productionWorkExecuted': False}
    finally: os.close(original_fd)


def stream_archive():
    paths = sorted(path for path in ROOT.rglob('*') if path.is_file()
        and path.name not in ('validation-evidence.json.gz', 'validation-collection.json'))
    manifest = []
    path = ROOT / 'validation-evidence.json.gz'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as out:
            out.write(b'{"schemaVersion":1,"scope":"Actual evidence/public source only; generated fixture identities/data excluded","files":[')
            for index, source_path in enumerate(paths):
                source_fd = os.open(source_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(source_fd, 'rb') as source:
                    before = os.fstat(source.fileno())
                    assert stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1
                    assert not before.st_mode & 0o077
                    if index: out.write(b',')
                    prefix = {'path': str(source_path.relative_to(ROOT)), 'bytes': before.st_size}
                    out.write(json.dumps(prefix, sort_keys=True, separators=(',', ':')).encode()[:-1] + b',"base64":"')
                    checksum = hashlib.sha256(); carry = b''; count = 0
                    while True:
                        block = source.read(65536)
                        if not block: break
                        checksum.update(block); count += len(block)
                        joined = carry + block; whole = len(joined) - len(joined) % 3
                        out.write(base64.b64encode(joined[:whole])); carry = joined[whole:]
                    if carry: out.write(base64.b64encode(carry))
                    after = os.fstat(source.fileno()); named = source_path.lstat()
                    snapshot = lambda v: (v.st_dev, v.st_ino, v.st_size, v.st_mtime_ns, v.st_ctime_ns)
                    assert count == before.st_size and snapshot(before) == snapshot(after) == snapshot(named)
                    value = checksum.hexdigest(); out.write(b'","sha256":' + json.dumps(value).encode() + b'}')
                    manifest.append({**prefix, 'sha256': value})
            out.write(b']}')
        raw.flush(); os.fsync(raw.fileno())
    collection = {'sha256': sha(path), 'bytes': path.stat().st_size, 'fileManifest': manifest,
        'allActualWorkersDrained': not CORE.ACTIVE and not CORE.kernel_children(os.getpid()),
        'generatedKeysDataOrCredentialsIncluded': False}
    assert collection['allActualWorkersDrained']
    verify_archive(path, collection)
    create(ROOT / 'validation-collection.json', encoded(collection))
    print(json.dumps({'validationCollection': collection}), flush=True)


@contextlib.contextmanager
def validation_lock(expected=None):
    global LOCK_FD, LOCK_ID
    fd = os.open(ROOT / '.validation.lock', os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r+b') as lock:
        value = os.fstat(lock.fileno()); identity = [value.st_dev, value.st_ino]
        assert stat.S_ISREG(value.st_mode) and value.st_uid == os.getuid() and value.st_nlink == 1
        assert not value.st_mode & 0o077
        if expected is not None: assert identity == expected
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert [os.stat(ROOT / '.validation.lock').st_dev, os.stat(ROOT / '.validation.lock').st_ino] == identity
        print(json.dumps({'validationLockPinned': identity, 'runnerPid': os.getpid(),
            'runnerStartTicks': CORE.process(os.getpid())['startTicks']}), flush=True)
        LOCK_FD, LOCK_ID = lock.fileno(), identity
        try: yield identity
        finally:
            if CORE.ACTIVE: CORE.drain_active('validation_original_lock_barrier')
            assert not CORE.ACTIVE and not CORE.kernel_children(os.getpid())
            LOCK_FD, LOCK_ID = None, None


def run(packet_sha):
    bootstrap(packet_sha)
    record = {'accepted': False, 'scope': 'Actual bounded runner OS and evidence integration only',
        'cases': [], 'workers': WORKERS, 'compilerWabiPhysicalOrHATested': False}
    with validation_lock():
        try:
            for name in CASE_NAMES: record['cases'].append(execute_case(name))
            record['accepted'] = len(record['cases']) == len(CASE_NAMES) and all(item['accepted'] for item in record['cases'])
        except BaseException as error:
            record['error'] = type(error).__name__ + ': ' + str(error)[:2000]
            record['traceback'] = traceback.format_exc(limit=10)
            raise
        finally:
            if CORE.ACTIVE: CORE.drain_active('validation_final_actual_barrier')
            record['allActualWorkersDrained'] = not CORE.ACTIVE and not CORE.kernel_children(os.getpid())
            assert record['allActualWorkersDrained']
            create(E / 'validation-result.json', encoded(record))
            stream_archive()
    assert record['accepted']


def cleanup(packet_sha, independent_owner, original_lock, saved_archive):
    initialize(packet_sha)
    assert OWNER == independent_owner
    with validation_lock(original_lock):
        collection = json.loads(private(ROOT / 'validation-collection.json'))
        assert collection['allActualWorkersDrained'] and collection['sha256'] == saved_archive
        verify_archive(ROOT / 'validation-evidence.json.gz', collection)
        record = json.loads(private(E / 'validation-result.json'))
        assert record['allActualWorkersDrained']
        for owner in record['workers']:
            assert owner['drained'] and owner['waitedLeaderExitCode'] is not None
            for observed in owner['observed']:
                actual = CORE.owned_status(observed['pid'])
                assert actual is None or actual['startTicks'] != observed['startTicks'] or actual['state'] == 'Z'
        actual_runner = CORE.owned_status(independent_owner['runnerPid'])
        assert actual_runner is None or actual_runner['startTicks'] != independent_owner['runnerStartTicks'] or actual_runner['state'] == 'Z', 'Original validation runner remains live'
        driver = load_module(SEED / 'driver.py', DRIVER_SHA, 'reviewed_deletion_only')
        parent = os.open(ROOT.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        root = os.open(ROOT.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            assert [os.fstat(parent).st_dev, os.fstat(parent).st_ino] == independent_owner['parentIdentity']
            value = os.fstat(root); assert [value.st_dev, value.st_ino] == independent_owner['rootIdentity']
            removed = driver.delete_tree(root, value.st_dev)
            current = os.stat(ROOT.name, dir_fd=parent, follow_symlinks=False)
            assert [current.st_dev, current.st_ino] == independent_owner['rootIdentity']
            os.rmdir(ROOT.name, dir_fd=parent); os.fsync(parent)
            assert not ROOT.exists() and not ROOT.is_symlink()
            print(json.dumps({'validationCleanup': True, 'rootAbsent': True,
                'removedBytes': removed, 'savedArchiveSha256': saved_archive}), flush=True)
        finally: os.close(root); os.close(parent)


if __name__ == '__main__':
    if sys.argv[1] == 'run':
        assert len(sys.argv) == 3
        run(sys.argv[2])
    elif sys.argv[1] == 'worker':
        assert len(sys.argv) == 7
        worker(sys.argv[2], sys.argv[3], sys.argv[4], json.loads(sys.argv[5]), json.loads(sys.argv[6]))
    elif sys.argv[1] == 'cleanup':
        assert len(sys.argv) == 6
        cleanup(sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4]), sys.argv[5])
    else: raise AssertionError('Unsupported validation mode')
