import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dpapi } from './vault-platform.mjs';

const args=process.argv.slice(2),action=args.shift()||'status';
function option(name,fallback){const index=args.indexOf('--'+name);if(index<0)return fallback;const value=args[index+1];if(!value||value.startsWith('--'))throw new Error('Missing --'+name);return value;}
const port=Number(option('port','43131'));if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port');
const profile=option('profile','default');if(!/^[a-zA-Z0-9_-]{1,64}$/.test(profile))throw new Error('Invalid credential profile');
const dir=path.join(process.env.LOCALAPPDATA||os.homedir(),'TrafficWatch','ai'),file=path.join(dir,profile+'.dpapi');
const save=value=>{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,dpapi(Buffer.from(JSON.stringify(value))));};
const load=()=>JSON.parse(dpapi(fs.readFileSync(file),{decrypt:true}).toString('utf8'));
async function api(route,{body,token}={}){
  const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:body===undefined?'GET':'POST',headers:{'x-codex-flow':'1',...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Local request failed');return result;
}
try{
  let result;
  if(action==='request'){
    const request=await api('/api/ai/request',{body:{name:option('name','AI 流量排查')}});save({request});
    result={pending:true,requestId:request.id,message:'请在流量中心 → 隐私与 AI 访客卡中批准这次申请。批准后运行 claim；无须发送密码或令牌。'};
  }else if(action==='claim'){
    const credentials=load();if(!credentials.request)throw new Error('No pending request');
    const claimed=await api('/api/ai/claim',{body:credentials.request});
    if(claimed.pending)result={pending:true,message:'等待本人在本机界面批准。'};
    else{save({token:claimed.token,grant:claimed.grant});result={grant:claimed.grant,message:'访客卡已保存在当前 Windows 用户的 DPAPI 保护区。'};}
  }else if(action==='status'){
    const credentials=load();result=await api('/api/ai/session',{token:credentials.token});
  }else if(['overview','detail','diagnostics','diagnostic-event','notes','create','update','delete-note','delete-history','rules'].includes(action)){
    const {token}=load();if(!token)throw new Error('Approve and claim a visitor card first');
    const input=option('input');const body=input?JSON.parse(fs.readFileSync(path.resolve(input),'utf8').replace(/^\uFEFF/,'')):{};
    if(['overview','detail','diagnostics','diagnostic-event'].includes(action)){
      const params=new URLSearchParams({range:option('range','all')});
      for(const name of ['lane','date','from','to','process','host','node','page','route','family','export','kind','category','provider','harness','gateway','cursor','limit','id']){const value=option(name);if(value!==undefined)params.set(name,value);}
      result=await api((action==='diagnostic-event'?'/api/diagnostics/event':'/api/'+action)+'?'+params,{token});
    }else if(action==='notes')result=await api('/api/ai/notes?'+new URLSearchParams({lane:option('lane','windows')}),{token});
    else if(action==='rules')result=await api('/api/harness-apps',{token,body});
    else if(action==='delete-history')result=await api('/api/ai/delete-history',{token,body});
    else result=await api('/api/ai/notes',{token,body:{...body,action,lane:option('lane',body.lane||'windows')}});
  }else throw new Error('Commands: request, claim, status, overview, detail, diagnostics, notes, create, update, delete-note, delete-history, rules');
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){process.stderr.write('TrafficWatch: '+error.message+'\n');process.exitCode=1;}
