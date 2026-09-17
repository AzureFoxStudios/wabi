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
test('parsing rejects embedded credentials instead of silently discarding them',()=>{
  for(const userinfo of ['user@','user:password@',':password@','user%40example.com@']) {
    assert.throws(()=>parseInvitation(`https://${userinfo}community.example/join#invite=${token}`));
  }
});
test('invitations reject every loopback form and unspecified listener addresses',()=>{
  for(const address of [
    'https://127.0.0.2','https://127.42.0.9','https://2130706433','https://0x7f000001',
    'https://localhost.','https://chat.localhost','https://0.0.0.0','https://[::]',
    'https://[::ffff:127.0.0.1]','https://[::127.0.0.1]','https://[::ffff:0:0]',
    'https://255.255.255.255'
  ]) {
    assert.throws(()=>makeInvitation(address,token),address);
    assert.throws(()=>parseInvitation(`${address}/join#invite=${token}`),address);
  }
});
test('direct localhost access remains available without creating a guest invitation',()=>{
  assert.equal(invitationServer('http://localhost:3000'),'http://localhost:3000');
});
