import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [packageRootValue,dataRootValue,portValue,machinePortValue,clashPortValue]=process.argv.slice(2);
if(![packageRootValue,dataRootValue,portValue,machinePortValue,clashPortValue].every(Boolean))throw new Error('overview_smoke_server_args_required');
const packageRoot=path.resolve(packageRootValue),dataRoot=path.resolve(dataRootValue);
const {startOverviewServer}=await import(pathToFileURL(path.join(packageRoot,'src','overview-server.mjs')));
startOverviewServer({
  historyRoot:dataRoot,
  listenPort:Number(portValue),
  sourcePorts:[Number(machinePortValue),Number(clashPortValue)],
  suiteSettings:process.env.TRAFFICWATCH_SINGLE_COLLECTOR === '1' ? {} : {DataRoot:dataRoot},
  guardFactory:callback=>({start(){callback({state:'unlocked'});},close(){}}),
});
