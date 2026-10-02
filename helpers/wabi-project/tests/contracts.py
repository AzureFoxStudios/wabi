"""Native executable contracts; fixtures never contact live Wabi or paid providers."""
import base64, hashlib, http.client, http.server, json, os, pathlib, re, socket, subprocess, tempfile, threading, time, unittest, urllib.parse, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
BIN=pathlib.Path(os.environ.get('WABI_HELPER_TEST_BINARY',ROOT/'target/debug/wabi-project-helper'))
BOT='disposable-bot-secret'; KEY='disposable-provider-secret'
def encoded(v): return json.dumps(v).encode()
def now(): return time.time_ns()//1000
class Mock:
 def __init__(self,fn):
  self.calls=[]; self.fn=fn
  owner=self
  class Handler(http.server.BaseHTTPRequestHandler):
   def log_message(self,*a): pass
   def handle_request(self):
    n=int(self.headers.get('Content-Length',0)); raw=self.rfile.read(n); body=json.loads(raw) if raw else None
    owner.calls.append((self.command,self.path,body,dict(self.headers)))
    result=owner.fn(self.command,self.path,body)
    if result is None: self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
    status,data,*extra=result; self.send_response(status)
    self.send_header('Content-Type','application/json')
    for k,v in (extra[0] if extra else {}).items(): self.send_header(k,v)
    self.end_headers(); self.wfile.write(data if isinstance(data,bytes) else encoded(data))
   do_GET=handle_request;do_POST=handle_request;do_PUT=handle_request
  self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
  self.url='http://127.0.0.1:'+str(self.server.server_port)
  self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
 def close(self):self.server.shutdown(); self.server.server_close(); self.thread.join()
