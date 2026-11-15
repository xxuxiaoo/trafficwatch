import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('Windows controller handles setup replies, noisy failures, unsafe URLs and helper timeouts',{skip:process.platform!=='win32',timeout:30000},t=>{
  const root=path.resolve(import.meta.dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-privacy-control-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  const executable=path.join(dir,'PrivacyLauncherTest.exe'),script=path.join(dir,'synthetic-helper.mjs');
  fs.writeFileSync(script,`
    import fs from 'node:fs';
    import path from 'node:path';
    const mode=process.argv[2],url='http://127.0.0.1:43131/security';
    if(mode==='timeout'){
      fs.writeFileSync(path.join(import.meta.dirname,'timeout-pid.txt'),String(process.pid));
      setInterval(()=>{},1000);
    }else if(mode==='owner-mismatch'||mode==='private-error'){
      process.stderr.write(mode==='owner-mismatch'?JSON.stringify({error:'privacy_owner_mismatch'}):'PRIVATE_TEST_CANARY');
      process.exitCode=1;
    }else if(mode==='invalid-json')process.stdout.write('PRIVATE_TEST_CANARY');
    else if(mode==='large-output')process.stdout.write('x'.repeat(100000));
    else if(mode==='untrusted-url')process.stdout.write(JSON.stringify({url:'https://example.test/PRIVATE_TEST_CANARY'}));
    else if(mode==='missing-url')process.stdout.write('{}');
    else{
      if(mode==='large-stderr')process.stderr.write('x'.repeat(200000));
      process.stdout.write(JSON.stringify({url:url+(mode==='ticket'?'#setup='+'x'.repeat(43):'')}));
    }
  `);
  const build=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/codepage:65001','/reference:System.dll','/reference:System.Core.dll','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/reference:Microsoft.CSharp.dll','/main:PrivacyLauncherTest','/out:'+executable,path.join(root,'desktop','TrafficWatch-Control.cs'),path.join(root,'test','PrivacyLauncherTest.cs')],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const result=spawnSync(executable,[process.execPath,script],{encoding:'utf8',windowsHide:true,timeout:12000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/Privacy controller integration passed/);
});
