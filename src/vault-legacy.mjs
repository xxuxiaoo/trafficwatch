import { Store } from './store.mjs';
import { createBudgetCalendar } from './budgets.mjs';
import { parseRange } from './server.mjs';
import { setArchiveWindows } from './history-archive.mjs';
import { reportPeriod } from './reports.mjs';

// The archived interface runs on the authorized viewer origin. The collector
// never receives a history decryption key just to serve an old dashboard.
export function readLegacy(db,route,params,live,now=Date.now()){
  const store=Object.create(Store.prototype);store.db=db;store.excludedSessions=new Set();store.calendar=createBudgetCalendar(store.get('budgetTimeZone'));
  const url=new URL('http://127.0.0.1'+route+'?'+params),scope=url.searchParams.get('scope')||'codex';
  if(!['codex','all','other','unknown'].includes(scope))throw new RangeError('Invalid scope');
  if(route==='/api/calendar'){
    const month=url.searchParams.get('month'),from=Date.parse(month+'-01T00:00:00+08:00');
    if(Number.isFinite(from))setArchiveWindows(db,[{from,to:from+32*86400000},{from:Math.max(0,now-15*86400000),to:now+1}]);
    return store.calendarSummary(month,scope,now);
  }
  if(route==='/api/report'){
    const options={kind:url.searchParams.get('kind'),date:url.searchParams.get('date'),scope},period=reportPeriod(options,store.calendar.timeZone,now);
    setArchiveWindows(db,[{from:period.from,to:period.to+1}]);return store.reportSummary(options,now);
  }
  const range=parseRange(url,now,store.firstAt());
  setArchiveWindows(db,[{from:range.from,to:range.to+1},{from:Math.max(0,now-86400000),to:now+1}]);
  if(route==='/api/dashboard')return {status:{state:'disconnected',capture:{mode:'auto',active:'none'},intervalMs:1000,retentionDays:store.get('retentionDays',0),alertMBPerMinute:store.get('alertMBPerMinute',100),...live},budget:store.budgetSummary(now),range,totals:store.totals(range.from,range.to),trend:store.trend(range.from,range.to),connections:store.connections(range.from,range.to,scope),domains:store.domains(range.from,range.to,scope),sessions:store.sessions(),alerts:store.alerts(),insights:store.insights(range.from,range.to)};
  if(route==='/api/correlation')return {...store.correlation((url.searchParams.get('id')||'').slice(0,128),range.from,range.to),attribution:'activity_only'};
  if(route==='/api/export')return {rows:store.connections(range.from,range.to,scope,10000)};
  throw new RangeError('Invalid legacy route');
}