class Mcp:
 def __init__(self,server,config=None):
  self.temp=tempfile.TemporaryDirectory(); self.file=pathlib.Path(self.temp.name)/'connection.json'
  self.file.write_text(json.dumps(config or {'version':1,'serverUrl':server,'channelId':'project_one','botToken':BOT})); self.file.chmod(0o600)
  self.p=subprocess.Popen([BIN,'mcp','--connection',self.file],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  self.i=0; self.rpc('initialize',{})
 def rpc(self,method,params):
  self.i+=1; self.p.stdin.write(json.dumps({'jsonrpc':'2.0','id':self.i,'method':method,'params':params})+'\n');self.p.stdin.flush()
  line=self.p.stdout.readline()
  if not line:raise AssertionError('MCP exited: '+self.p.stderr.read())
  return json.loads(line)
 def call(self,name,args=None):
  r=self.rpc('tools/call',{'name':name,'arguments':args or {}})['result']; text=r['content'][0]['text']
  return text if r.get('isError') else json.loads(text)
 def close(self):
  self.p.stdin.close(); self.p.wait(timeout=3);self.p.stdout.close();self.p.stderr.close();self.temp.cleanup()
class ConnectorTests(unittest.TestCase):
 def fixture(self,fn,config=None):
  mock=Mock(fn);self.addCleanup(mock.close);m=Mcp(mock.url,config(mock.url) if config else None);self.addCleanup(m.close);return m,mock
 def test_01_invalid_connection_origins(self):
  for url in ['http://remote.invalid','https://user:pass@example.org','https://example.org/path','https://example.org?token=x']:
   env={**os.environ,'WABI_PROJECT_URL':url,'WABI_PROJECT_CHANNEL_ID':'project_one','WABI_BOT_TOKEN':BOT}
   p=subprocess.run([BIN,'mcp'],env=env,input='',capture_output=True,text=True);self.assertNotEqual(p.returncode,0);self.assertNotIn(BOT,p.stderr)
 def test_02_runtime_labels(self):
  def config(url):return {'version':1,'serverUrl':url,'channelId':'project_one','botToken':BOT,'runtime':{'harness':'codex','mode':'existing_harness','name':'chat','computer':'backup','workspace':'/repo','botToken':'not-returned','commands':['/anything']}}
  m,_=self.fixture(lambda *a:(200,{'tasks':[],'pages':[]}),config);b=m.call('project_brief');self.assertFalse(b['runtime']['workspaceVerified']);self.assertEqual(b['runtime']['source'],'owner_entered_labels');self.assertNotIn('not-returned',json.dumps(b));self.assertFalse(b['harnessCommands']['forwardedByWabi'])
 def test_03_bounded_brief_no_estimates(self):
  rows=[{'taskId':str(i),'title':'task','status':'todo','revision':3,'humanEstimateMinutes':90} for i in range(70)]
  m,_=self.fixture(lambda *a:(200,{'tasks':rows,'pages':[{'page_id':'page_one','title':'wiki','body':'untrusted body','updated_at_micros':123}]}));b=m.call('project_brief');self.assertEqual(len(b['activeCards']['items']),25);self.assertEqual(b['activeCards']['nextOffset'],25);self.assertNotIn('humanEstimateMinutes',json.dumps(b));self.assertNotIn('untrusted body',json.dumps(b));self.assertEqual(b['wiki']['items'][0]['updatedAtMicros'],123);self.assertIsNone(m.call('list_cards',{'offset':50,'limit':20})['nextOffset'])
 def test_04_card_fields_revision(self):
  task={'taskId':'task_one','title':'T','description':'D','status':'todo','priority':'high','revision':3,'assigneeUserId':10,'dueDateMillis':1,'notes':'prior','checklist':[{'id':'one','title':'Print','done':False}],'relatedTaskIds':['two'],'humanEstimateMinutes':90}
  m,mock=self.fixture(lambda *a:(200,task));self.assertNotIn('humanEstimateMinutes',m.call('read_card',{'taskId':'task_one'}));self.assertIn('Conflict',m.call('update_card',{'taskId':'task_one','expectedRevision':2,'notes':'stale'}));self.assertIn('Unsupported',m.call('update_card',{'taskId':'task_one','expectedRevision':3,'humanEstimateMinutes':5}));m.call('update_card',{'taskId':'task_one','expectedRevision':3,'notes':'evidence'});writes=[c for c in mock.calls if c[0]=='PUT'];self.assertEqual(len(writes),1);body=writes[0][2];self.assertEqual(body['checklist'],task['checklist']);self.assertEqual(body['relatedTaskIds'],['two']);self.assertEqual(body['priority'],'high');self.assertNotIn('humanEstimateMinutes',body)
 def test_05_errors_uncertain_no_retry(self):
  m,mock=self.fixture(lambda method,*a:(403,{'error':BOT}) if method=='GET' else None);self.assertIn('Access refused',m.call('read_card',{'taskId':'task_one'}));error=m.call('create_card',{'title':'T','operationId':str(uuid.uuid4())});self.assertIn('uncertain',error);self.assertNotIn(BOT,error);self.assertEqual(len(mock.calls),2)
 def test_06_wiki_excerpt(self):
  m,_=self.fixture(lambda *a:(200,{'page_id':'page_one','title':'T','body':'x'*50000,'updated_at_micros':123}));r=m.call('read_wiki',{'pageId':'page_one'});self.assertEqual(len(r['body']),24000);self.assertEqual(r['nextOffset'],24000);self.assertEqual(r['updatedAtMicros'],123)
 def test_07_stdio_contract(self):
  m,_=self.fixture(lambda *a:(200,{}));tools=m.rpc('tools/list',{})['result']['tools'];self.assertEqual(len(tools),10);self.assertIn('Unsupported',m.call('update_card',{'taskId':'one','expectedRevision':1,'humanEstimateMinutes':3}));self.assertEqual(m.rpc('ping',{})['result'],{});self.assertEqual(m.rpc('initialize',{})['error']['code'],-32600)
 def test_08_uuid_argument_bounds(self):
  m,mock=self.fixture(lambda *a:(200,{}));self.assertIn('Missing',m.call('create_card',{'title':'T'}));self.assertIn('Invalid',m.call('create_card',{'title':'T','operationId':'bad'}));self.assertIn('Invalid',m.call('read_card',{'taskId':'../other'}));self.assertIn('Invalid',m.call('list_cards',{'limit':51}));self.assertIn('Invalid',m.call('list_cards',{'offset':-9223372036854775808}));self.assertFalse(mock.calls)
 def test_09_wiki_revision_hierarchy(self):
  page={'page_id':'page_one','title':'prior','body':'preserve','parent_page_id':'parent','slug':'slug','order_index':7,'updated_at_micros':123}
  m,mock=self.fixture(lambda *a:(200,page));self.assertIn('Conflict',m.call('update_wiki',{'pageId':'page_one','expectedUpdatedAtMicros':122,'title':'new'}));m.call('update_wiki',{'pageId':'page_one','expectedUpdatedAtMicros':123,'title':'new'});b=[c[2] for c in mock.calls if c[0]=='PUT'][0];self.assertEqual(b,{'title':'new','body':'preserve','parentPageId':'parent','slug':'slug','orderIndex':7,'expectedUpdatedAtMicros':123})
 def test_10_uncertain_wiki_metadata(self):
  m,mock=self.fixture(lambda *a:None);self.assertIn('uncertain',m.call('create_wiki',{'title':'T','body':'B'}));self.assertEqual(len(mock.calls),1)
  m,_=self.fixture(lambda *a:(200,{'page_id':'page_one','title':'T','body':'hidden','updated_at_micros':9}));self.assertEqual(m.call('create_wiki',{'title':'T','body':'B'}),{'pageId':'page_one','title':'T','updatedAtMicros':9})
 def test_11_camelcase_wiki(self):
  page={'pageId':'page_one','title':'old','body':'keep','parentPageId':'parent','slug':'s','orderIndex':2,'updatedAtMicros':123};m,mock=self.fixture(lambda *a:(200,page));self.assertEqual(m.call('read_wiki',{'pageId':'page_one'})['updatedAtMicros'],123);m.call('update_wiki',{'pageId':'page_one','expectedUpdatedAtMicros':123,'title':'new'});self.assertEqual(mock.calls[-1][2]['parentPageId'],'parent')
class GatewayFixture:
 def __init__(self,fn=None,auth_path='',registered=None,listen='127.0.0.1'):
  self.mock=Mock(fn or (lambda *a:(200,{'tasks':[],'pages':[]})));self.temp=tempfile.TemporaryDirectory();self.dir=pathlib.Path(self.temp.name);self.dir.chmod(0o700)
  self.file=self.dir/'connection.json';self.file.write_text(json.dumps({'version':1,'serverUrl':self.mock.url,'channelId':'project_one','botToken':BOT}));self.file.chmod(0o600)
  s=socket.socket();s.bind(('127.0.0.1',0));self.port=s.getsockname()[1];s.close();self.issuer=f'http://127.0.0.1:{self.port}';self.resource=self.issuer+'/mcp';self.callback='http://127.0.0.1:8999/callback';self.auth_path=auth_path;self.connect_host=listen;self.sock=self.dir/'control.sock';self.verifier='v'*43
  self.challenge=base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).decode().rstrip('=')
  args=[BIN,'gateway','--connection',self.file,'--public-url',self.issuer,'--name','Disposable Project','--callback',self.callback,'--port',str(self.port),'--control-socket',self.sock,'--listen',listen]
  if auth_path:args+=['--auth-path',auth_path]
  if registered:
   f=self.dir/'clients.json';f.write_text(json.dumps(registered(self.issuer,self.callback)));f.chmod(0o600);args+=['--registered-clients',f]
  self.args=args;self.p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  for _ in range(100):
   if self.p.poll() is not None:raise AssertionError(self.p.stderr.read())
   try:
    if self.request('/health')[0]==200:break
   except OSError:time.sleep(.02)
  else:raise AssertionError('Gateway did not start')
 def control(self,cmd):
  with socket.socket(socket.AF_UNIX) as s:
   s.connect(str(self.sock));s.sendall((cmd+'\n').encode());return json.loads(s.recv(8192))
 def request(self,path,method='GET',body=None,form=False,headers=None):
  if path.split('?')[0] in ['/register','/authorize','/token','/revoke']:path=self.auth_path+path
  headers={'Host':urllib.parse.urlsplit(self.issuer).netloc,**(headers or {})};data=None
  if body is not None:data=urllib.parse.urlencode(body).encode() if form else encoded(body);headers['Content-Type']='application/x-www-form-urlencoded' if form else 'application/json'
  conn=http.client.HTTPConnection(self.connect_host,self.port,timeout=4);conn.request(method,path,data,headers);r=conn.getresponse();raw=r.read();out=(r.status,dict(r.getheaders()),raw);conn.close();return out
 def register(self):
  r=self.request('/register','POST',{'redirect_uris':[self.callback],'token_endpoint_auth_method':'none'});assert r[0]==201,r;return json.loads(r[2])['client_id']
 def start(self,client,**patch):
  p={'client_id':client,'redirect_uri':self.callback,'resource':self.resource,'scope':'project:read project:write','response_type':'code','state':'state','code_challenge_method':'S256','code_challenge':self.challenge};p.update(patch);return self.request('/authorize?'+urllib.parse.urlencode(p))
 def approve(self,start,**patch):
  tx=re.search(r'name="transaction" value="([^"]+)"',start[2].decode()).group(1);code=self.control('link')['linkCode'];p={'transaction':tx,'linkCode':code,'consent':'yes'};p.update(patch);return self.request('/authorize','POST',p,True,{'Cookie':start[1]['set-cookie'].split(';')[0],'Origin':self.issuer})
 def exchange(self,client,code,**patch):
  p={'grant_type':'authorization_code','client_id':client,'code':code,'code_verifier':self.verifier,'redirect_uri':self.callback,'resource':self.resource};p.update(patch);return self.request('/token','POST',p,True)
 def link(self):
  c=self.register();approved=self.approve(self.start(c));assert approved[0]==303,approved;query=urllib.parse.parse_qs(urllib.parse.urlsplit(approved[1]['location']).query);assert query['iss']==[self.issuer];r=self.exchange(c,query['code'][0]);assert r[0]==200,r;return c,json.loads(r[2])
 def rpc(self,token,method='tools/list',params=None,headers=None):
  h={'Authorization':'Bearer '+token,'Accept':'application/json, text/event-stream'};h.update(headers or {});return self.request('/mcp','POST',{'jsonrpc':'2.0','id':1,'method':method,'params':params or {}},headers=h)
 def close(self):
  if self.p.poll() is None:self.p.terminate()
  try:self.p.wait(timeout=3)
  except subprocess.TimeoutExpired:self.p.kill();self.p.wait()
  self.p.stdout.close();self.p.stderr.close();self.mock.close();self.temp.cleanup()
