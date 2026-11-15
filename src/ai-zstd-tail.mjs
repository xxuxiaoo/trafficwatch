import fs from 'node:fs';
import {createZstdDecompress} from 'node:zlib';

// DSH v4 appends independent Zstd frames. Keep one streaming decoder alive;
// replay from the start after a restart, skipping only committed line numbers.
// This avoids decoding a growing session repeatedly or storing transcript text.
export class IncrementalZstdTail {
  constructor(file,{identity=null,lines=0,maxRead=256*1024,maxLine=1024*1024,maxDecodedPerPoll=16*1024*1024,onLine,onGap=()=>{}}={}){
    Object.assign(this,{file,identity,committedLines:lines,maxRead,maxLine,maxDecodedPerPoll,onLine,onGap});
    this.offset=0;this.lines=0;this.partial=Buffer.alloc(0);this.decoder=null;this.status={state:'starting',bytesBehind:0,lines:0};this.catchUpTo=null;this.chain=Promise.resolve();this.error=null;
  }
  reset(){this.decoder?.destroy();this.decoder=null;this.offset=0;this.lines=0;this.committedLines=0;this.partial=Buffer.alloc(0);this.catchUpTo=null;this.error=null;this.discarding=false;}
  async poll(){
    let stat;try{stat=await fs.promises.stat(this.file);}catch(error){this.status.state=['ENOENT','ENOTDIR'].includes(error.code)?'missing':'read_error';if(this.status.state==='read_error')throw error;return false;}
    const identity=String(stat.ino)+':'+String(stat.birthtimeMs);
    if(this.identity&&this.identity!==identity||stat.size<this.offset){this.reset();this.onGap('log_rotation');}
    this.identity=identity;this.catchUpTo??=stat.size;
    this.status={...this.status,state:'caught_up',lastPollAt:Date.now(),modifiedAt:stat.mtimeMs,bytesBehind:stat.size-this.offset};
    if(this.error)throw this.error;if(stat.size===this.offset)return false;
    if(!this.decoder){
      this.decoder=createZstdDecompress();this.decoder.on('error',error=>{this.error=error;});
      this.decoder.on('data',chunk=>{
        this.decodedThisPoll+=chunk.length;
        if(this.decodedThisPoll>this.maxDecodedPerPoll){this.error=new Error('compressed_log_expansion_limit');this.decoder.destroy(this.error);return;}
        const combined=Buffer.concat([this.partial,chunk]);let start=0;
        for(let i=0;i<combined.length;i++)if(combined[i]===10){
          this.lines++;const lineNumber=this.lines,historicalImport=this.offset<=this.catchUpTo;
          if(this.discarding)this.discarding=false;
          else if(i-start>this.maxLine)this.onGap('oversize_log_line');
          else if(lineNumber>this.committedLines){const line=combined.subarray(start,i).toString('utf8');this.chain=this.chain.then(()=>this.onLine(line,{historicalImport}));}
          start=i+1;
        }
        this.partial=combined.subarray(start);
        if(this.discarding)this.partial=Buffer.alloc(0);else if(this.partial.length>this.maxLine){this.partial=Buffer.alloc(0);this.discarding=true;this.onGap('oversize_log_line');}
      });
    }
    this.decodedThisPoll=0;const handle=await fs.promises.open(this.file,'r');
    try{
      const buffer=Buffer.alloc(Math.min(this.maxRead,stat.size-this.offset));const {bytesRead}=await handle.read(buffer,0,buffer.length,this.offset);
      this.offset+=bytesRead;
      await new Promise((resolve,reject)=>this.decoder.write(buffer.subarray(0,bytesRead),error=>error?reject(error):resolve()));
      await this.chain;if(this.error)throw this.error;
      this.status.lines=this.lines;this.status.bytesBehind=stat.size-this.offset;this.status.state=this.status.bytesBehind?'backlog':'caught_up';return true;
    }finally{await handle.close();}
  }
  checkpoint(){return {identity:this.identity,lines:this.lines};}
  close(){this.decoder?.destroy();this.decoder=null;}
}
