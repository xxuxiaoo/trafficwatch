const tabSessionKey='trafficwatch-owner-session',sharedSessionKey='trafficwatch-owner-session-v1';
const sessionLifetime=12*3600000;
function stored(storage,key){try{return globalThis[storage]?.getItem(key)||'';}catch{return '';}}
function store(storage,key,value){try{if(value)globalThis[storage]?.setItem(key,value);else globalThis[storage]?.removeItem(key);}catch{/* The current tab can still use its in-memory session. */}}
function sharedSession(){
  try{
    const value=JSON.parse(stored('localStorage',sharedSessionKey)||'null');
    if(value&&typeof value.token==='string'&&value.token.length>0&&value.token.length<=256&&Number.isFinite(value.expiresAt)&&value.expiresAt>Date.now()&&value.expiresAt<=Date.now()+sessionLifetime+60000)return value;
  }catch{/* Invalid or expired browser state is never an unlock credential. */}
  store('localStorage',sharedSessionKey,'');return null;
}
let token=sharedSession()?.token||stored('sessionStorage',tabSessionKey),configured=false,protectedPage=false,redirecting=false;
export const vaultHeaders=()=>token?{Authorization:`Bearer ${token}`} : {};
export const hasVaultToken=()=>Boolean(token);
export function setVaultToken(value,expiresAt){
  token=value||'';store('sessionStorage',tabSessionKey,token);
  if(token){
    redirecting=false;
    const previous=sharedSession();
    const deadline=Number.isFinite(expiresAt)?expiresAt:previous?.token===token?previous.expiresAt:Date.now()+sessionLifetime;
    store('localStorage',sharedSessionKey,JSON.stringify({token,expiresAt:Math.min(deadline,Date.now()+sessionLifetime)}));
  }else store('localStorage',sharedSessionKey,'');
}
async function verifyOwnerSession(){
  const response=await fetch('/api/vault/session',{headers:{'x-codex-flow':'1',...vaultHeaders()},cache:'no-store',signal:AbortSignal.timeout(5000)});
  if([401,423].includes(response.status))return false;
  if(!response.ok)throw new Error('vault_session_unavailable');
  return (await response.json()).owner===true;
}
export function safeReturnTarget(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('\\'))return '';
  try{
    const url=new URL(value,location.origin);
    return url.origin===location.origin&&['/','/overview','/storage','/legacy','/diagnostics'].includes(url.pathname)?url.pathname+url.search+url.hash:'';
  }catch{return '';}
}
export function clearPrivatePage(){
  if(redirecting)return;redirecting=true;
  setVaultToken('');
  store('localStorage','trafficwatch-snapshots-v7','');
  globalThis.dispatchEvent?.(new Event('trafficwatch-vault-locked'));
  const shell=document.querySelector('.app-shell');if(shell)shell.replaceChildren();else document.body?.replaceChildren();
  const target=safeReturnTarget(location.pathname+location.search+location.hash)||'/';
  location.replace('/security?return='+encodeURIComponent(target));
}
export async function initializeVault({overview=false,onStatus=()=>{}}={}){
  protectedPage=overview;
  const response=await fetch('/api/vault/status',{headers:{'x-codex-flow':'1'},cache:'no-store',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('vault_status_unavailable');
  const status=await response.json();configured=status.configured;
  store('localStorage','trafficwatch-snapshots-v7','');
  if(configured){
    if(status.locked)setVaultToken('');
    else if(token){
      // Browser storage remembers only this temporary session, never a password
      // or a history key. The server must still recognize it as the owner.
      if(await verifyOwnerSession())setVaultToken(token);else setVaultToken('');
    }
  }
  if(overview&&configured&&(status.locked||!token)){clearPrivatePage();await new Promise(()=>{});}
  onStatus(status);
  if(overview&&configured){
    setInterval(async()=>{
      try{
        const response=await fetch('/api/vault/status',{headers:{'x-codex-flow':'1'},cache:'no-store',signal:AbortSignal.timeout(3000)});
        const value=await response.json();if(redirecting)return;if(value.locked||value.epoch!==status.epoch)clearPrivatePage();else onStatus(value);
      }catch{clearPrivatePage();}
    },2000);
  }
  return status;
}
globalThis.addEventListener?.('storage',event=>{
  if(event.key!==sharedSessionKey&&event.key!==null)return;
  token=sharedSession()?.token||'';store('sessionStorage',tabSessionKey,token);
  if(configured&&protectedPage&&!token)clearPrivatePage();
});
export async function checkVaultResponse(response){
  if(!configured||![401,423].includes(response.status))return;
  const value=await response.clone().json().catch(()=>({}));
  // Opening a database, maintenance and a denied operation do not expire the
  // owner's session. Preserve the token unless authentication itself failed.
  if(response.status===401||!value.error||value.error==='vault_locked')clearPrivatePage();
}
