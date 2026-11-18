import test from 'node:test';
import assert from 'node:assert/strict';
import {queryProgressView,createImportRefreshTracker} from '../public/history-progress.mjs';

test('query progress labels measured phase counts and keeps unknown SQL work indeterminate',()=>{
  const phase=queryProgressView({ready:true,query:{state:'running',stage:'programs',lane:'windows',done:2500,total:10000}},12000);
  assert.equal(phase.determinate,true);assert.match(phase.text,/2,500 \/ 10,000/);assert.match(phase.text,/25%，当前阶段/);assert.match(phase.text,/12 秒/);
  const scanning=queryProgressView({ready:true,query:{state:'running',stage:'program_buckets',lane:'windows'}},7000);
  assert.equal(scanning.determinate,false);assert.doesNotMatch(scanning.text,/%/);assert.match(scanning.text,/7 秒/);
  assert.match(queryProgressView({ready:false,initialization:{phase:'index',lane:'windows'}},1000).text,/首次创建应用查询索引/);
  const queued=queryProgressView({ready:true,query:{state:'queued',position:1,ahead:0,blocker:{stage:'programs',lane:'windows',elapsedMs:11000}}},11000);
  assert.match(queued.text,/等待本机 · 汇总应用与 Harness 归因完成/);assert.match(queued.text,/已运行 11 秒/);assert.match(queued.text,/当前排第 1 项/);assert.doesNotMatch(queued.text,/前面还有 0 项/);
  assert.equal(queryProgressView({ready:true,query:{state:'running',stage:'programs',done:20,total:10}}).determinate,false);
});

test('ordinary ingest completion never restarts attribution; real catch-up and readiness refresh once',()=>{
  const observe=createImportRefreshTracker(),status=(state,remaining)=>({ready:true,backgroundImport:{state,remaining}});
  assert.equal(observe(status('complete',0)),false);
  for(let i=0;i<4;i++){assert.equal(observe(status('running',2)),false);assert.equal(observe(status('complete',0)),false);}
  assert.equal(observe(status('running',1000)),false);assert.equal(observe(status('running',4)),false);
  assert.equal(observe(status('complete',0)),true);assert.equal(observe(status('complete',0)),false);
  assert.equal(observe({ready:false}),false);assert.equal(observe(status('complete',0)),true);assert.equal(observe(status('complete',0)),false);
});
