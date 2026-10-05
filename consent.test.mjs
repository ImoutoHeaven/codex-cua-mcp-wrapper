import test from 'node:test';
import assert from 'node:assert/strict';
import { isAccessConfirmation, isApplicationAccessConfirmation, canReuseApproval, parseChoice, requestConsent } from './consent.mjs';

const form = { mode: 'form', message: 'Allow Codex to use calc?', requestedSchema: { type: 'object', properties: {} }, _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', riskLevel:'low', tool_params: { app: 'calc.exe' } } };

test('only empty object confirmation schemas can be accepted', () => {
 assert.equal(isAccessConfirmation(form), true);
 for (const params of [null, {}, {...form,mode:'url'}, {...form,requestedSchema:{type:'object',properties:{password:{type:'string'}}}}, {...form,requestedSchema:{type:'object',required:['approved']}}, {...form,requestedSchema:{type:'object',properties:{},allOf:[]}}]) {
  assert.equal(isAccessConfirmation(params), false);
 }
});

test('only explicit local button choices produce accept; closing, failure and malformed output cancel', () => {
 assert.deepEqual(parseChoice('accept\r\n',0),{action:'accept',content:{}});
 assert.deepEqual(parseChoice('decline\n',0),{action:'decline'});
 for(const [output,exit] of [['',0],['accept',1],['true',0],['accept\ndecline',0],['cancel',0]]) {
  assert.deepEqual(parseChoice(output,exit),{action:'cancel'});
 }
});

test('allow-all requires an explicit choice and applies only to identified low-risk app access', () => {
 assert.equal(isApplicationAccessConfirmation(form),true);
 assert.deepEqual(parseChoice('accept_all',0,{apps:true}),{action:'accept',content:{},scope:'apps'});
 assert.deepEqual(parseChoice('accept_all',0),{action:'cancel'});
 assert.deepEqual(parseChoice('accept_all',1,{apps:true}),{action:'cancel'});
 for(const meta of [undefined,{...form._meta,connector_id:'other'},{...form._meta,riskLevel:'high'}, {...form._meta,tool_params:{app:'calc.exe',permission:'other'}}, {...form._meta,tool_params:{app:''}}]) {
  assert.equal(isApplicationAccessConfirmation({...form,_meta:meta}),false);
 }
});

test('YOLO is explicitly selected and reused only within supported computer-use confirmations', () => {
 assert.deepEqual(parseChoice('yolo',0,{yolo:true}),{action:'accept',content:{},scope:'yolo'});
 assert.deepEqual(parseChoice('yolo',0),{action:'cancel'});
 assert.deepEqual(parseChoice('yolo',1,{yolo:true}),{action:'cancel'});
 assert.equal(canReuseApproval(null,form),false);
 assert.equal(canReuseApproval('apps',form),true);
 const higherRisk={...form,_meta:{...form._meta,riskLevel:'high',tool_params:{app:'calc.exe',operation:'other'}}};
 assert.equal(canReuseApproval('apps',higherRisk),false);
 assert.equal(canReuseApproval('yolo',higherRisk),true);
 assert.equal(canReuseApproval('yolo',{...form,_meta:{connector_id:'other'}}),false);
 assert.equal(canReuseApproval('yolo',{...form,requestedSchema:{type:'object',properties:{secret:{type:'string'}}}}),false);
});

test('unsupported forms and pre-cancelled calls never open a dialog', async () => {
 assert.deepEqual(await requestConsent({...form,requestedSchema:{type:'array'}},new AbortController().signal),{action:'cancel'});
 const abort = new AbortController(); abort.abort();
 assert.deepEqual(await requestConsent(form,abort.signal),{action:'cancel'});
});

test('cancelling a live native confirmation closes it without authorizing', {skip:process.platform!=='win32' || process.env.CUA_WRAPPER_GUI_TESTS!=='1'}, async () => {
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),1500);
 try {assert.deepEqual(await requestConsent({...form,message:'测试：自动取消验证。无需点击，不会访问应用。'},controller.signal),{action:'cancel'});}
 finally {clearTimeout(timer);}
});
