import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const wrapper = fileURLToPath(new URL('./wrapper.mjs', import.meta.url));
const fake = `
process.stdin.setEncoding('utf8');
let buffer='';
for await (const chunk of process.stdin) {
 buffer+=chunk;let end;
 while((end=buffer.indexOf('\\n'))!==-1) {
 const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
 const q=JSON.parse(line); if(q.id===undefined)continue;
 let result;
 if(q.method==='initialize') {
  result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:process.env.FIXTURE_VERSION,version:'1',clientCapabilities:q.params?.capabilities}};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'host-approval',method:'elicitation/create',params:{message:process.env.FIXTURE_CONFIRM ? '自动测试：请勿点击。窗口显示后会自动取消，不会访问应用。' : 'Approve?',requestedSchema:process.env.FIXTURE_CONFIRM ? {type:'object',properties:{}} : {type:'object'}}})+'\\n');
 }
 else if(!q.method) result={received:q.result};
 else if(q.method==='tools/list') result={tools:['js','js_reset','turn_ended','js_add_node_module_dir'].map(name=>({name,inputSchema:{type:'object'}}))};
 else if(q.params?.arguments?.code==='pipe') result={isError:true,content:[{type:'text',text:'Computer Use native pipe is unavailable: os error 2'}]};
 else result={content:[{type:'text',text:JSON.stringify({surface:process.env.CUA_REPL_ENABLED_SURFACES,sky:JSON.parse(process.env.NODE_REPL_TRUSTED_SERVICES).sky,value:q.params?.arguments?.code})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
 }
}
`;

test('discovers newest usable version, relays MCP, filters tools and explains native-pipe failures', async () => {
 const home=mkdtempSync(join(tmpdir(),'desktop-cua-test-'));
 let child;
 try {
  const runtime=join(home,'fake runtime.mjs'); writeFileSync(runtime,fake);
  for(const version of ['26.9.1','26.10.1','26.11.1']) {
   const dir=join(home,'plugins/cache/openai-bundled/unified-computer-use',version);mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,'.mcp.json'),JSON.stringify({mcpServers:{cua_repl:{command:process.execPath,args:[version==='26.11.1'?join(home,'missing.mjs'):runtime],enabled_tools:['js','js_reset','turn_ended'],env:{CUA_REPL_NODE_REPL_PATH:process.execPath,CUA_REPL_ENABLED_SURFACES:'browser',NODE_REPL_TRUSTED_SERVICES:'{"browser":"original"}',FIXTURE_VERSION:version}}}}));
  }
  const requests=[
   {id:1,method:'initialize',params:{}},
   {id:2,method:'tools/list'},
   {id:3,method:'tools/call',params:{name:'js',arguments:{code:'中文\u2028ok'}}},
   {id:4,method:'tools/call',params:{name:'js',arguments:{code:'pipe'}}},
   {id:5,method:'tools/call',params:{name:'js_add_node_module_dir',arguments:{path:'no'}}},
   {id:6,method:'tools/call',params:{name:'turn_ended',arguments:{hook_event_name:'Stop',session_id:'s',turn_id:'t'}}},
  ];
  child=spawn(process.execPath,[wrapper],{env:{...process.env,CODEX_HOME:home},windowsHide:true});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>stdout+=chunk);
  child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>stderr+=chunk);
  const exited=new Promise(resolve=>child.on('close',resolve));
  child.stdin.write(requests.map(q=>JSON.stringify({jsonrpc:'2.0',...q})).join('\n')+'\n');
  const deadline=Date.now()+10000;
  while(!stdout.includes('"received":{"action":"cancel"}')) {
   assert.ok(Date.now()<deadline,stdout+stderr);
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  child.stdin.end();
  assert.equal(await exited,0,stderr);
  const run={stdout};
  const replies=new Map(stdout.trim().split('\n').map(s=>{const q=JSON.parse(s);return[q.id,q];}));
  assert.equal(replies.get(1).result.serverInfo.name,'26.10.1');
  assert.deepEqual(replies.get(2).result.tools.map(t=>t.name),['js','js_reset','turn_ended']);
  const value=JSON.parse(replies.get(3).result.content[0].text);
  assert.equal(value.surface,'computer');assert.equal(value.sky,'@oai/sky/service');assert.equal(value.value,'中文\u2028ok');
  assert.equal(replies.get(4).result.isError,true);
  assert.match(replies.get(4).result.content.map(c=>c.text).join('\n'),/请启动 ChatGPT Desktop/);
  assert.ok(replies.get(5).error);
  assert.ok(replies.get(6).result);
  assert.deepEqual(replies.get(1).result.serverInfo.clientCapabilities.elicitation,{form:{}});
  assert.ok(!run.stdout.split('\n').filter(Boolean).map(s=>JSON.parse(s)).some(q=>q.method==='elicitation/create'));
  assert.deepEqual(replies.get('host-approval').result,{received:{action:'cancel'}});
 } finally {if(child && child.exitCode===null)child.kill();rmSync(home,{recursive:true,force:true});}
});

test('native confirmation is visibly shown and cancellation reaches the server', {skip:process.platform!=='win32' || process.env.CUA_WRAPPER_GUI_TESTS!=='1',timeout:15000}, async () => {
 const home=mkdtempSync(join(tmpdir(),'desktop-cua-confirm-'));
 let child;
 try {
  const runtime=join(home,'fake runtime.mjs');writeFileSync(runtime,fake);
  const dir=join(home,'plugins/cache/openai-bundled/unified-computer-use/26.10.1');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'.mcp.json'),JSON.stringify({mcpServers:{cua_repl:{command:process.execPath,args:[runtime],env:{CUA_REPL_NODE_REPL_PATH:process.execPath,FIXTURE_VERSION:'test',FIXTURE_CONFIRM:'1'}}}}));
  child=spawn(process.execPath,[wrapper],{env:{...process.env,CODEX_HOME:home},windowsHide:true});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  const exited=new Promise(r=>child.once('close',r));
  const send=q=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...q})+'\n');
  send({id:1,method:'initialize',params:{}});
  const deadline=Date.now()+9000;
  while(!stderr.includes('Confirmation window is visible')) {
   assert.ok(Date.now()<deadline,stderr);
   await new Promise(r=>setTimeout(r,30));
  }
  send({method:'notifications/cancelled',params:{requestId:1}});
  while(!stdout.includes('"received":{"action":"cancel"}')) {
   assert.ok(Date.now()<deadline,stdout+stderr);
   await new Promise(r=>setTimeout(r,30));
  }
  child.stdin.end();assert.equal(await exited,0,stderr);
 } finally {
  if(child && child.exitCode===null){child.stdin.end();await new Promise(r=>child.once('close',r));}
  rmSync(home,{recursive:true,force:true});
 }
});

test('missing desktop installation fails explicitly without stdout pollution', () => {
 const home=mkdtempSync(join(tmpdir(),'desktop-cua-missing-'));
 try {
  const run=spawnSync(process.execPath,[wrapper],{env:{...process.env,CODEX_HOME:home},input:'',encoding:'utf8',timeout:10000});
  assert.equal(run.status,1);
  assert.equal(run.stdout,'');
  assert.match(run.stderr,/请启动 ChatGPT Desktop/);
 } finally {rmSync(home,{recursive:true,force:true});}
});
