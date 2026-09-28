#!/usr/bin/env python3
"""Disposable remote browser + loopback Tailcat proxy for controlled field tests.
Reads JSON commands on stdin, emits JSON results. Never edits system settings.
"""
import json, os, pathlib, select, socket, socketserver, struct, subprocess, sys, threading, time
root = pathlib.Path(__file__).resolve().parent
children = []
proxy = None
settings = {}
lock = threading.Lock()
def reply(value):
    print(json.dumps(value), flush=True)
def exact(s, n):
    data = b''
    while len(data) < n:
        part = s.recv(n-len(data))
        if not part: raise OSError('Socket closed')
        data += part
    return data
class Forward(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with lock: port, pipe = settings['socksPort'], settings['pipePort']
            with socket.create_connection(('127.0.0.1',port),timeout=12) as upstream:
                upstream.sendall(b'\x05\x01\x00')
                if exact(upstream,2) != b'\x05\x00': raise OSError('SOCKS authentication failed')
                host=b'server.tailcat'
                upstream.sendall(b'\x05\x01\x00\x03'+bytes([len(host)])+host+struct.pack('!H',pipe))
                header=exact(upstream,4)
                if header[1] != 0: raise OSError('Tailcat dial rejected')
                exact(upstream, {1:4,4:16}.get(header[3],0) if header[3]!=3 else exact(upstream,1)[0]);exact(upstream,2)
                upstream.settimeout(None)
                while True:
                    ready,_,_=select.select([upstream,self.request],[],[],30)
                    if not ready: return
                    for source in ready:
                        data=source.recv(65536)
                        if not data:return
                        (self.request if source is upstream else upstream).sendall(data)
        except (OSError,KeyError) as exc:
            with open(root/'proxy.log','a') as log:log.write(type(exc).__name__+': '+str(exc)+'\n')
class Proxy(socketserver.ThreadingTCPServer):
    daemon_threads=True
    allow_reuse_address=False

def launch(args,env,log):
    f=open(root/log,'ab',buffering=0)
    p=subprocess.Popen(args,env=env,stdin=subprocess.DEVNULL,stdout=f,stderr=f)
    children.append(p);return p

def stop(p):
    if p and p.poll() is None:
        p.terminate()
        try:p.wait(8)
        except subprocess.TimeoutExpired:p.kill();p.wait()

def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

try:
    first=json.loads(sys.stdin.readline());config=first['config'];env=dict(os.environ)
    (root/'tailcat').chmod(0o700)
    env.update(DISPLAY=config['display'],XAUTHORITY=config['xauthority'],XDG_CONFIG_HOME=str(root/'config'))
    key=subprocess.check_output([str(root/'tailcat'),'genkey','--client','--key=field-client'],env=env,stderr=subprocess.PIPE,text=True).strip()
    profile=root/'browser-profile'
    chrome=launch([config['chrome'],'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+str(profile),'--no-first-run','--no-default-browser-check','--password-store=basic','about:blank'],env,'browser.log')
    for _ in range(150):
        marker=profile/'DevToolsActivePort'
        if marker.exists():break
        if chrome.poll() is not None:raise RuntimeError('Browser exited; inspect private browser.log')
        time.sleep(.2)
    cdp=int(marker.read_text().splitlines()[0]);reply({'ready':True,'publicKey':key,'cdpPort':cdp,'browserPid':chrome.pid})
    socks=None
    for line in sys.stdin:
        command=json.loads(line);op=command['op']
        if op=='connect':
            stop(socks);sp=free_port()
            with lock:settings.update(socksPort=sp,pipePort=command['pipePort'])
            socks=launch([str(root/'tailcat'),'--key=field-client','socks','--listen=127.0.0.1:'+str(sp),command['address']],env,'tailcat.log')
            if proxy is None:
                proxy=Proxy(('127.0.0.1',command['localPort']),Forward)
                threading.Thread(target=proxy.serve_forever,daemon=True).start()
            for attempt in range(150):
                if socks.poll() is not None:raise RuntimeError('Tailcat client exited before becoming ready')
                try:
                    with socket.create_connection(('127.0.0.1',sp),timeout=.2):break
                except OSError:time.sleep(.2)
            else:raise RuntimeError('Tailcat SOCKS listener was not ready within 30 seconds')
            reply({'connected':True,'proxyPort':proxy.server_address[1]})
        elif op=='stop':break
        elif op=='status':reply({'children':[{'pid':p.pid,'running':p.poll() is None} for p in children]})
        else:raise ValueError('Unknown operation')
except Exception as exc:
    reply({'error':str(exc)});sys.exit(1)
finally:
    if proxy:proxy.shutdown();proxy.server_close()
    for p in reversed(children):stop(p)
