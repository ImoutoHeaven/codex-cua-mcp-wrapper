import test from 'node:test';
import assert from 'node:assert/strict';
import { isAccessConfirmation, isApplicationAccessConfirmation, isSiteAccessConfirmation, canReuseApproval, rememberApproval, parseChoice, requestConsent } from './consent.mjs';

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

const fresh = () => ({yolo:false,grants:new Set()});
const forApp = app => ({...form,_meta:{...form._meta,tool_params:{app}}});

test('allow-same-app is reused only for the approved app\'s low-risk access', () => {
 assert.equal(isApplicationAccessConfirmation(form),true);
 assert.deepEqual(parseChoice('accept_app',0,{app:true}),{action:'accept',content:{},scope:'app'});
 assert.deepEqual(parseChoice('accept_app',0),{action:'cancel'});
 assert.deepEqual(parseChoice('accept_app',1,{app:true}),{action:'cancel'});
 const approvals = fresh();
 assert.equal(canReuseApproval(approvals,form),false);
 rememberApproval(approvals,'app',form);
 assert.equal(canReuseApproval(approvals,forApp('CALC.EXE')),true);
 assert.equal(canReuseApproval(approvals,forApp('notepad.exe')),false);
 assert.equal(canReuseApproval(approvals,{...form,_meta:{...form._meta,riskLevel:'high'}}),false);
 for(const meta of [undefined,{...form._meta,connector_id:'other'},{...form._meta,riskLevel:'high'}, {...form._meta,tool_params:{app:'calc.exe',permission:'other'}}, {...form._meta,tool_params:{app:''}}]) {
  assert.equal(isApplicationAccessConfirmation({...form,_meta:meta}),false);
 }
});

test('YOLO is explicitly selected and reused only within supported computer-use confirmations', () => {
 assert.deepEqual(parseChoice('yolo',0,{yolo:true}),{action:'accept',content:{},scope:'yolo'});
 assert.deepEqual(parseChoice('yolo',0),{action:'cancel'});
 assert.deepEqual(parseChoice('yolo',1,{yolo:true}),{action:'cancel'});
 const approvals = fresh();
 rememberApproval(approvals,'yolo',form);
 const higherRisk={...form,_meta:{...form._meta,riskLevel:'high',tool_params:{app:'calc.exe',operation:'other'}}};
 assert.equal(canReuseApproval(approvals,higherRisk),true);
 assert.equal(canReuseApproval(approvals,{...form,_meta:{connector_id:'other'}}),false);
 assert.equal(canReuseApproval(approvals,{...form,requestedSchema:{type:'object',properties:{secret:{type:'string'}}}}),false);
});

const site = origin => ({ mode: 'form', message: `Allow Browser use to access ${origin}?`, requestedSchema: { type: 'object', properties: {} },
 _meta: { connector_id: 'browser-use', codex_approval_kind: 'mcp_tool_call', tool_name: 'access_browser_origin', origin, persist: 'always', tool_params: { origin } } });

test('allow-this-site is reused only for the same exact origin; YOLO covers site confirmations', () => {
 const example = site('https://example.com');
 assert.equal(isSiteAccessConfirmation(example),true);
 for(const params of [site('https://example.com/'),site('file://x'),site('not a url'),{...example,_meta:{...example._meta,origin:'https://other.com'}},
  {...example,_meta:{...example._meta,tool_name:'other'}},{...example,_meta:{...example._meta,tool_params:{origin:'https://example.com',x:1}}}]) {
  assert.equal(isSiteAccessConfirmation(params),false);
 }
 const approvals = fresh();
 rememberApproval(approvals,'app',example);
 assert.equal(canReuseApproval(approvals,site('https://example.com')),true);
 assert.equal(canReuseApproval(approvals,site('http://example.com')),false);
 assert.equal(canReuseApproval(approvals,forApp('https://example.com')),false);
 const yolo = fresh();
 rememberApproval(yolo,'yolo',example);
 assert.equal(canReuseApproval(yolo,site('https://other.com')),true);
 assert.equal(canReuseApproval(yolo,form),true);
});

test('unsupported forms and pre-cancelled calls never open a dialog', async () => {
 assert.deepEqual(await requestConsent({...form,requestedSchema:{type:'array'}},new AbortController().signal),{action:'cancel'});
 const abort = new AbortController(); abort.abort();
 assert.deepEqual(await requestConsent(form,abort.signal),{action:'cancel'});
});

test('cancelling a live native confirmation closes it without authorizing', {skip:process.platform!=='win32' || process.env.CUA_WRAPPER_GUI_TESTS!=='1'}, async () => {
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),1500);
 try {assert.deepEqual(await requestConsent({...form,message:'Test: automatic cancellation. No click needed; no app is accessed.'},controller.signal),{action:'cancel'});}
 finally {clearTimeout(timer);}
});
