import test from 'node:test';
import assert from 'node:assert/strict';
import {BackgroundHistoryRefreshes} from '../src/history-background-refresh.mjs';

test('foreground work cancels and releases obsolete background history refreshes',async()=>{
  const refreshes=new BackgroundHistoryRefreshes(),reader={};let started,currentStarted,aborted;
  const waiting=new Promise(resolve=>started=resolve);
  const currentWaiting=new Promise(resolve=>currentStarted=resolve);
  assert.equal(refreshes.start(reader,'old-range',signal=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});started();
  })),true);
  assert.equal(refreshes.start(reader,'old-range',()=>assert.fail('duplicate refresh must coalesce')),false);
  assert.equal(refreshes.start(reader,'current-range',signal=>new Promise(resolve=>{currentStarted();signal.addEventListener('abort',resolve,{once:true});})),true);
  await waiting;await currentWaiting;assert.equal(refreshes.has(reader,'old-range'),true);
  refreshes.cancel(reader,'current-range');assert.equal(aborted,true);assert.equal(refreshes.has(reader,'old-range'),false);assert.equal(refreshes.has(reader,'current-range'),true);
  refreshes.cancel(reader);assert.equal(refreshes.has(reader,'current-range'),false);
  await new Promise(resolve=>setImmediate(resolve));
});

test('cache reset cancels background refreshes for every reader',async()=>{
  const refreshes=new BackgroundHistoryRefreshes(),readers=[{},{}],signals=[];
  for(const [index,reader] of readers.entries())refreshes.start(reader,String(index),signal=>new Promise(resolve=>{
    signals.push(signal);signal.addEventListener('abort',resolve,{once:true});
  }));
  await new Promise(resolve=>setImmediate(resolve));refreshes.cancelAll();
  assert(signals.every(signal=>signal.aborted));
  assert(readers.every(reader=>!refreshes.has(reader,'0')&&!refreshes.has(reader,'1')));
});
