import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {domainToASCII} from 'node:url';

const validId=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const makeId=()=>crypto.randomUUID();
export function normalizeRelayHost(value){
  if(typeof value!=='string')throw new Error('invalid_relay_host');
  const input=value.trim();if(!input||input.length>2048||/[\s\\@]/.test(input))throw new Error('invalid_relay_host');
  let hostname=input;
  if(input.includes('://')){
    let url;try{url=new URL(input);}catch{throw new Error('invalid_relay_host');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('invalid_relay_host');
    hostname=url.hostname;
  }else if(/[/?#]/.test(hostname))throw new Error('invalid_relay_host');
  hostname=hostname.replace(/\.$/,'').toLowerCase();
  if(hostname.startsWith('[')||net.isIP(hostname))throw new Error('invalid_relay_host');
  hostname=domainToASCII(hostname);
  if(!hostname||hostname.length>253||hostname==='localhost'||['.localhost','.local','.lan','.internal','.intranet','.home','.home.arpa'].some(suffix=>hostname.endsWith(suffix)))throw new Error('invalid_relay_host');
  const labels=hostname.split('.');
  if(labels.length<2||labels.some(label=>label.length<1||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))throw new Error('invalid_relay_host');
  return hostname;
}
export function isPublicIPv4(value){
  if(typeof value!=='string'||net.isIP(value)!==4)return false;
  const [a,b,c]=value.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===192&&b===0&&c===0||a===192&&b===0&&c===2||a===192&&b===88&&c===99||a===198&&(b===18||b===19)||a===198&&b===51&&c===100||a===203&&b===0&&c===113||a===100&&b>=64&&b<=127);
}
export function normalizeRelayTargets(value){
  if(!Array.isArray(value)||value.length>64)throw new Error('invalid_relay_targets');
  const ids=new Set(),hosts=new Set();
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('invalid_relay_target');
    if(Object.hasOwn(item,'id')&&(typeof item.id!=='string'||!validId.test(item.id)))throw new Error('invalid_relay_id');
    const id=typeof item.id==='string'?item.id.toLowerCase():makeId();
    const name=typeof item.name==='string'?item.name.trim():'';
    if(!name||name.length>80||/[\u0000-\u001f\u007f]/.test(name))throw new Error('invalid_relay_name');
    const host=normalizeRelayHost(item.host),enabled=item.enabled!==false;
    if(Object.hasOwn(item,'enabled')&&typeof item.enabled!=='boolean')throw new Error('invalid_relay_enabled');
    if(ids.has(id)||hosts.has(host))throw new Error('duplicate_relay_target');
    ids.add(id);hosts.add(host);
    return {id,name,host,enabled};
  });
}
function directory(dataRoot){return path.join(path.resolve(dataRoot),'relay-bypass');}
export function relayHostRevision(hosts){return crypto.createHash('sha256').update(JSON.stringify([...hosts].sort())).digest('hex');}
export function relayConfigRevision(targets){return crypto.createHash('sha256').update(JSON.stringify(targets)).digest('hex');}
function atomicWrite(file,value){
  const temporary=file+'.pending';
  fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'w'});
  try{fs.renameSync(temporary,file);}catch(error){try{fs.rmSync(temporary,{force:true});}catch{}throw error;}
}
export function readRelayTargetConfig(dataRoot,legacyHosts=[]){
  const file=path.join(directory(dataRoot),'managed-targets.json');
  if(fs.existsSync(file)){
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(saved.version!==1)throw new Error('relay_config_unreadable');
    const targets=normalizeRelayTargets(saved.targets);
    return {version:1,targets,revision:relayConfigRevision(targets)};
  }
  const unique=[...new Set(Array.isArray(legacyHosts)?legacyHosts:[])];
  const targets=normalizeRelayTargets(unique.map(host=>{
    const hash=crypto.createHash('sha256').update(host).digest('hex');
    const id=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-${((parseInt(hash[16],16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}`;
    return {id,name:host,host,enabled:true};
  }));
  return {version:1,targets,revision:relayConfigRevision(targets)};
}
export function activeRelayHosts(settings){
  return readRelayTargetConfig(settings.DataRoot,settings.RelayHosts).targets.filter(target=>target.enabled).map(target=>target.host);
}
export function listRelayTargetBackups(dataRoot){
  const dir=path.join(directory(dataRoot),'backups');if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir,{withFileTypes:true}).filter(entry=>entry.isFile()&&/^targets-[a-f0-9-]{36}\.json$/i.test(entry.name)).map(entry=>{
    const full=path.join(dir,entry.name),stat=fs.statSync(full);let targets=0;
    try{targets=normalizeRelayTargets(JSON.parse(fs.readFileSync(full,'utf8')).targets).length;}catch{}
    return {id:entry.name.slice('targets-'.length,-'.json'.length),createdAt:stat.mtimeMs,targets};
  }).sort((a,b)=>b.createdAt-a.createdAt).slice(0,30);
}
export function saveRelayTargets(dataRoot,targets,{backup=true,now=Date.now(),legacyHosts=[],expectedRevision}={}){
  const normalized=normalizeRelayTargets(targets),dir=directory(dataRoot),file=path.join(dir,'managed-targets.json');
  fs.mkdirSync(dir,{recursive:true});
  let previous;
  try{previous=readRelayTargetConfig(dataRoot,legacyHosts);}catch{throw new Error('relay_config_unreadable');}
  if(expectedRevision!==undefined&&expectedRevision!==previous.revision)throw new Error('relay_config_conflict');
  if(backup){
    const backupDir=path.join(dir,'backups');fs.mkdirSync(backupDir,{recursive:true});
    const id=makeId();atomicWrite(path.join(backupDir,'targets-'+id+'.json'),{version:1,createdAt:now,targets:previous.targets});
  }
  atomicWrite(file,{version:1,updatedAt:now,targets:normalized});
  return {version:1,targets:normalized,revision:relayConfigRevision(normalized),backups:listRelayTargetBackups(dataRoot)};
}
export function restoreRelayTargets(dataRoot,id,{now=Date.now(),legacyHosts=[],expectedRevision}={}){
  if(typeof id!=='string'||!validId.test(id))throw new Error('invalid_relay_backup');
  const backup=path.join(directory(dataRoot),'backups','targets-'+id+'.json');
  if(!fs.existsSync(backup))throw new Error('relay_backup_not_found');
  const saved=JSON.parse(fs.readFileSync(backup,'utf8'));
  return saveRelayTargets(dataRoot,saved.targets,{backup:true,now,legacyHosts,expectedRevision});
}
export function requestRelayReconcile(dataRoot,{now=Date.now()}={}){
  const dir=directory(dataRoot);fs.mkdirSync(dir,{recursive:true});
  atomicWrite(path.join(dir,'refresh.request'),{at:now});
  return now;
}
