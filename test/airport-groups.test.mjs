import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAirportGroups} from '../src/airport-groups.mjs';

test('airport groups preserve exact client and node membership',()=>{
  const groups=normalizeAirportGroups([{id:'tag-group',name:'TAG机场',members:[{client:'verge',node:'TAG-HK-1'},{client:'flclash',node:'TAG-HK-1'}]}]);
  assert.deepEqual(groups,[{id:'tag-group',name:'TAG机场',members:[{client:'verge',node:'TAG-HK-1'},{client:'flclash',node:'TAG-HK-1'}]}]);
});

test('airport group validation rejects ambiguous assignments and unsafe labels',()=>{
  assert.throws(()=>normalizeAirportGroups([{id:'one',name:'A',members:[{client:'verge',node:'n'}]},{id:'two',name:'B',members:[{client:'verge',node:'n'}]}]),/invalid_airport_member/);
  assert.throws(()=>normalizeAirportGroups([{id:'one',name:'A\nB',members:[]}]),/invalid_airport_group/);
  assert.throws(()=>normalizeAirportGroups([{id:'one',name:'A',members:[{client:'unknown',node:'n'}]}]),/invalid_airport_member/);
});
