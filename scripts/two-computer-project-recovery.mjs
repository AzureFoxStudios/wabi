// Parameterized acceptance harness, not a product transport or a scheduler.
// Runs a disposable Authority and backup on an operator-selected SSH host;
// primary runs here over a loopback-only tunnel. Never calls an external LLM.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {hostname,tmpdir} from 'node:os';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const [host,remoteRoot,out]=process.argv.slice(2);
if(!host || !remoteRoot?.startsWith('/') || !out || /[\r\n]/.test(host+remoteRoot+out) || host.startsWith('-'))throw new Error('Use SSH_HOST ABSOLUTE_ISOLATED_SOURCE_DIRECTORY REPORT_DIRECTORY');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const id=randomUUID(),remote=`${remoteRoot}/acceptance-${id}`;
const scratch=await mkdtemp(tmpdir()+'/wabi-two-computer-');
const root=fileURLToPath(new URL('../',import.meta.url));
const processes=[];
function processRun(command,args){
 const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});processes.push(child);
 let output='';child.stdout.on('data',v=>{output+=v;});child.stderr.on('data',v=>{output+=v;});
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,output}));});
 return {child,done};
}
const ssh=command=>processRun('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8',host,command]);
async function checked(command){const result=await ssh(command).done;if(result.code!==0)throw new Error('Remote fixture command failed');return result.output;}
async function waitFile(path,limit=300_000){const end=Date.now()+limit;for(;;){const result=await ssh(`test -f ${quote(path)}`).done;if(result.code===0)return;if(Date.now()>end)throw new Error('Fixture milestone timed out');await new Promise(r=>setTimeout(r,2500));}}
async function localFile(path,limit=30_000){const end=Date.now()+limit;for(;;){try{return JSON.parse(await readFile(path,'utf8'));}catch{}if(Date.now()>end)throw new Error('Primary worker checkpoint timed out');await new Promise(r=>setTimeout(r,250));}}
let authority,backup,tunnel,primary;
try{
 await checked(`umask 077; mkdir ${quote(remote)}`);
 const remoteHostname=(await checked('hostname')).trim();assert.notEqual(remoteHostname,hostname(),'Use two distinct physical computers');
 authority=ssh(`cd ${quote(remoteRoot)} && WABI_RECOVERY_FIXTURE_DIR=${quote(remote)} CARGO_BUILD_JOBS=2 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --test project_assistant_contract two_computer_recovery_fixture -- --ignored --nocapture`);
 console.log('Starting disposable Authority on the backup computer.');
 await waitFile(remote+'/connection.json');
 const raw=await checked(`cat ${quote(remote+'/connection.json')}`);const config=JSON.parse(raw);
 const connection=scratch+'/connection.json';await writeFile(connection,raw,{mode:0o600});
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const remotePort=new URL(config.wabi).port;
 tunnel=processRun('ssh',['-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=8','-N','-L',`127.0.0.1:${port}:127.0.0.1:${remotePort}`,host]);
 await new Promise(r=>setTimeout(r,1500));
 const origin=`http://127.0.0.1:${port}`;
 primary=processRun(process.execPath,[root+'scripts/project-worker-recovery-fixture.mjs',connection,'primary',scratch+'/primary-saved.json',origin]);
 const saved=await localFile(scratch+'/primary-saved.json');assert.equal(saved.steps,1);
 primary.child.kill('SIGKILL');await primary.done;
 console.log('Primary stopped after one durable card write. Backup waiting for real lease/contact expiry.');
 backup=ssh(`cd ${quote(remoteRoot)} && node scripts/project-worker-recovery-fixture.mjs ${quote(remote+'/connection.json')} backup ${quote(remote+'/backup.json')}`);
 await waitFile(remote+'/completed.json',300_000);
 const completed=JSON.parse(await checked(`cat ${quote(remote+'/completed.json')}`));assert.equal(completed.steps,2);assert.equal(completed.recoveryCount,1);
 const returning=processRun(process.execPath,[root+'scripts/project-worker-recovery-fixture.mjs',connection,'returning',scratch+'/returning.json',origin]);
 const returned=await returning.done;assert.equal(returned.code,0,'Returning-worker probe failed');
 const rejection=JSON.parse(await readFile(scratch+'/returning.json','utf8'));assert.equal(rejection.status,409);
 await checked(`touch ${quote(remote+'/returning-worker-rejected')}`);
 const accepted=await authority.done;assert.equal(accepted.code,0,'Authority acceptance assertions failed');
 const report={passed:true,physicalHosts:{primary:hostname(),backup:remoteHostname},checks:['real Authority and authentication','one saved card before primary process interruption','actual lease and contact expiry','backup resumed saved results','one automatic recovery','two recorded steps and one card','returning primary write rejected with 409'],limits:['deterministic provider stub; no model call','worker process termination, not physical power loss','not native Codex chat or repository recovery','isolated candidate; not deployed']};
 await mkdir(out,{recursive:true});await writeFile(out+'/two-computer-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 for(const item of processes){if(item.exitCode===null)item.kill('SIGTERM');}
 // Remove only this fixture's UUID directory, including its temporary tokens.
 await ssh(`rm -rf -- ${quote(remote)}`).done.catch(()=>{});
 await rm(scratch,{recursive:true,force:true});
}
