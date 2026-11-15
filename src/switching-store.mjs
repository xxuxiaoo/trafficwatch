import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.mjs';
import { SealedStore } from './sealed-store.mjs';
import { DatabaseSync } from 'node:sqlite';

export function createCaptureStore(dir) {
  const metadataFile=path.join(path.dirname(dir),'vault','vault.json');
  let actual,checked=0;
  const check=()=>{
    if(actual?.sealed || actual && Date.now()-checked<500)return;
    checked=Date.now();
    if(fs.existsSync(metadataFile)){
      const metadata=JSON.parse(fs.readFileSync(metadataFile,'utf8'));
      const preferences={};
      if(!fs.existsSync(path.join(dir,'capture-preferences.json'))&&fs.existsSync(path.join(dir,'monitor.sqlite'))){
        const source=new DatabaseSync(path.join(dir,'monitor.sqlite'),{readOnly:true});
        try{for(const key of ['harnessApps','captureMode','retentionDays','alertMBPerMinute','budget']){
          const row=source.prepare('SELECT value FROM settings WHERE key=?').get(key);if(row)preferences[key]=JSON.parse(row.value);
        }}finally{source.close();}
      }
      // Close the old SQLite writer before reporting sealed mode in health.
      actual?.close();actual=new SealedStore(dir,metadata);
      for(const [key,value] of Object.entries(preferences))actual.set(key,value);
    }else actual??=new Store(dir);
  };
  check();
  return new Proxy({}, { get(_target,key){check();const value=actual[key];return typeof value==='function'?value.bind(actual):value;} });
}
