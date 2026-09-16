import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationServer, makeInvitation, parseInvitation } from '../../frontend/src/lib/hostInvites.ts';
const token='ab'.repeat(32);
test('HTTPS invitation roundtrip keeps its secret out of the request URL',()=>{
  const value=makeInvitation('https://community.example:8443',token);
  assert.deepEqual(parseInvitation(value),{server:'https://community.example:8443',token});
  assert.equal(new URL(value).search,'');
});
test('same-LAN invitation is explicit; localhost is not shareable',()=>{
  assert.equal(parseInvitation(makeInvitation('http://192.168.1.2:3000',token)).server,'http://192.168.1.2:3000');
  for(const host of ['http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000']) assert.throws(()=>makeInvitation(host,token));
});
test('rejects insecure internet, embedded credentials and ambiguous tokens',()=>{
  for(const address of ['http://example.com','ftp://192.168.1.2','https://user:password@community.example','https://community.example/api','https://community.example/?token=bad']) assert.throws(()=>invitationServer(address));
  for(const link of [`https://example.com/join?secret=${token}#invite=${token}`,`https://example.com/join#invite=${token}&invite=${token}`,`https://example.com/join#invite=short`]) assert.throws(()=>parseInvitation(link));
});
