import fs from 'node:fs';
import path from 'node:path';

const errors=new Set(['physical_adapter_unavailable','physical_adapter_changed','physical_dns_unavailable','relay_resolution_incomplete','relay_route_verification_failed','relay_routes_failed','administrator_required','managed_hosts_modified','existing_hosts_conflict','relay_targets_changed','relay_rollback_failed','clash_controller_unavailable','clash_controller_unauthorized','clash_multiple_active_tun','clash_client_unsupported','clash_config_identity_mismatch','clash_profile_script_not_configured','clash_profile_script_unsupported','clash_dns_filter_unsupported','controller_timeout','controller_invalid','controller_oversize','controller_http_401','controller_http_403','controller_http_404','controller_http_400','controller_http_500','relay_connections_still_in_clash','flclash_controller_disabled','flclash_controller_unavailable','bypass_validation_failed']);
export function relayErrorCode(error){
  const value=typeof error==='string'?error:error?.message;
  if(errors.has(value))return value;
  const code=typeof error==='object'?error?.code:null;
  if(['EACCES','EPERM'].includes(code))return 'relay_access_denied';
  if(['ECONNREFUSED','ENOENT','ECONNRESET','EPIPE'].includes(code))return 'clash_controller_unavailable';
  return 'bypass_validation_failed';
}
export function relayCheckFailures(check){
  if(check.verified)return [];
  const reasons=[];
  if(check.routePhysical===false)reasons.push('route_not_physical');
  if(check.systemDnsMatches===false)reasons.push('system_dns_mismatch');
  if(!check.probe||check.probe.phase!=='complete'||check.probe.errorType)reasons.push('physical_probe_failed');
  if(check.sourceMatches===false)reasons.push('probe_source_mismatch');
  if(check.seenInClash===null)reasons.push('clash_observation_unavailable');
  if(check.seenInClash===true||check.ordinarySeenInClash===true)reasons.push('relay_connections_still_in_clash');
  if(check.ipv6Unmanaged)reasons.push('ipv6_unmanaged');
  if(check.ordinaryVerified===false)reasons.push('ordinary_path_unverified');
  return reasons.length?reasons:['target_validation_incomplete'];
}
export function relayResultHealth(result){
  const failures=new Map();
  const add=code=>failures.set(code,(failures.get(code)||0)+1);
  for(const error of result.errors||[])add(relayErrorCode(error.code));
  for(const check of result.checks||[])for(const code of relayCheckFailures(check))add(code);
  return {state:result.state,stage:'complete',client:result.overlay?.client||result.client||null,targets:result.targets?.length||0,
    verified:result.checks?.length?result.checks.filter(check=>check.verified).length:undefined,
    checkedAt:result.at,failures:[...failures].map(([code,count])=>({code,count})),lastVerifiedAt:result.state==='verified'?result.at:result.lastVerifiedAt||null};
}
export function readRelayHealth(dataRoot,now=Date.now()){
  try{
    const value=JSON.parse(fs.readFileSync(path.join(dataRoot,'relay-bypass','status.json'),'utf8'));
    const codes=new Set([...errors,'relay_access_denied','route_not_physical','system_dns_mismatch','physical_probe_failed','probe_source_mismatch','clash_observation_unavailable','ipv6_unmanaged','ordinary_path_unverified','target_validation_incomplete']);
    const states=new Set(['checking','verified','degraded','stale','route_checked','rolled_back','stopped']);
    return {state:now-value.at>150000?'stale':states.has(value.state)?value.state:'degraded',at:Number.isFinite(value.at)?value.at:undefined,
      previousState:states.has(value.previousState)?value.previousState:undefined,stage:/^(adapter|dns|routes|controller|overlay|probe|connections|complete)$/.test(value.stage||'')?value.stage:undefined,
      error:value.error?relayErrorCode(value.error):undefined,client:['verge','flclash','mihomo'].includes(value.client)?value.client:undefined,
      targets:Number.isSafeInteger(value.targets)?value.targets:undefined,verified:Number.isSafeInteger(value.verified)?value.verified:undefined,
      checkedAt:Number.isFinite(value.checkedAt)?value.checkedAt:undefined,lastVerifiedAt:Number.isFinite(value.lastVerifiedAt)?value.lastVerifiedAt:undefined,
      failures:(Array.isArray(value.failures)?value.failures:[]).filter(item=>codes.has(item.code)&&Number.isSafeInteger(item.count)).slice(0,15).map(({code,count})=>({code,count}))};
  }catch{return null;}
}
