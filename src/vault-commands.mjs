import crypto from 'node:crypto';
export function signCommand(path,body,secrets,now=Date.now()) {
  const command={path,body,at:now,nonce:crypto.randomUUID()};
  return Buffer.from(JSON.stringify({...command,signature:crypto.sign(null,Buffer.from(JSON.stringify(command)),secrets.commandKey).toString('base64')})).toString('base64url');
}
export function commandVerifier(publicKey) {
  const used=new Map();
  return (header,path,body,now=Date.now())=>{
    if(typeof header!=='string'||header.length>16384) return false;
    try {
      const {signature,...command}=JSON.parse(Buffer.from(header,'base64url').toString());
      if(command.path!==path||JSON.stringify(command.body)!==JSON.stringify(body)||!Number.isSafeInteger(command.at)||Math.abs(now-command.at)>15000||typeof command.nonce!=='string'||used.has(command.nonce))return false;
      if(!crypto.verify(null,Buffer.from(JSON.stringify(command)),publicKey,Buffer.from(signature,'base64')))return false;
      for(const [nonce,at] of used)if(now-at>15000)used.delete(nonce);
      if(used.size>=1024)return false;
      used.set(command.nonce,now);return true;
    }catch{return false;}
  };
}
