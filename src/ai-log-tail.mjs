import fs from 'node:fs';

// The committed cursor always precedes (never skips) bytes successfully stored by the caller.
export class IncrementalTail {
  constructor(file,{offset=0,identity=null,maxRead=2*1024*1024,maxLine=1024*1024,onLine,onGap=()=>{}}={}){Object.assign(this,{file,offset,identity,maxRead,maxLine,onLine,onGap});this.partial=Buffer.alloc(0);this.catchUpTo=null;this.status={state:'starting',bytesBehind:0,lines:0};this.discarding=false;}
  async poll(){
    let stat;try{stat=await fs.promises.stat(this.file);}catch(error){this.status.state=['ENOENT','ENOTDIR'].includes(error.code)?'missing':'read_error';if(this.status.state==='read_error')throw error;return false;}
    this.status={...this.status,state:'reading',lastPollAt:Date.now(),modifiedAt:stat.mtimeMs,bytesBehind:Math.max(0,stat.size-this.offset)};
    const identity=String(stat.ino)+':'+String(stat.birthtimeMs);
    if(this.identity&&this.identity!==identity||stat.size<this.offset){this.offset=0;this.partial=Buffer.alloc(0);this.catchUpTo=null;this.onGap('log_rotation');}
    if(this.catchUpTo===null)this.catchUpTo=stat.size;
    this.identity=identity;if(stat.size===this.offset){this.status.state='caught_up';return false;}
    const handle=await fs.promises.open(this.file,'r');
    try{
      const buffer=Buffer.alloc(Math.min(this.maxRead,stat.size-this.offset)),{bytesRead}=await handle.read(buffer,0,buffer.length,this.offset);
      const combined=Buffer.concat([this.partial,buffer.subarray(0,bytesRead)]);let start=0;
      for(let i=0;i<combined.length;i++)if(combined[i]===10){if(this.discarding)this.discarding=false;else if(i-start<=this.maxLine){await this.onLine(combined.subarray(start,i).toString('utf8'),{historicalImport:this.offset-this.partial.length+i+1<=this.catchUpTo});this.status.lines++;}else this.onGap('oversize_log_line');start=i+1;}
      this.partial=combined.subarray(start);if(this.discarding)this.partial=Buffer.alloc(0);else if(this.partial.length>this.maxLine){this.onGap('oversize_log_line');this.partial=Buffer.alloc(0);this.discarding=true;}
      this.offset+=bytesRead;this.status.bytesBehind=stat.size-this.offset;this.status.state=this.status.bytesBehind?'backlog':'caught_up';return true;
    }finally{await handle.close();}
  }
  checkpoint(){return {identity:this.identity,offset:this.offset-this.partial.length};}
}
