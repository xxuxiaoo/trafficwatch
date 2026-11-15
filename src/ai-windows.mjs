import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function runJson(file,args=[],input,{timeout=20000,onRow}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{windowsHide:true,stdio:['pipe','pipe','ignore']});let pending='',bytes=0,rows=[],finished=false;
    const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(rows);};
    const timer=setTimeout(()=>finish(new Error('diagnostic_helper_timeout')),timeout);
    child.stdout.on('data',part=>{bytes+=part.length;if(bytes>8*1024*1024)return finish(new Error('diagnostic_helper_oversize'));pending+=part.toString('utf8');let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);try{const value=JSON.parse(line);rows.push(value);onRow?.(value);}catch{finish(new Error('diagnostic_helper_invalid'));}}});
    child.on('error',()=>finish(new Error('diagnostic_helper_missing')));child.on('close',code=>finish(code?new Error(rows.find(row=>typeof row.code==='string'&&/^[a-z_]+$/.test(row.code))?.code||'diagnostic_helper_failed'):null));
    child.stdin.on('error',()=>{});child.stdin.end(input===undefined?'':JSON.stringify(input)+'\n');
  });
}
export const networkHelper=()=>path.join(appRoot,'native','TrafficWatch-RelayProbe.exe');
export async function discoverPhysical(){const [value]=await runJson(networkHelper(),['discover']);if(!value?.adapters?.length)throw new Error('physical_adapter_unavailable');return value.adapters[0];}
export const physicalDns=async(host,adapter)=>{
  for(const resolver of ['223.5.5.5','1.1.1.1'])try{
    const [row]=await runJson(networkHelper(),[],{mode:'dns',host,localAddress:adapter.address,interfaceIndex:adapter.index,resolver},{timeout:7000});
    const valid=row.records?.filter(record=>record.type==='A'&&/^(?!0\.|10\.|127\.|169\.254\.|192\.168\.|198\.1[89]\.)\d{1,3}(?:\.\d{1,3}){3}$/.test(record.ip));
    if(valid?.length)return {...row,records:valid.slice(0,8),ipv6Records:row.records.filter(record=>record.type==='AAAA')};
  }catch{}
  throw new Error('physical_dns_unavailable');
};
export async function probeRelay(host,ip,adapter,{onConnected}={}) {
  const rows=await runJson(networkHelper(),[],{mode:'probe',host,ip,localAddress:adapter?.address||'',interfaceIndex:adapter?.index||0,hold:Boolean(onConnected)},{timeout:16000,onRow:value=>{if(value.kind==='connected')onConnected?.(value);}});
  const row=rows.find(row=>row.kind==='probe');if(!row)throw new Error('physical_probe_unavailable');return row;
}
export async function runNetworkScript(script,action,file,{timeout=20000}={}){
  const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const args=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(appRoot,'scripts',script),'-Action',action];if(file)args.push('-InputFile',file);
  return runJson(shell,args,undefined,{timeout});
}
export function readSettings(){const file=path.join(appRoot,'suite-settings.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};}
