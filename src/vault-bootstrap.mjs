import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomToken,tokenDigest } from './vault-crypto.mjs';
import { ownerIdentity } from './vault-platform.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

function secureDirectory(dir,ownerSid){
  execFileSync('icacls.exe',[dir,'/inheritance:r','/grant:r',`*${ownerSid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true,stdio:'ignore',timeout:5000});
}

export function preparePrivacyLaunch({settings,readIdentity=ownerIdentity,protectDirectory=secureDirectory,now=Date.now}={}){
  if(!settings){
    try{settings=JSON.parse(fs.readFileSync(path.join(root,'suite-settings.json'),'utf8').replace(/^\uFEFF/,''));}
    catch{throw new Error('privacy_settings_unavailable');}
  }
  let ownerSid;
  try{ownerSid=readIdentity();}catch{throw new Error('privacy_identity_unavailable');}
  if(!ownerSid||ownerSid!==settings.OwnerSid)throw new Error('privacy_owner_mismatch');
  let url='http://127.0.0.1:43131/security';
  try{
    const dir=path.join(settings.DataRoot,'vault');fs.mkdirSync(dir,{recursive:true});
    protectDirectory(dir,ownerSid);
    // First-password setup still requires a five-minute, one-use capability
    // issued for the configured Windows owner. Never log this URL or ticket.
    if(!fs.existsSync(path.join(dir,'vault.json'))){
      const nonce=randomToken();
      fs.writeFileSync(path.join(dir,'setup-ticket.json'),JSON.stringify({ownerSid,digest:tokenDigest(nonce),expiresAt:now()+5*60000}));
      url+='#setup='+nonce;
    }
  }catch{throw new Error('privacy_ticket_unavailable');}
  return {url};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--prepare-only')throw new Error('privacy_launcher_update_required');
    // Redirected stdout is a private pipe to the desktop controller. It opens
    // the browser with ShellExecute on its STA thread and reports launch errors.
    process.stdout.write(JSON.stringify(preparePrivacyLaunch()));
  }catch(error){
    const code=/^privacy_[a-z_]+$/.test(error.message)?error.message:'privacy_prepare_failed';
    process.stderr.write(JSON.stringify({error:code}));process.exitCode=1;
  }
}
