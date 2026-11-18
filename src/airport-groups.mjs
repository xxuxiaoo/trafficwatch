const clients=new Set(['verge','flclash','mihomo']);
const text=value=>typeof value==='string'?value.trim():'';

export function normalizeAirportGroups(value){
  if(!Array.isArray(value)||value.length>50)throw new Error('invalid_airport_groups');
  const ids=new Set(),names=new Set(),assigned=new Set(),groups=[];
  for(const item of value){
    const id=text(item?.id),name=text(item?.name);
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||!name||name.length>64||/[\u0000-\u001f\u007f]/.test(name)||ids.has(id)||names.has(name.toLocaleLowerCase()))throw new Error('invalid_airport_group');
    if(!Array.isArray(item.members)||item.members.length>1000)throw new Error('invalid_airport_members');
    ids.add(id);names.add(name.toLocaleLowerCase());
    const members=[],within=new Set();
    for(const member of item.members){
      const client=text(member?.client),node=text(member?.node),key=client+'\0'+node;
      if(!clients.has(client)||!node||node.length>255||/[\u0000-\u001f\u007f]/.test(node)||within.has(key)||assigned.has(key))throw new Error('invalid_airport_member');
      within.add(key);assigned.add(key);members.push({client,node});
    }
    groups.push({id,name,members});
  }
  return groups;
}
