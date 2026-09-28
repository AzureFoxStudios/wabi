import json,subprocess,tempfile,pathlib,shutil
binary=str(pathlib.Path(__file__).resolve().parents[2]/'target/debug/wabi-server')
scope='planner:personal-desktop:v1'
with tempfile.TemporaryDirectory(prefix='wabi-personal-smoke-') as scratch:
 root=pathlib.Path(scratch)/'personal'
 def invoke(op,folder=root,**kw):
  req=dict(scope=scope,operation=op,**kw)
  run=subprocess.run([binary,'--personal-planner','--data-dir',str(folder)],input=json.dumps(req),text=True,capture_output=True,check=True,timeout=15,env={})
  return json.loads(run.stdout)
 assert invoke('read')==dict(ok=True,value=None)
 data={key:[] for key in ['todos','calendarEvents','diaryEntries','projects','sprints','kanbanColumns','resources','tags','graphEdges']}
 data['projects']=[dict(id='personal-project',name='Offline convention',createdBy='personal',createdAt=1,status='planning')]
 data['calendarEvents']=[dict(id='personal-event',title='Print deadline',date='2026-10-02',createdBy='personal')]
 data['diaryEntries']=[dict(id='personal-journal',date='2026-09-28',content='```ts\nconst personal = true;\n```',createdBy='personal',images=['data:image/png;base64,aGVsbG8='])]
 assert invoke('write',revision=0,data=data,draftId='one')==dict(ok=True,value=1)
 # Each invocation is a new process; no community account, daemon or listener.
 assert invoke('read')['value']['data']==data
 losing=json.loads(json.dumps(data));losing['projects'][0]['name']='Unaccepted edit'
 assert not invoke('write',revision=0,data=losing,draftId='two')['ok']
 assert invoke('drafts')['value'][0]['data']==losing
 assert invoke('read')['value']['data']==data
 # Backup by copying only committed storage, restore into another isolated profile.
 restored=pathlib.Path(scratch)/'restored';shutil.copytree(root,restored)
 assert invoke('read',folder=restored)['value']['data']==data
 assert not invoke('write',revision=1,data={'projects':[]},draftId='invalid')['ok']
 assert invoke('read')['value']['revision']==1
 print('PASS: new-process readback of project/event/journal/code/image bytes; conflict draft; isolated backup restore; invalid write preserves original.')
 print('Storage files:',','.join(sorted(p.name for p in root.iterdir())))