class GatewayTests(unittest.TestCase):
 def fixture(self,**kw):f=GatewayFixture(**kw);self.addCleanup(f.close);return f
 def test_12_discovery_transport(self):
  f=self.fixture();self.assertEqual(f.request('/mcp')[0],401);self.assertEqual(f.request('/health',headers={'Host':'attacker.example'})[0],403);self.assertEqual(f.request('/health',headers={'Origin':'null'})[0],403);self.assertEqual(json.loads(f.request('/.well-known/oauth-authorization-server')[2])['issuer'],f.issuer);_,t=f.link();self.assertEqual(f.rpc(t['access_token'],headers={'Accept':'application/json'})[0],406);self.assertEqual(f.rpc(t['access_token'],headers={'mcp-protocol-version':'bad'})[0],400);self.assertEqual(f.request('/mcp','POST',{'blob':'x'*(128*1024)},headers={'Authorization':'Bearer '+t['access_token'],'Accept':'application/json, text/event-stream'})[0],413);self.assertEqual(f.request('/mcp',headers={'Authorization':'Bearer '+t['access_token']})[0],405)
 def test_13_slow_body_revocation(self):
  f=self.fixture();_,t=f.link();s=socket.create_connection(('127.0.0.1',f.port));self.addCleanup(s.close);body=encoded({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'project_brief'}});head=f'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{f.port}\r\nAuthorization: Bearer {t["access_token"]}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n';s.sendall(head.encode()+body[:1]);time.sleep(.04);f.control('revoke');s.sendall(body[1:]);self.assertIn(b'401',s.recv(4096));self.assertFalse(f.mock.calls)
 def test_14_callback_resource_consent_cookie(self):
  f=self.fixture();c=f.register();self.assertEqual(f.start(c,redirect_uri='https://evil.invalid/callback')[0],400);self.assertEqual(f.start(c,resource='wrong')[0],400);start=f.start(c);self.assertEqual(f.approve(start,consent='no')[0],403);self.assertEqual(f.control('status')['lastConsentFailure']['reason'],'consent_missing');self.assertEqual(f.request('/authorize','POST',{'transaction':'bad','consent':'yes','linkCode':'x'},True,{'Origin':f.issuer})[0],403)
 def test_15_pkce_replay_client_binding(self):
  f=self.fixture();c=f.register();other=f.register();r=f.approve(f.start(c));code=urllib.parse.parse_qs(urllib.parse.urlsplit(r[1]['location']).query)['code'][0];self.assertEqual(f.exchange(c,code,code_verifier='bad')[0],400);self.assertEqual(f.exchange(other,code)[0],400);self.assertEqual(f.exchange(c,code,resource='wrong')[0],400);self.assertEqual(f.exchange(c,code)[0],200);self.assertEqual(f.exchange(c,code)[0],400)
 def test_16_origin_referrer_cookie(self):
  f=self.fixture();c=f.register();s=f.start(c);self.assertEqual(s[1]['referrer-policy'],'same-origin');self.assertIn('HttpOnly',s[1]['set-cookie']);self.assertIn('SameSite=Lax',s[1]['set-cookie']);self.assertEqual(f.request('/authorize','POST',{},True,{'Origin':'null'})[0],403);self.assertEqual(f.request('/authorize','POST',{},True,{'Origin':'https://evil.invalid'})[0],403)
 def test_17_preserved_public_registration(self):
  cid='A'*43;f=self.fixture(registered=lambda issuer,callback:{'version':1,'issuer':issuer,'clients':[{'clientId':cid,'redirectUris':[callback],'expires':int(time.time()*1000)+60000}]});self.assertEqual(f.start(cid)[0],200);self.assertEqual(f.rpc('A'*43)[0],401);r=f.approve(f.start(cid));self.assertEqual(r[0],303)
 def test_18_refresh_rotation_revocation(self):
  f=self.fixture();c,t=f.link();p={'grant_type':'refresh_token','client_id':c,'resource':f.resource,'refresh_token':t['refresh_token']};other=f.register();self.assertEqual(f.request('/token','POST',{**p,'client_id':other},True)[0],400);r=f.request('/token','POST',p,True);self.assertEqual(r[0],200);new=json.loads(r[2]);self.assertEqual(f.rpc(t['access_token'])[0],401);self.assertEqual(f.request('/token','POST',p,True)[0],400);f.request('/revoke','POST',{'client_id':c,'token':new['refresh_token']},True);self.assertEqual(f.rpc(new['access_token'])[0],401)
 def test_19_restart_revokes_tokens(self):
  f=self.fixture();_,t=f.link();f.p.terminate();f.p.wait(timeout=3);f.p.stdout.close();f.p.stderr.close();self.assertFalse(f.sock.exists());f.p=subprocess.Popen(f.args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);subprocess.run([BIN,'health',f.issuer+'/health','--wait','3'],check=True,capture_output=True);self.assertEqual(f.rpc(t['access_token'])[0],401);self.assertEqual(f.control('status'),{'lastConsentFailure':None})
 def test_20_hosted_tools_scoped_redacted(self):
  f=self.fixture();_,t=f.link();r=json.loads(f.rpc(t['access_token'])[2])['result'];self.assertEqual(len(r['tools']),11);self.assertFalse(r['tools'][0]['annotations']['openWorldHint']);profile=json.loads(f.rpc(t['access_token'],'tools/call',{'name':'connection_profile'})[2]);self.assertNotIn(BOT,json.dumps(profile));p=json.loads(profile['result']['content'][0]['text']);self.assertEqual(p['connectionMode'],'project_tools');self.assertEqual(p['channelId'],'project_one');self.assertTrue(all('/project_one/' in c[1] or '/project_one/' in c[1]+'/' for c in f.mock.calls))
 def test_21_hosted_workflow_and_stale_save(self):
  state={'card':None,'writes':0}
  def authority(method,path,body):
   if path.endswith('/tasks') and method=='POST':
    state['card']={**body,'taskId':'one','revision':1,'notes':'','checklist':[],'relatedTaskIds':[]};state['writes']+=1;return 200,state['card']
   if path.endswith('/claim'):
    if body['expectedRevision']!=state['card']['revision']:return 409,{}
    state['card'].update(status='in_progress',assigneeUserId=10,revision=2);state['writes']+=1;return 200,state['card']
   if method=='PUT':
    if body['expectedRevision']!=state['card']['revision']:return 409,{}
    state['card'].update(body);state['card']['revision']+=1;state['writes']+=1;return 200,state['card']
   return 200,state['card']
  f=self.fixture(fn=authority);_,tokens=f.link();token=tokens['access_token']
  def call(name,args):
   result=json.loads(f.rpc(token,'tools/call',{'name':name,'arguments':args})[2])['result']
   if result.get('isError'):return result['content'][0]['text']
   return json.loads(result['content'][0]['text'])
  created=call('create_card',{'title':'Fixture','operationId':str(uuid.uuid4())});self.assertEqual(created['revision'],1)
  claimed=call('claim_card',{'taskId':'one','expectedRevision':1});self.assertEqual(claimed['status'],'in_progress')
  evidence=call('update_card',{'taskId':'one','expectedRevision':2,'notes':'Verified disposable proof'});self.assertEqual(evidence['revision'],3)
  self.assertIn('Conflict',call('update_card',{'taskId':'one','expectedRevision':2,'notes':'stale'}))
  done=call('update_card',{'taskId':'one','expectedRevision':3,'status':'done'});self.assertEqual(done['status'],'done');self.assertEqual(done['notes'],'Verified disposable proof');self.assertEqual(state['writes'],4)
 def test_22_package_no_secret_no_overwrite(self):
  with tempfile.TemporaryDirectory() as d:
   dest=pathlib.Path(d)/'plugin';r=subprocess.run([BIN,'package','https://mcp.example/mcp',dest],capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(json.loads((dest/'mcp.json').read_text())['mcpServers']['wabi']['url'],'https://mcp.example/mcp');self.assertNotIn(BOT,(dest/'mcp.json').read_text());self.assertTrue((dest/'skills/wabi-project/SKILL.md').is_file());self.assertNotEqual(subprocess.run([BIN,'package','https://mcp.example/mcp',dest],capture_output=True).returncode,0)
 def test_23_invalid_gateway_configuration(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'connection.json';p.write_text('{}');p.chmod(0o644);r=subprocess.run([BIN,'gateway','--connection',p,'--public-url','http://remote.invalid','--name','T','--callback','https://example.org/callback'],capture_output=True,text=True);self.assertNotEqual(r.returncode,0);self.assertNotIn(BOT,r.stderr)
 def test_24_namespaced_control_socket(self):
  f=self.fixture(auth_path='/private');self.assertEqual(f.sock.stat().st_mode&0o777,0o600);d=json.loads(f.request('/.well-known/oauth-authorization-server')[2]);self.assertEqual(d['authorization_endpoint'],f.issuer+'/private/authorize');_,t=f.link();self.assertEqual(f.rpc(t['access_token'])[0],200);alias=f.dir/'wabi-project-plugin';alias.symlink_to(BIN);status=subprocess.run([alias,'--control',f.sock,'status'],capture_output=True,text=True);self.assertEqual(status.returncode,0,status.stderr);self.assertEqual(json.loads(status.stdout),{'lastConsentFailure':None});r=subprocess.run([BIN,'control',f.sock,'link'],capture_output=True,text=True);self.assertNotEqual(r.returncode,0);self.assertNotIn('linkCode',r.stdout)
class WorkerTests(unittest.TestCase):
 def run_worker(self,change=None,provider=None,initial=None,enrolled=False,disabled=False,drop_step=False,settings=None):
  run=initial or {'runId':'run_a','revision':1,'attempt':0,'status':'queued','mode':'work','prompt':'fixture','steps':[],'leaseUntilMicros':now()+120000000};state={'run':run,'providers':0,'actions':[],'seen':[]}
  wid='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  def server(method,path,body):
   if path.endswith('/workers') or path.endswith('/heartbeat'):return 200,{}
   if path.endswith('/runs'):
    if change:change(state,'runs')
    return 200,{'runs':[state['run']],'serverNowMicros':now(),'workersEnabled':not disabled}
   if path.endswith('/claim'):
    state['claim']=body;state['run']={**state['run'],'status':'running','attempt':state['run']['attempt']+1,'revision':state['run']['revision']+1,'leaseUntilMicros':now()+120000000}
    if enrolled:state['run']['workerId']=wid
    if change:change(state,'claim')
    return 200,state['run']
   if path.endswith('/step'):
    state['actions'].append(body);tool=body['tool'];state['run']['revision']+=1
    if tool in ['complete','fail']:state['run']['status']='completed' if tool=='complete' else 'failed'
    else:state['run']['steps'].append({'tool':tool,'arguments':body['arguments'],'result':{'taskId':'saved'}})
    if drop_step:
     state['run']['pending']={'tool':tool};return None
    return 200,state['run']
   return 404,{}
  def model(method,path,body):
   state['providers']+=1;state['seen'].append(body)
   if change:change(state,'provider')
   if provider:return provider(state)
   return 200,{'choices':[{'message':{'content':'{"tool":"complete","arguments":{"reply":"done"}}'}}]}
  wabi=Mock(server);model_mock=Mock(model);self.addCleanup(wabi.close);self.addCleanup(model_mock.close)
  env={**os.environ,'WABI_PROJECT_URL':wabi.url,'WABI_PROJECT_CHANNEL_ID':'project_one','WABI_BOT_TOKEN':BOT,'WABI_AI_PROVIDER_URL':model_mock.url,'WABI_AI_API_KEY':KEY,'WABI_AI_MODEL':'free-test'}
  if enrolled:env.update(WABI_WORKER_ID=wid,WABI_WORKER_NAME='backup')
  if settings:env.update(settings)
  p=subprocess.run([BIN,'worker','--once'],env=env,capture_output=True,text=True,timeout=6);state['process']=p;state['wabi']=wabi;state['provider_mock']=model_mock;return state
 def test_25_config_and_actions_fail_closed(self):
  s=self.run_worker(settings={'WABI_AI_MAX_TOKENS':'200000'});self.assertNotEqual(s['process'].returncode,0);self.assertEqual(s['providers'],0)
 def test_26_provider_no_credentials_completed(self):
  s=self.run_worker();self.assertEqual(s['process'].returncode,0,s['process'].stderr);self.assertEqual(s['providers'],1);self.assertEqual(s['run']['status'],'completed');self.assertNotIn(BOT,json.dumps(s['seen']));self.assertNotIn(KEY,json.dumps(s['seen']));self.assertEqual(s['provider_mock'].calls[0][3]['authorization'],'Bearer '+KEY);self.assertEqual(s['actions'][0]['attempt'],1)
 def test_27_takeover_during_generation(self):
  def change(s,when):
   if when=='provider':s['run'].update(status='taken_over',attempt=2,revision=3)
  s=self.run_worker(change);self.assertFalse(s['actions']);self.assertEqual(s['providers'],1)
 def test_28_empty_response_no_retry(self):
  s=self.run_worker(provider=lambda s:(200,{'choices':[{'message':{'content':''}}]}));self.assertNotEqual(s['process'].returncode,0);self.assertEqual([a['tool'] for a in s['actions']],['fail']);self.assertIn('no action content',s['actions'][0]['arguments']['reply']);self.assertEqual(s['providers'],1)
 def test_29_later_invalid_preserves_step(self):
  def provider(s):return 200,{'choices':[{'message':{'content':'{"tool":"create_card","arguments":{"title":"fixture"}}' if s['providers']==1 else 'invalid'}}]}
  s=self.run_worker(provider=provider);self.assertEqual(len(s['run']['steps']),1);self.assertEqual([a['tool'] for a in s['actions']],['create_card','fail']);self.assertIn('Earlier recorded steps remain applied',s['actions'][-1]['arguments']['reply'])
 def test_30_expired_attempt_before_generation(self):
  def change(s,when):
   if when=='claim':s['run']['leaseUntilMicros']=now()-1
  s=self.run_worker(change);self.assertEqual(s['providers'],0);self.assertFalse(s['actions'])
 def test_31_returning_worker_replacement(self):
  def change(s,when):
   if when=='provider':s['run'].update(attempt=3,revision=4)
  s=self.run_worker(change);self.assertFalse(s['actions']);self.assertEqual(s['providers'],1)
 def test_32_saved_steps_no_replay(self):
  run={'runId':'run_a','revision':5,'attempt':2,'status':'queued','mode':'work','prompt':'fixture','steps':[{'tool':'create_card','arguments':{'title':'Already created'},'result':{'taskId':'saved_card'}}]};s=self.run_worker(initial=run);self.assertEqual([a['tool'] for a in s['actions']],['complete']);self.assertIn('saved_card',json.dumps(s['seen']));self.assertEqual(s['actions'][0]['attempt'],3)
 def test_33_enrolled_backup(self):
  wid='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';run={'runId':'run_a','revision':5,'attempt':1,'status':'running','mode':'work','prompt':'fixture','steps':[],'workerId':'old','leaseUntilMicros':1,'recoveryCount':0,'recoveryPolicy':{'automatic':True,'backupWorkerIds':[wid],'maxRecoveries':1}};s=self.run_worker(initial=run,enrolled=True);self.assertEqual(s['claim']['workerId'],wid);self.assertEqual(s['actions'][0]['workerId'],wid);self.assertEqual(s['run']['status'],'completed')
 def test_34_pending_or_no_consent_no_claim(self):
  for automatic,pending in [(False,None),(True,{'tool':'create_card'})]:
   run={'runId':'run_a','revision':5,'attempt':1,'status':'running','mode':'work','prompt':'fixture','steps':[],'workerId':'old','leaseUntilMicros':1,'pending':pending,'recoveryCount':0,'recoveryPolicy':{'automatic':automatic,'backupWorkerIds':['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'],'maxRecoveries':1}};s=self.run_worker(initial=run,enrolled=True);self.assertNotIn('claim',s);self.assertEqual(s['providers'],0)
 def test_35_addon_disabled_no_model(self):
  s=self.run_worker(enrolled=True,disabled=True);self.assertNotEqual(s['process'].returncode,0);self.assertEqual(s['providers'],0)
 def test_36_pause_cancel_post_generation(self):
  for status in ['paused','cancelled']:
   def change(s,when):
    if when=='provider':s['run']['status']=status
   s=self.run_worker(change);self.assertFalse(s['actions']);self.assertEqual(s['providers'],1)
 def test_37_uncertain_step_no_failure_write(self):
  s=self.run_worker(drop_step=True);self.assertEqual(len(s['actions']),1);self.assertEqual(s['providers'],1)
 def test_38_no_silent_provider_fallback(self):
  s=self.run_worker(provider=lambda s:(503,{'error':KEY}));self.assertEqual(s['providers'],1);self.assertNotIn(KEY,s['process'].stdout+s['process'].stderr);self.assertEqual([a['tool'] for a in s['actions']],['fail'])
 def test_41_provider_metadata_secret_redaction(self):
  s=self.run_worker(provider=lambda s:(200,{'model':KEY,'choices':[{'finish_reason':BOT,'message':{'content':'{"tool":"complete","arguments":{"reply":"done"}}'}}]}));self.assertEqual(s['process'].returncode,0);self.assertNotIn(KEY,s['process'].stdout+s['process'].stderr);self.assertNotIn(BOT,s['process'].stdout+s['process'].stderr)
class ExtraTests(unittest.TestCase):
 def test_39_node_absent_package_and_stdio(self):
  with tempfile.TemporaryDirectory() as d:
   env={'PATH':d,'WABI_PROJECT_URL':'http://127.0.0.1:1','WABI_PROJECT_CHANNEL_ID':'project_one','WABI_BOT_TOKEN':BOT}
   p=subprocess.run([BIN,'mcp'],input='{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',env=env,capture_output=True,text=True);self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(len(json.loads(p.stdout.splitlines()[1])['result']['tools']),10)
   dest=pathlib.Path(d)/'plugin';self.assertEqual(subprocess.run([BIN,'package','https://example.org/mcp',dest],env=env,capture_output=True).returncode,0)
 def test_42_private_listener_native_health(self):
  f=GatewayFixture(listen='127.0.0.2');self.addCleanup(f.close);r=subprocess.run([BIN,'health',f'http://127.0.0.2:{f.port}/health','--host',f.issuer.split('://')[1],'--wait','1'],capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
  r=subprocess.run([BIN,'health','http://8.8.8.8/health'],capture_output=True,text=True);self.assertNotEqual(r.returncode,0)
 def test_40_cross_project_and_redirect_refusal(self):
  mock=Mock(lambda *a:(302,{}, {'Location':'http://127.0.0.1:9/stolen'}));self.addCleanup(mock.close);m=Mcp(mock.url);self.addCleanup(m.close);self.assertIn('failed (302)',m.call('read_card',{'taskId':'one'}));self.assertIn('Unsupported',m.call('project_brief',{'channelId':'other'}));self.assertEqual(len(mock.calls),1)
if __name__=='__main__':unittest.main(verbosity=2)
