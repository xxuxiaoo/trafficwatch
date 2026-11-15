import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preparePrivacyLaunch } from '../src/vault-bootstrap.mjs';
import { tokenDigest } from '../src/vault-crypto.mjs';

test('desktop preparation protects a short-lived owner ticket without launching a detached browser',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-privacy-launch-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const at=1700000000000,settings={OwnerSid:'synthetic-owner',DataRoot:dir};
  let protectedBeforeTicket=false;
  const launch=preparePrivacyLaunch({settings,readIdentity:()=>settings.OwnerSid,now:()=>at,protectDirectory:(target,owner)=>{
    assert.equal(target,path.join(dir,'vault'));assert.equal(owner,settings.OwnerSid);
    assert.equal(fs.existsSync(path.join(target,'setup-ticket.json')),false);protectedBeforeTicket=true;
  }});
  const address=new URL(launch.url),nonce=new URLSearchParams(address.hash.slice(1)).get('setup');
  assert.equal(protectedBeforeTicket,true);assert.equal(address.origin,'http://127.0.0.1:43131');assert.equal(address.pathname,'/security');
  assert.match(nonce,/^[A-Za-z0-9_-]{43}$/);
  const ticket=JSON.parse(fs.readFileSync(path.join(dir,'vault','setup-ticket.json'),'utf8'));
  assert.deepEqual(ticket,{ownerSid:settings.OwnerSid,digest:tokenDigest(nonce),expiresAt:at+300000});
  assert.equal(JSON.stringify(ticket).includes(nonce),false);
  fs.writeFileSync(path.join(dir,'vault','vault.json'),'{}');
  const oldTicket=JSON.stringify(ticket);
  const configured=preparePrivacyLaunch({settings,readIdentity:()=>settings.OwnerSid,protectDirectory:()=>{}});
  assert.equal(configured.url,'http://127.0.0.1:43131/security');
  assert.equal(fs.readFileSync(path.join(dir,'vault','setup-ticket.json'),'utf8'),oldTicket);
});

test('preparation refuses a different owner and aborts if directory protection fails',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-privacy-refuse-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const settings={OwnerSid:'synthetic-owner',DataRoot:dir};
  assert.throws(()=>preparePrivacyLaunch({settings,readIdentity:()=> 'other-owner',protectDirectory:()=>assert.fail('must not touch permissions')}),/privacy_owner_mismatch/);
  assert.equal(fs.existsSync(path.join(dir,'vault')),false);
  assert.throws(()=>preparePrivacyLaunch({settings,readIdentity:()=>{throw new Error('private identity detail');}}),{message:'privacy_identity_unavailable'});
  assert.throws(()=>preparePrivacyLaunch({settings,readIdentity:()=>settings.OwnerSid,protectDirectory:()=>{throw new Error('private path detail');}}),{message:'privacy_ticket_unavailable'});
  assert.equal(fs.existsSync(path.join(dir,'vault','setup-ticket.json')),false);
});

test('unsupported invocation fails explicitly without exposing a stack or generating a ticket',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/vault-bootstrap.mjs',import.meta.url))],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.deepEqual(JSON.parse(result.stderr),{error:'privacy_launcher_update_required'});
});
