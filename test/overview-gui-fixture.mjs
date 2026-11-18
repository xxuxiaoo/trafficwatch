import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';

const dataRoot=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw new Error('fixture_data_root_required');
fs.mkdirSync(dataRoot,{recursive:true});
const at=Math.floor((Date.now()-90000)/60000)*60000;
const makeRow=(key,up,down,scope,rule)=>({key,host:`${key}.synthetic.test`,network:'tcp',process:'codex.exe',pid:12345,scope,evidence:'etw',family:'codex',familyRoot:'codex.exe',rule:JSON.stringify(rule),up,down});
const fixtures={
  windows:[makeRow('synthetic-machine',1200,3400,'codex',{source:'windows'})],
  clash:[
    makeRow('synthetic-verge-tag',5000,7000,'other',{source:'mihomo',type:'MATCH',chains:['TAG-HK-1'],client:'verge'}),
    makeRow('synthetic-flclash-same-node',9000,11000,'other',{source:'mihomo',type:'MATCH',chains:['TAG-HK-1'],client:'flclash'}),
  ],
};
for(const [lane,rows] of Object.entries(fixtures)){
  const store=new Store(path.join(dataRoot,lane));
  try{
    if(lane==='clash')store.set('airportGroups',[{id:'tag',name:'TAG',members:[{client:'verge',node:'TAG-HK-1'}]}]);
    const totals=rows.reduce((value,row)=>({up:value.up+row.up,down:value.down+row.down}),{up:0,down:0});
    store.record({at,duration:1000,allUp:totals.up,allDown:totals.down,codexUp:lane==='windows'?totals.up:0,codexDown:lane==='windows'?totals.down:0,unknownUp:0,unknownDown:0,activeSessions:[],rows});
  }finally{store.close();}
}
