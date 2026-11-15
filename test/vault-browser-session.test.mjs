import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/vault-browser.mjs',import.meta.url),'utf8').replaceAll('export ','');
const sharedKey='trafficwatch-owner-session-v1',tabKey='trafficwatch-owner-session';
const storage=values=>({getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)});
function browserTab(shared,{legacy='',state={configured:true,locked:false,epoch:0},owner=true,blockedStorage=false}={}){
  const tab=new Map(legacy?[[tabKey,legacy]]:[]),handlers=new Map(),calls=[],redirects=[];let cleared=false;
  const context=vm.createContext({
    sessionStorage:storage(tab),localStorage:blockedStorage?{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');}}:storage(shared),
    location:{origin:'http://127.0.0.1:43131',pathname:'/diagnostics',search:'',hash:'',replace:value=>redirects.push(value)},
    document:{querySelector:()=>({replaceChildren(){cleared=true;}})},
    fetch:async(route,options)=>{calls.push({route,authorization:options?.headers?.Authorization});return new Response(JSON.stringify(route==='/api/vault/status'?state:owner==='visitor'?{lanes:['clash'],active:true}:owner?{owner:true}:{error:'vault_locked'}),{status:route==='/api/vault/status'||owner?200:423});},
    setInterval(){},URL,AbortSignal,Date,Response,addEventListener:(name,callback)=>handlers.set(name,callback),
  });
  vm.runInContext(source+'\nglobalThis.sessionApi={initializeVault,setVaultToken,hasVaultToken,vaultHeaders,clearPrivatePage};',context);
  return {api:context.sessionApi,tab,calls,redirects,handlers,cleared:()=>cleared};
}

test('closing a tab and opening a fresh one restores the owner session only after server validation',async()=>{
  const shared=new Map(),first=browserTab(shared),deadline=Date.now()+3600000;
  first.api.setVaultToken('synthetic-tab-session',deadline);
  const reopened=browserTab(shared);assert.equal(reopened.tab.size,0,'new tabs begin without sessionStorage');
  await reopened.api.initializeVault({overview:true});
  assert.equal(reopened.api.vaultHeaders().Authorization,'Bearer synthetic-tab-session');
  assert.equal(reopened.calls.find(call=>call.route==='/api/vault/session').authorization,'Bearer synthetic-tab-session');
  assert.equal(JSON.parse(shared.get(sharedKey)).expiresAt,deadline,'reopening never extends the original expiry');
  assert.deepEqual(reopened.redirects,[]);
});

test('an existing tab-only credential is migrated without another password and blocked browser storage still permits the current tab',async()=>{
  const shared=new Map(),oldTab=browserTab(shared,{legacy:'synthetic-legacy-session'});await oldTab.api.initializeVault();
  assert.equal(JSON.parse(shared.get(sharedKey)).token,'synthetic-legacy-session');
  const restricted=browserTab(new Map(),{blockedStorage:true});restricted.api.setVaultToken('synthetic-memory-session');await restricted.api.initializeVault();assert.equal(restricted.api.hasVaultToken(),true);
});

test('closed-window credentials cannot reopen after lock, service restart or expiry',async()=>{
  for(const mode of ['lock','restart','expiry']){
    const shared=new Map([[sharedKey,JSON.stringify({token:'synthetic-old-session',expiresAt:Date.now()+(mode==='expiry'?-1000:3600000)})]]);
    const reopened=browserTab(shared,{state:{configured:true,locked:mode==='lock',epoch:mode==='lock'?1:0},owner:mode!=='restart'});
    await reopened.api.initializeVault();assert.equal(reopened.api.hasVaultToken(),false,mode);assert.equal(shared.has(sharedKey),false,mode);
  }
});

test('a visitor token cannot restore an owner UI and a lock in another tab clears visible private content',async()=>{
  const shared=new Map([[sharedKey,JSON.stringify({token:'synthetic-shared-session',expiresAt:Date.now()+3600000})]]),visitor=browserTab(shared);
  // An authenticated visitor response is intentionally distinct from owner:true.
  const visitorContext=browserTab(shared,{owner:'visitor'});await visitorContext.api.initializeVault();assert.equal(visitorContext.api.hasVaultToken(),false);
  visitor.api.setVaultToken('synthetic-owner-session');await visitor.api.initializeVault({overview:true});shared.delete(sharedKey);
  visitor.handlers.get('storage')({key:sharedKey,newValue:null});
  assert.equal(visitor.api.hasVaultToken(),false);assert.equal(visitor.cleared(),true);assert.equal(visitor.tab.has(tabKey),false);assert.equal(visitor.redirects[0],'/security?return=%2Fdiagnostics');
});
