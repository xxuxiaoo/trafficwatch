import {signCommand} from './vault-commands.mjs';
import {readRelayHealth} from './relay-health.mjs';

export async function diagnosticRoute({req,url,json,vault,readJson,dataRoot,token}){
  if(!url.pathname.startsWith('/api/diagnostics'))return false;
  try{
    const operation=url.pathname==='/api/diagnostics/attachment/delete'?'deleteHistory':req.method==='POST'?'create':url.pathname==='/api/diagnostics/attachment'||url.searchParams.get('export')==='1'?'export':'read';
    const actor=vault.actor(token,{lane:'diagnostics',operation});
    if(!vault.configured)throw new Error('vault_migrating');
    if(req.method==='GET'&&url.pathname==='/api/diagnostics/status'){
      // Historical visitor scopes do not implicitly grant unrestricted live observations.
      if(!actor.owner){json(200,{liveAvailable:false,message:'访客卡只查询授权日期内的记录。'});return true;}
      let collector=null,bypass=null;
      try{const response=await fetch('http://127.0.0.1:43132/api/health',{signal:AbortSignal.timeout(1200)});collector=await response.json();}catch{}
      bypass=readRelayHealth(dataRoot);
      vault.actor(token,{lane:'diagnostics',operation});json(200,{collector,bypass,liveAvailable:true});return true;
    }
    if(!vault.ready)throw new Error('vault_migrating');
    if(req.method==='POST'&&url.pathname==='/api/diagnostics/mark'){
      // A mark captures the present. It must fall in this card's exact dates.
      const now=Date.now();vault.actor(token,{lane:'diagnostics',operation:'create',from:now,to:now+1});
      await readJson(req);const body={};
      const response=await fetch('http://127.0.0.1:43132/api/mark',{method:'POST',headers:{'x-codex-flow':'1','content-type':'application/json','x-trafficwatch-command':signCommand('/api/mark',body,vault.secrets)},body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
      vault.actor(token,{lane:'diagnostics',operation:'create',from:now,to:now+1});json(response.status,await response.json());return true;
    }
    if(req.method==='GET'&&['/api/diagnostics','/api/diagnostics/event'].includes(url.pathname)){
      const windows=actor.owner?[{from:0,to:Math.ceil(Date.now()/60000)*60000}]:actor.windows,options={};
      for(const key of ['from','to','kind','provider','harness','gateway','category','limit'])if(url.searchParams.has(key))options[key]=url.searchParams.get(key);
      if(url.searchParams.has('cursor'))options.cursor=JSON.parse(url.searchParams.get('cursor'));
      if(url.pathname==='/api/diagnostics/event')options.eventId=url.searchParams.get('id');
      const result=await vault.callWriter({action:'diagnostic-query',windows,...options,owner:actor.owner===true});
      vault.actor(token,{lane:'diagnostics',operation});vault.audit(actor.owner?'owner':actor.id,'diagnostic-'+operation,{from:options.from,to:options.to});json(200,{...result,backgroundImport:vault.backgroundImport?{state:vault.backgroundImport.state}:null});return true;
    }
    if(req.method==='GET'&&url.pathname==='/api/diagnostics/attachment'){
      const windows=actor.owner?[{from:0,to:Math.ceil(Date.now()/60000)*60000}]:actor.windows;
      const result=await vault.callWriter({action:'diagnostic-attachment',attachmentId:url.searchParams.get('id'),windows});
      vault.actor(token,{lane:'diagnostics',operation:'export'});vault.audit(actor.owner?'owner':actor.id,'diagnostic-attachment-export');json(200,result);return true;
    }
    if(req.method==='POST'&&url.pathname==='/api/diagnostics/attachment/delete'){
      const body=await readJson(req),windows=actor.owner?[{from:0,to:Math.ceil(Date.now()/60000)*60000}]:actor.windows;
      const result=await vault.callWriter({action:'diagnostic-delete-attachment',attachmentId:body.id,windows});
      vault.actor(token,{lane:'diagnostics',operation:'deleteHistory'});vault.audit(actor.owner?'owner':actor.id,'diagnostic-attachment-delete');json(200,result);return true;
    }
    json(404,{error:'not_found'});return true;
  }catch(error){json(['vault_migrating','vault_busy','vault_storage_busy'].includes(error.message)?503:/^(vault_|grant_)/.test(error.message)?423:400,{error:/^(vault_|grant_|invalid_)/.test(error.message)?error.message:'diagnostics_unavailable'});return true;}
}
