import fs from 'node:fs';
import path from 'node:path';

export const CACHE_BUDGET = 256 * 1024 * 1024;
// Leave room for a full WAL transaction and its shared-memory index.
const CACHE_DATABASE_LIMIT = 96 * 1024 * 1024, cooldowns=new Map();
export const fileBytes = file => { try { return fs.statSync(file).size; } catch { return 0; } };
export const sqliteBytes = file => ['', '-wal','-shm'].reduce((n,suffix)=>n+fileBytes(file+suffix),0);

// Only this one regenerable cache is ever removed. Call with ALL cache readers
// closed (the history worker is serial; explicit purge closes both workers).
export function removeSummaryCache(file) {
  if(path.basename(file)!=='windows-programs-v2.sqlite')throw new Error('invalid_cache_path');
  for(const suffix of ['','-wal','-shm']) { const target=file+suffix;if(fs.existsSync(target))fs.unlinkSync(target); }
}
export function prepareCacheFile(file) {
  if((cooldowns.get(file)||0)>Date.now())return false;
  if(fileBytes(file)>CACHE_DATABASE_LIMIT||sqliteBytes(file)>CACHE_BUDGET)removeSummaryCache(file);
  return true;
}
export function limitCacheConnection(db) {
  const size=db.prepare('PRAGMA page_size').get().page_size;
  db.exec(`PRAGMA max_page_count=${Math.floor(CACHE_DATABASE_LIMIT/size)};PRAGMA wal_autocheckpoint=128;PRAGMA journal_size_limit=4194304`);
}
export function cacheFailed(file,error) {
  if(/full|disk|space/i.test(error.message)) { cooldowns.set(file,Date.now()+3600000);try{removeSummaryCache(file);}catch(error){console.error('TrafficWatch summary cache:',error.code||error.message);} }
}
export function directoryUsage(root,{maxFiles=20000}={}) {
  let bytes=0,files=0,incomplete=false;
  const visit=(dir,depth)=>{
    if(depth>12){incomplete=true;return;}
    let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const entry of entries){
      if(++files>maxFiles){incomplete=true;return;}
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink()){incomplete=true;continue;}
      if(entry.isDirectory())visit(file,depth+1);else if(entry.isFile())bytes+=fileBytes(file);
    }
  };
  visit(root,0);return {bytes,files,incomplete};
}
export function availableDisk(root) {
  try{const stat=fs.statfsSync(root);return {availableBytes:Number(stat.bavail)*Number(stat.bsize),capacityBytes:Number(stat.blocks)*Number(stat.bsize)};}catch{return {availableBytes:null,capacityBytes:null};}
}
