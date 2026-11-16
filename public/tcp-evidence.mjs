export function tcpOperationCategory(operation,fallback='socket'){
  const value=String(operation||'');
  if(!value)return fallback||'socket';
  if(/^Reconnect(?:IPV[46])?$/i.test(value))return 'tcp_connect_retry';
  if(/Retransmit/i.test(value))return 'retransmit';
  if(/Fail/i.test(value))return 'tcp_fail';
  return 'socket';
}
export function summarizeTcpRetries(evidence=[]){
  const flows=new Map();let retries=0;
  for(const row of evidence){
    if(row.kind!=='tcp'||row.synthetic||tcpOperationCategory(row.operation,row.category)!=='tcp_connect_retry')continue;
    const count=Number.isSafeInteger(row.count)&&row.count>0?row.count:1;retries+=count;
    const key=JSON.stringify([row.pid,row.source,row.sourcePort,row.destination,row.destinationPort]);
    let flow=flows.get(key);
    if(!flow){flow={process:row.process||'未识别进程',host:row.host||'',source:row.source,sourcePort:row.sourcePort,destination:row.destination,destinationPort:row.destinationPort,firstAt:row.at,lastAt:row.at,count:0};flows.set(key,flow);}
    flow.count+=count;flow.firstAt=Math.min(flow.firstAt,row.at);flow.lastAt=Math.max(flow.lastAt,row.at);
  }
  return {retries,connections:flows.size,flows:[...flows.values()].sort((a,b)=>a.firstAt-b.firstAt)};
}
