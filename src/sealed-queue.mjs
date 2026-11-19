import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

// Keep the encrypted history commit durable before acknowledging any source
// packet. A crash in between replays the committed import ids without adding
// bytes again. Grouping commits avoids two filesystem flushes for every packet.
export function drainSealedQueue(file,history,importRow,{limit=120,maxMs=Infinity,includeRemaining=false,connection,beforeCommit}={}){
  if(!fs.existsSync(file))return {count:0,pending:false,...(includeRemaining?{remaining:0}:{})};
  const spool=connection||new DatabaseSync(file),accepted=[];const started=performance.now();let failure;
  try{
    spool.exec('PRAGMA busy_timeout=1000');
    if(spool.prepare('SELECT 1 FROM envelopes LIMIT 1').get()){
      history.exec('BEGIN IMMEDIATE');
      try{
        for(const row of spool.prepare('SELECT id,payload FROM envelopes ORDER BY sequence LIMIT ?').iterate(limit)){
          if(accepted.length&&performance.now()-started>=maxMs)break;
          try{importRow(row);accepted.push(row.id);}catch(error){failure=error;break;}
        }
        beforeCommit?.();
        history.exec('COMMIT');
      }catch(error){try{history.exec('ROLLBACK');}catch{}throw error;}
      if(accepted.length){
        spool.exec('BEGIN IMMEDIATE');
        try{const remove=spool.prepare('DELETE FROM envelopes WHERE id=?');for(const id of accepted)remove.run(id);spool.exec('COMMIT');}
        catch(error){try{spool.exec('ROLLBACK');}catch{}throw error;}
      }
    }
    const remaining=includeRemaining?spool.prepare('SELECT COUNT(*) count FROM envelopes').get().count:undefined;
    if(failure){failure.importedCount=accepted.length;if(includeRemaining)failure.remaining=remaining;throw failure;}
    return {count:accepted.length,pending:includeRemaining?remaining>0:Boolean(spool.prepare('SELECT 1 FROM envelopes LIMIT 1').get()),...(includeRemaining?{remaining}:{})};
  }finally{if(!connection)spool.close();}
}
