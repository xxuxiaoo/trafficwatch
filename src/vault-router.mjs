import { intersectWindows,normalizeWindows } from './vault-grants.mjs';

export async function vaultRoute({req,url,json,vault,readJson,clearCache}){
  const route=url.pathname;
  if(!route.startsWith('/api/vault/')&&!route.startsWith('/api/ai/'))return false;
  const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
  const post=req.method==='POST',get=req.method==='GET';
  try{
    if(get&&route==='/api/vault/status'){json(200,vault.status());return true;}
    const body=post?await readJson(req,65536):{};
    if(post&&route==='/api/vault/setup'){json(200,await vault.setup(body.password,body.nonce));return true;}
    if(post&&route==='/api/vault/unlock'){json(200,await vault.unlock(body.password,body.recovery===true));return true;}
    if(get&&route==='/api/vault/session'){vault.owner(token);json(200,{owner:true});return true;}
    if(post&&route==='/api/ai/request'){json(200,vault.createRequest(body.name));return true;}
    if(post&&route==='/api/ai/claim'){json(200,vault.claimRequest(body.id,body.receipt));return true;}
    if(get&&route==='/api/ai/session'){
      const actor=vault.actor(token,{operation:'read'});json(200,actor.owner?{owner:true}:vault.grants.publicGrant(actor));return true;
    }
    if(route==='/api/ai/notes'){
      const operation=post?body.action==='delete-note'?'delete':body.action:'read';
      if(!['read','create','update','delete'].includes(operation))throw new Error('invalid_vault_operation');
      const lane=post?body.lane:url.searchParams.get('lane');
      if(!['windows','clash','diagnostics'].includes(lane))throw new Error('invalid_lane');
      const actor=vault.actor(token,{operation,lane});
      const windows=actor.owner?[{from:0,to:Math.ceil(Date.now()/60000)*60000}]:actor.windows;
      const result=await vault.callWriter({action:post?body.action:'notes',lane,windows,note:body.note});
      vault.actor(token,{operation,lane});vault.audit(actor.owner?'owner':actor.id,`notes-${operation}`,{lane});json(200,result);return true;
    }
    if(post&&route==='/api/ai/delete-history'){
      if(!['windows','clash'].includes(body.lane))throw new Error('invalid_lane');
      const actor=vault.actor(token,{operation:'deleteHistory',lane:body.lane});
      const requested=normalizeWindows(body.windows);
      const windows=actor.owner?requested:requested.flatMap(window=>intersectWindows(actor.windows,window.from,window.to));
      if(!windows.length)throw new Error('grant_date_forbidden');
      const result=await vault.callWriter({action:'delete-history',lane:body.lane,windows});
      clearCache();vault.audit(actor.owner?'owner':actor.id,'delete-history',{lane:body.lane,windows});json(200,result);return true;
    }
    vault.owner(token);
    if(get&&route==='/api/vault/storage'){
      const snapshot=await vault.readStorage(url.searchParams.get('fresh')==='1');vault.owner(token);
      json(200,snapshot);return true;
    }
    if(post&&route==='/api/vault/storage/policy'){
      const result=await vault.callWriter({action:'storage-policy',policy:body});vault.owner(token);json(200,result);return true;
    }
    if(post&&route.startsWith('/api/vault/storage/')){
      const operation=({'/api/vault/storage/run':'archive','/api/vault/storage/compact':'compact','/api/vault/storage/cache':'purge-cache'})[route];
      if(operation){const job=vault.startStorage(operation);clearCache();json(202,{job});return true;}
    }
    if(get&&route==='/api/vault/requests'){json(200,{requests:vault.pendingRequests(),grants:vault.grants.list(),linked:vault.linked===true});return true;}
    if(post&&route==='/api/vault/grants'){json(200,{grant:vault.approveRequest(body.requestId,body.grant)});return true;}
    if(post&&route==='/api/vault/revoke'){const grant=vault.grants.revoke(body.id);vault.audit('owner','grant-revoked',{id:body.id});json(200,{grant});return true;}
    if(post&&route==='/api/vault/lock'){vault.lock({force:body.force===true});json(200,{ok:true});return true;}
    if(post&&route==='/api/vault/linkage'){json(200,vault.setLinkage(body.enabled,body.template));return true;}
    if(post&&route==='/api/vault/password'){await vault.changePassword(body.password);vault.owner(token);json(200,{ok:true});return true;}
    if(get&&route==='/api/vault/audit'){const rows=await vault.callWriter({action:'audit-list'});vault.owner(token);json(200,{rows});return true;}
    if(post&&route==='/api/vault/cleanup'){const cleanup=vault.startCleanup();json(cleanup.state==='completed'?200:202,{ok:true,cleanup});return true;}
    json(404,{error:'not_found'});return true;
  }catch(error){
    const known=/^(vault_|grant_|windows_|setup_|wrong_password|password_|unlock_|invalid_|ai_request_|too_many_|ingest_)/.test(error.message);
    json(error.message==='wrong_password'?401:error.message==='vault_locked'?423:400,{error:known?error.message:'vault_operation_failed'});return true;
  }
}
