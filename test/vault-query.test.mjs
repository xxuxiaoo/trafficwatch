import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { configureDatabaseKeys } from '../src/database.mjs';
import { createVaultKeys } from '../src/vault-crypto.mjs';
import { vaultKeyEntries } from '../src/vault-migration.mjs';
import { normalizeGrant } from '../src/vault-grants.mjs';
import { HistoryReader } from '../src/history-reader.mjs';

test('scoped encrypted queries keep all totals, peaks, pagination and hosts inside nonconsecutive approved days',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-vault-query-'));let reader;
  try{
    const {secrets}=await createVaultKeys('synthetic-only-password'),entries=vaultKeyEntries(root,secrets);
    configureDatabaseKeys(entries);
    for(const lane of ['windows','clash']){
      const store=new Store(path.join(root,lane),{filename:'history.vault.sqlite'});
      for(const day of [10,11,12]){
        const at=Date.parse(`2026-11-${day}T12:00:00+08:00`);
        store.record({at,duration:1000,allUp:day,allDown:day*10,codexUp:0,codexDown:0,unknownUp:0,unknownDown:0,activeSessions:[],rows:[{key:`connection-${day}`,host:`day-${day}.example.test`,network:'tcp',process:'synthetic.exe',pid:10,scope:'other',evidence:'etw',rule:'{}',up:day,down:day*10}]});
      }
      store.close();
    }
    reader=new HistoryReader({dataRoot:root,keyEntries:entries,cacheRoot:path.join(root,'forbidden-cache')});
    const grant=normalizeGrant({lanes:['clash'],permissions:['read'],minutes:60,scope:{kind:'dates',dates:['2026-11-10','2026-11-12']}},Date.now());
    const options={vault:true,authorizedWindows:grant.windows,allowedLanes:grant.lanes};
    const overview=await reader.query({type:'overview',range:'all',options});
    assert.equal(overview.machine.available,false);assert.equal(overview.clash.totals.up,22);
    const detail=(await reader.query({type:'detail',range:'all',options:{...options,lane:'clash',export:true}})).detail;
    assert.equal(detail.summary.up,22);assert.equal(detail.series.reduce((sum,row)=>sum+row.up,0),22);
    assert.deepEqual(detail.destinations.map(row=>row.name).sort(),['day-10.example.test','day-12.example.test']);
    assert.equal(detail.pagination.total,2);assert.equal(JSON.stringify(detail).includes('day-11'),false);
    assert.equal(fs.existsSync(path.join(root,'forbidden-cache')),false);
  }finally{reader?.close();configureDatabaseKeys([]);await new Promise(resolve=>setTimeout(resolve,100));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
