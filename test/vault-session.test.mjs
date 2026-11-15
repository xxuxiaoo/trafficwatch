import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultService } from '../src/vault-service.mjs';
import { signCommand,commandVerifier } from '../src/vault-commands.mjs';
import crypto from 'node:crypto';

test('an owner session is invalid after a lock even when a continued AI card keeps its limited access',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-vault-policy-'));
  let callback;
  const vault=new VaultService({dataRoot:dir,ownerSid:'test',guardFactory:handler=>{callback=handler;return {start(){handler({state:'unlocked'});},close(){}};}});
  try{
    vault.metadata={id:'test'};vault.locked=false;vault.secrets={};vault.ready=true;
    const owner=vault.newOwner();const request=vault.createRequest('synthetic');
    vault.approveRequest(request.id,{lanes:['clash'],permissions:['read'],scope:{kind:'recent',days:7},minutes:60,continueWhenLocked:true});
    const card=vault.claimRequest(request.id,request.receipt);assert.equal(vault.actor(card.token,{lane:'clash'}).id,card.grant.id);
    callback({state:'locked'});assert.throws(()=>vault.owner(owner.token),/vault_locked/);
    assert.equal(vault.actor(card.token,{lane:'clash'}).continueWhenLocked,true);
    assert.throws(()=>vault.actor(card.token,{operation:'delete'}),/grant_forbidden/);
    callback({state:'unlocked'});assert.throws(()=>vault.owner(owner.token),/vault_locked/);
    callback({state:'logged_out',reset:true});assert.throws(()=>vault.actor(card.token),/vault_locked/);
  }finally{vault.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('signed collector commands reject replays, expired messages and modified bodies',()=>{
  const pair=crypto.generateKeyPairSync('ed25519');const verify=commandVerifier(pair.publicKey),secrets={commandKey:pair.privateKey};
  const body={apps:{claude:['synthetic.exe']}},signed=signCommand('/api/harness-apps',body,secrets,100000);
  assert.equal(verify(signed,'/api/harness-apps',body,100001),true);
  assert.equal(verify(signed,'/api/harness-apps',body,100001),false);
  assert.equal(verify(signCommand('/api/harness-apps',body,secrets,100000),'/api/harness-apps',{apps:{}},100001),false);
  assert.equal(verify(signCommand('/api/harness-apps',body,secrets,100000),'/api/harness-apps',body,200000),false);
});
