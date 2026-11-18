export class BackgroundHistoryRefreshes {
  constructor(){this.readers=new Map();}
  has(reader,key){return this.readers.get(reader)?.has(key)||false;}
  start(reader,key,work){
    let jobs=this.readers.get(reader);if(!jobs)this.readers.set(reader,jobs=new Map());
    if(jobs.has(key))return false;
    const controller=new AbortController(),job={controller};jobs.set(key,job);
    Promise.resolve().then(()=>work(controller.signal)).catch(()=>{}).finally(()=>{
      if(jobs.get(key)===job)jobs.delete(key);
      if(!jobs.size)this.readers.delete(reader);
    });
    return true;
  }
  cancel(reader,keepKey=null){
    const jobs=this.readers.get(reader);if(!jobs)return;
    for(const [key,job]of jobs)if(key!==keepKey){jobs.delete(key);job.controller.abort();}
    if(!jobs.size)this.readers.delete(reader);
  }
  cancelAll(){for(const reader of this.readers.keys())this.cancel(reader);}
}
