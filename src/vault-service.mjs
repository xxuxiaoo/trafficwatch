import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createVaultKeys,unlockVaultKeys,changeVaultPassword,randomToken,tokenDigest,openPacket } from './vault-crypto.mjs';
import { GrantRegistry } from './vault-grants.mjs';
import { vaultKeyEntries } from './vault-migration.mjs';
import { SessionGuard,dpapi,ownerIdentity,guardPath } from './vault-platform.mjs';
import { removeSummaryCache } from './storage-files.mjs';

export class VaultService {
  constructor({dataRoot,cacheRoot,ownerSid,onKeys=()=>{},onLock=()=>{},onMaintenance=()=>{},guardFactory,waitForCollectors}) {
    Object.assign(this,{dataRoot,cacheRoot,onKeys,onLock,onMaintenance,waitForCollectors});
    this.dir=path.join(dataRoot,'vault');this.file=path.join(this.dir,'vault.json');
    this.metadata=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):null;
    this.ownerSid=this.metadata?.ownerSid||ownerSid||(process.platform==='win32'&&fs.existsSync(guardPath)?ownerIdentity():'');
    this.owners=new Map();this.requests=new Map();this.grants=new GrantRegistry();this.locked=true;this.windows='unknown';this.ready=false;
    this.writerPending=new Map();this.writerSequence=0;this.epoch=0;this.unlockFailures=0;this.nextUnlock=0;
    this.guard=guardFactory?guardFactory(status=>this.sessionChanged(status)):new SessionGuard(this.ownerSid,status=>this.sessionChanged(status));
    this.guard.start();
    this.timer=setInterval(()=>{
      for(const [id,request] of this.requests)if(Date.now()>request.expiresAt)this.requests.delete(id);
      if(this.locked&&!this.grants.needsKeysWhileLocked()&&this.secrets)this.dropKeys();
    },1000).unref();
  }
  get configured(){return Boolean(this.metadata);}
  status(){return {configured:this.configured,locked:this.locked,windows:this.windows,ready:this.ready,epoch:this.epoch,initialization:this.initialization||null,backgroundImport:this.backgroundImport||null,migration:this.progress||null,cleanup:this.cleanupJob?{...this.cleanupJob}:null,linked:this.linked===true,plaintextCleanupPending:this.configured&&!this.metadata.cleanupComplete};}
  sessionChanged(status){
    const old=this.windows;this.windows=status.state;
    if(status.reset||['unknown','logged_out'].includes(status.state)&&(old!==status.state||this.secrets))this.lock({force:true});
    else if(status.state!=='unlocked'&&(old==='unlocked'||!this.locked))this.lock();
  }
  lock({force=false}={}){
    this.locked=true;this.owners.clear();this.epoch++;this.linked=false;this.grants.lock({force});this.onLock();
    if(force||!this.grants.needsKeysWhileLocked())this.dropKeys();
    this.audit('owner',force?'lock-and-revoke':'lock',{continued:this.grants.needsKeysWhileLocked()});
  }
  dropKeys(){
    if(this.storageJob?.state==='running')Object.assign(this.storageJob,{state:'paused',error:'vault_locked',updatedAt:Date.now()});
    this.ready=false;this.progress=null;this.initialization=null;this.backgroundImport=null;this.writer?.terminate();this.writer=null;
    for(const pending of this.writerPending.values())pending.reject(new Error('vault_locked'));
    this.writerPending.clear();
    for(const [,key] of this.keyEntries||[])key.fill(0);this.keyEntries=[];
    if(this.secrets){this.secrets.master='';this.secrets.privateKey='';this.secrets.commandKey='';this.secrets=null;}
    this.onKeys([]);
  }
  owner(token){
    const session=typeof token==='string'&&this.owners.get(tokenDigest(token));
    if(this.locked||this.windows!=='unlocked'||!session||session.expiresAt<=Date.now()||session.epoch!==this.epoch)throw new Error('vault_locked');
    return {owner:true,name:'本人'};
  }
  actor(token,request={}){
    try{return this.owner(token);}catch{}
    if(!this.secrets||!this.ready)throw new Error('vault_locked');
    return this.grants.authenticate(token,{...request,locked:this.locked});
  }
  async setup(password,nonce){
    if(this.configured)throw new Error('vault_already_configured');
    if(this.windows!=='unlocked')throw new Error('windows_unlock_required');
    const ticketFile=path.join(this.dir,'setup-ticket.json');
    const ticket=fs.existsSync(ticketFile)?JSON.parse(fs.readFileSync(ticketFile,'utf8')):null;
    if(!ticket||ticket.expiresAt<Date.now()||ticket.ownerSid!==this.ownerSid||tokenDigest(nonce)!==ticket.digest)throw new Error('setup_launcher_required');
    if(this.busy)throw new Error('vault_busy');this.busy=true;
    const epoch=this.epoch;
    try{
      const created=await createVaultKeys(password,this.ownerSid);
      if(this.epoch!==epoch||this.windows!=='unlocked')throw new Error('windows_unlock_required');
      const signing=crypto.generateKeyPairSync('ed25519');
      created.metadata.capturePublicKey=signing.publicKey.export({type:'spki',format:'pem'});
      fs.mkdirSync(this.dir,{recursive:true});
      fs.writeFileSync(path.join(this.dir,'capture-signing.dpapi'),dpapi(signing.privateKey.export({type:'pkcs8',format:'pem'}),{scope:'machine'}));
      fs.writeFileSync(this.file+'.pending',JSON.stringify(created.metadata));fs.renameSync(this.file+'.pending',this.file);
      this.metadata=created.metadata;fs.unlinkSync(ticketFile);
      // Source files are read only after both collectors have stopped writing
      // plaintext and acknowledged the public-key envelope store.
      await this.waitForCollectors?.();
      if(this.epoch!==epoch||this.windows!=='unlocked')throw new Error('windows_unlock_required');
      this.activate(created.secrets);return {...this.newOwner(),recoveryCode:created.recoveryCode};
    }finally{this.busy=false;}
  }
  newOwner(){const token=randomToken(),expiresAt=Date.now()+12*3600000;this.owners.set(tokenDigest(token),{epoch:this.epoch,expiresAt});return {token,sessionExpiresAt:expiresAt,...this.status()};}
  async unlock(password,recovery=false){
    if(!this.configured)throw new Error('vault_not_configured');
    if(this.windows!=='unlocked')throw new Error('windows_unlock_required');
    if(this.busy||Date.now()<this.nextUnlock)throw new Error('unlock_rate_limited');
    this.busy=true;const epoch=this.epoch;
    try{
      const secrets=await unlockVaultKeys(this.metadata,password,recovery);
      if(this.epoch!==epoch||this.windows!=='unlocked')throw new Error('windows_unlock_required');
      await this.waitForCollectors?.();
      if(this.epoch!==epoch||this.windows!=='unlocked')throw new Error('windows_unlock_required');
      this.unlockFailures=0;this.nextUnlock=0;
      if(!this.secrets)this.activate(secrets);else this.locked=false;
      return this.newOwner();
    }catch(error){this.unlockFailures++;this.nextUnlock=Date.now()+Math.min(60000,1000*2**Math.min(6,this.unlockFailures-1));throw error;}
    finally{this.busy=false;}
  }
  activate(secrets){
    this.ready=false;this.progress=null;this.initialization={phase:'opening'};this.backgroundImport=null;
    this.secrets=secrets;this.locked=false;this.keyEntries=vaultKeyEntries(this.dataRoot,secrets,this.cacheRoot);this.onKeys(this.keyEntries);
    const writer=this.writer=new Worker(new URL('./vault-writer.mjs',import.meta.url),{workerData:{dataRoot:this.dataRoot,metadata:this.metadata,secrets},resourceLimits:{maxOldGenerationSizeMb:256}});
    writer.on('message',message=>{
      if(this.writer!==writer)return;
      if(message.event==='ready'){this.ready=true;this.progress=null;this.initialization=null;this.backgroundImport=message.backgroundImport||null;this.audit('owner','unlock');}
      else if(message.event==='import-progress'){const {event,...progress}=message;this.backgroundImport=progress;}
      else if(message.event==='progress'){
        this.initialization={phase:message.phase||'migration',lane:message.lane,table:message.table};
        this.progress=this.initialization.phase==='migration'?{...this.initialization}:null;
      }
      else if(message.event==='cleanup-progress'&&this.cleanupJob?.state==='running')Object.assign(this.cleanupJob,{stage:message.stage,lane:message.lane,updatedAt:Date.now()});
      else if(message.event==='storage-progress')this.storageJob={...message,event:undefined};
      else if(message.event==='failed'){this.progress={error:message.error};this.lock({force:true});}
      else if(message.id){const pending=this.writerPending.get(message.id);if(pending){this.writerPending.delete(message.id);message.error?pending.reject(new Error(message.error)):pending.resolve(message.result);}}
    });
    const fail=()=>{if(this.writer===writer){this.progress={error:'vault_writer_stopped'};this.lock({force:true});}};
    writer.on('error',fail);writer.on('exit',fail);
  }
  callWriter(request){
    if(!this.ready||!this.writer)return Promise.reject(new Error('vault_migrating'));
    if(this.writerPending.size>=64)return Promise.reject(new Error('vault_busy'));
    const id=++this.writerSequence;
    return new Promise((resolve,reject)=>{this.writerPending.set(id,{resolve,reject});this.writer.postMessage({id,...request});});
  }
  audit(actor,operation,detail={}){this.callWriter({action:'audit',actor,operation,detail}).catch(()=>{});}
  startCleanup(){
    if(this.metadata?.cleanupComplete)return {state:'completed',stage:'complete'};
    if(this.cleanupJob?.state==='running')return {...this.cleanupJob};
    if(!this.ready||!this.writer)throw new Error('vault_migrating');
    const job=this.cleanupJob={state:'running',stage:'preparing',lane:null,startedAt:Date.now(),updatedAt:Date.now()};
    // The owner authorizes submission, not a browser-held minute-long request.
    // Completion remains tracked even when the tab closes or its fetch aborts.
    this.cleanupPromise=this.callWriter({action:'cleanup'}).then(()=>{
      this.markCleanupComplete();Object.assign(job,{state:'completed',stage:'complete',lane:null,updatedAt:Date.now()});
      this.audit('owner','plaintext-cleaned');
    }).catch(error=>{
      const interrupted=['vault_locked','vault_writer_stopped'].includes(error.message);
      Object.assign(job,{state:interrupted?'paused':'failed',error:interrupted?'vault_locked':error.message==='vault_backup_busy'?'vault_backup_busy':'vault_cleanup_failed',updatedAt:Date.now()});
    });
    return {...job};
  }
  startStorage(operation){
    if(!['archive','compact','purge-cache'].includes(operation))throw new Error('invalid_storage_operation');
    if(this.storagePromise)return {...this.storageJob};
    if(operation==='archive'&&this.storageJob?.state==='running')return {...this.storageJob};
    if(!this.ready||!this.writer)throw new Error('vault_migrating');
    if(this.cleanupJob?.state==='running')throw new Error('vault_storage_busy');
    this.storageJob={state:'running',operation,stage:'preparing',startedAt:Date.now(),updatedAt:Date.now()};
    const maintenance=operation!=='archive',epoch=this.epoch;
    if(maintenance)this.storageBusy=true;
    this.storagePromise=(async()=>{
      try{
        this.storageSnapshot=await this.callWriter({action:'storage-status',fresh:true});
        if(maintenance)await this.onMaintenance(true);
        if(this.epoch!==epoch||!this.secrets)throw new Error('vault_locked');
        let result;
        if(operation==='purge-cache') {
          if(this.cacheRoot)removeSummaryCache(path.join(this.cacheRoot,'windows-programs-v2.sqlite'));
          result={ok:true};
        }else result=await this.callWriter({action:operation==='archive'?'storage-run':'storage-compact'});
        this.storageJob={...this.storageJob,state:'completed',stage:'complete',result,updatedAt:Date.now()};
        this.audit('owner','storage-'+operation);
      }catch(error){
        const interrupted=['vault_locked','vault_writer_stopped'].includes(error.message);
        this.storageJob={...this.storageJob,state:interrupted?'paused':'failed',error:error.message,updatedAt:Date.now()};
      }finally{
        if(maintenance){this.storageBusy=false;if(this.epoch===epoch&&this.secrets)await this.onMaintenance(false);}
        this.storagePromise=null;
      }
    })();
    return {...this.storageJob};
  }
  async readStorage(fresh=false){
    if(this.storageJob?.state==='running'&&this.storageSnapshot)return {...this.storageSnapshot,job:this.storageJob};
    const snapshot=await this.callWriter({action:'storage-status',fresh});this.storageSnapshot=snapshot;
    return {...snapshot,job:this.storageJob||snapshot.job};
  }
  createRequest(name){
    if(this.requests.size>=64)throw new Error('too_many_requests');
    const id=crypto.randomUUID(),receipt=randomToken();
    const request={id,name:String(name||'AI 排查').slice(0,80),createdAt:Date.now(),expiresAt:Date.now()+10*60000,receiptDigest:tokenDigest(receipt)};
    this.requests.set(id,request);
    if(this.linked&&!this.locked&&this.windows==='unlocked'&&this.linkTemplate)this.approveRequest(id,{...this.linkTemplate,name:request.name,linked:true});
    return {id,receipt,expiresAt:request.expiresAt};
  }
  pendingRequests(){return [...this.requests.values()].map(({receiptDigest,issued,...request})=>({...request,approved:Boolean(issued)}));}
  approveRequest(id,input){
    const request=this.requests.get(id);if(!request||request.expiresAt<=Date.now()||request.issued)throw new Error('ai_request_not_found');
    const issued=this.grants.issue(input);request.issued=issued;request.expiresAt=issued.grant.expiresAt;
    this.audit('owner','grant-issued',{id:issued.grant.id,...issued.grant});return issued.grant;
  }
  claimRequest(id,receipt){
    const request=this.requests.get(id);if(!request||request.expiresAt<=Date.now()||tokenDigest(receipt)!==request.receiptDigest)throw new Error('ai_request_not_found');
    if(!request.issued)return {pending:true};
    this.grants.authenticate(request.issued.token,{locked:this.locked});
    const result=request.issued;this.requests.delete(id);return result;
  }
  setLinkage(enabled,template){
    this.linked=enabled===true;this.linkTemplate=this.linked?structuredClone(template):null;
    if(this.linked){const trial=this.grants.issue(template);this.grants.revoke(trial.grant.id);}
    return {enabled:this.linked};
  }
  async changePassword(password){const epoch=this.epoch,updated=await changeVaultPassword(this.metadata,this.secrets,password);if(this.locked||this.epoch!==epoch)throw new Error('vault_locked');fs.writeFileSync(this.file+'.pending',JSON.stringify(updated));fs.renameSync(this.file+'.pending',this.file);this.metadata=updated;}
  markCleanupComplete(){this.metadata.cleanupComplete=true;fs.writeFileSync(this.file+'.pending',JSON.stringify(this.metadata));fs.renameSync(this.file+'.pending',this.file);}
  decryptLive(data){return data?.app==='trafficwatch-sealed-live'&&this.secrets?openPacket(data.packet,this.secrets.privateKey):data;}
  close(){clearInterval(this.timer);this.guard.close();this.lock({force:true});}
}
