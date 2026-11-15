import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const guardPath = path.join(root,'native','TrafficWatch-VaultGuard.exe');
export function dpapi(value, { scope = 'user', decrypt = false } = {}) {
  if (process.platform !== 'win32' || !fs.existsSync(guardPath)) throw new Error('vault_guard_required');
  return Buffer.from(execFileSync(guardPath, [decrypt?'unprotect':'protect',scope], {
    input: Buffer.from(value).toString('base64'), windowsHide:true, timeout:10000, maxBuffer:1024*1024,
    stdio:['pipe','pipe','ignore'],
  }).toString().trim(),'base64');
}
export function ownerIdentity() {
  return execFileSync(guardPath,['identity'],{windowsHide:true,timeout:5000,stdio:['ignore','pipe','ignore']}).toString().trim();
}
export class SessionGuard {
  constructor(ownerSid,onChange) { this.ownerSid=ownerSid;this.onChange=onChange;this.state='unknown';this.at=0; }
  start() {
    if (!this.ownerSid || !fs.existsSync(guardPath)) { this.onChange({state:'unknown',reset:true}); return; }
    this.child=spawn(guardPath,['watch',this.ownerSid],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    createInterface({input:this.child.stdout}).on('line',line=>{
      try {
        const status=JSON.parse(line);
        if (!['locked','unlocked','logged_out','unknown'].includes(status.state) || Math.abs(Date.now()-status.at)>3000) throw new Error();
        this.at=Date.now();this.state=status.state;this.onChange(status);
      } catch { this.state='unknown';this.onChange({state:'unknown',reset:true}); }
    });
    this.child.on('error',()=>{this.state='unknown';this.onChange({state:'unknown',reset:true});});
    this.child.on('exit',()=>{this.state='unknown';this.onChange({state:'unknown',reset:true});});
    this.timer=setInterval(()=>{if(Date.now()-this.at>2500){this.state='unknown';this.onChange({state:'unknown',reset:true});}},1000).unref();
  }
  close() {clearInterval(this.timer);this.child?.kill();}
}
