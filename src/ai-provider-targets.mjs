// Extract endpoint hostnames and public provider labels only. Credentials,
// website links and inactive API variants must never determine a request target.
const endpointFields=['baseURL','base_url','apiBase','api_base','endpoint','url'];
const protocols=['responses','chat','anthropic','openai','gemini','completions'];
const containers=['config','settings','configuration','endpoints'];
const alias=value=>typeof value==='string'?value.replace(/[\x00-\x1f]/g,' ').trim().slice(0,96).toLowerCase():'';
function hostname(value){
  if(typeof value!=='string'||!/^https?:\/\//i.test(value.trim()))return null;
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.hostname.toLowerCase().replace(/\.$/,''):null;}catch{return null;}
}
function property(node,name){const key=Object.keys(node).find(key=>key.toLowerCase()===name.toLowerCase());return key===undefined?undefined:node[key];}
function endpoint(value,depth=0){
  const direct=hostname(value);if(direct)return direct;
  if(!value||typeof value!=='object'||Array.isArray(value)||depth>3)return null;
  const found=new Set(endpointFields.map(key=>endpoint(property(value,key),depth+1)).filter(Boolean));
  return found.size===1?[...found][0]:null;
}
function providerHost(node,depth=0){
  if(!node||typeof node!=='object'||Array.isArray(node)||depth>4)return null;
  const selection=property(node,'baseAPI');
  if(typeof selection==='string'&&!hostname(selection)){
    const selected=protocols.find(key=>key===selection.trim().toLowerCase());
    if(selected)return endpoint(property(node,selected));
  }
  const found=new Set([...endpointFields,'baseAPI',...protocols].map(key=>endpoint(property(node,key))).filter(Boolean));
  for(const key of containers){const host=providerHost(property(node,key),depth+1);if(host)found.add(host);}
  return found.size===1?[...found][0]:null;
}
export function buildProviderTargets(value,hosts=[]){
  const allowed=new Set(hosts.map(host=>hostname('https://'+host)).filter(Boolean)),candidates=new Map();
  const add=(provider,key='')=>{
    if(!provider||typeof provider!=='object'||Array.isArray(provider))return;
    const host=providerHost(provider);if(!host||!allowed.has(host))return;
    const labels=[key,provider.id,provider.name,provider.label,...(Array.isArray(provider.was)?provider.was:[])];
    for(const label of labels){const normalized=alias(label);if(!normalized)continue;if(!candidates.has(normalized))candidates.set(normalized,new Set());candidates.get(normalized).add(host);}
  };
  const providers=value?.providers??value;
  if(Array.isArray(providers))for(const provider of providers)add(provider);
  else if(providers&&typeof providers==='object'){
    if(providerHost(providers))add(providers);
    else for(const [key,provider]of Object.entries(providers))add(provider,key);
  }
  // A reused display name must not silently select whichever provider came last.
  return new Map([...candidates].filter(([,values])=>values.size===1).map(([label,values])=>[label,[...values][0]]));
}
export function mappedProviderHost(targets,provider){return targets.get(alias(provider))||null;}
