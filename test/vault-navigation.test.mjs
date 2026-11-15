import test from 'node:test';
import assert from 'node:assert/strict';
const values=new Map();
globalThis.sessionStorage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
globalThis.location={origin:'http://127.0.0.1:43131'};
const {safeReturnTarget,clearPrivatePage,setVaultToken,initializeVault,checkVaultResponse,hasVaultToken}=await import('../public/vault-browser.mjs');

test('unlock destinations preserve local views and dates while refusing external redirects',()=>{
  for(const destination of ['/','/overview?range=day&date=2026-11-12#ladder','/storage#backups','/legacy?lane=clash'])assert.equal(safeReturnTarget(destination),destination);
  for(const destination of [null,'https://example.test/','//example.test/','/\\example.test/','/security?return=/','/api/stop','/unknown','javascript:alert(1)','/overview/../../evil'])assert.equal(safeReturnTarget(destination),'');
});

test('opening, maintenance and denied-operation responses preserve a valid browser session; a real lock clears it',async()=>{
  const originalFetch=globalThis.fetch;let redirect;
  globalThis.fetch=async()=>new Response(JSON.stringify({configured:true,locked:false,ready:false,epoch:0}),{status:200});
  Object.assign(location,{pathname:'/diagnostics',search:'',hash:'',replace:value=>{redirect=value;}});
  globalThis.localStorage={removeItem(){}};globalThis.document={querySelector:()=>({replaceChildren(){}})};
  try{
    await initializeVault();setVaultToken('synthetic-navigation-session');
    for(const error of ['vault_migrating','vault_storage_busy','vault_busy','grant_forbidden']){
      await checkVaultResponse(new Response(JSON.stringify({error}),{status:423}));assert.equal(hasVaultToken(),true,error);assert.equal(redirect,undefined);
    }
    await checkVaultResponse(new Response(JSON.stringify({error:'vault_locked'}),{status:423}));assert.equal(hasVaultToken(),false);assert.equal(redirect,'/security?return=%2Fdiagnostics');
  }finally{globalThis.fetch=originalFetch;}
});

test('locking clears the owner session and returns to the exact protected view after unlock',()=>{
  let cleared=false,redirect;
  Object.assign(location,{pathname:'/overview',search:'?range=day&date=2026-11-12',hash:'#ladder',replace:value=>{redirect=value;}});
  globalThis.localStorage={removeItem(){}};globalThis.document={querySelector:()=>({replaceChildren:()=>{cleared=true;}})};
  setVaultToken('synthetic-test-session');clearPrivatePage();
  assert.equal(cleared,true);assert.equal(values.size,0);
  assert.equal(redirect,'/security?return='+encodeURIComponent('/overview?range=day&date=2026-11-12#ladder'));
});
