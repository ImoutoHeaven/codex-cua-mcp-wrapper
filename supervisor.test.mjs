import test from 'node:test';
import assert from 'node:assert/strict';
import { codexHome, testEnv, connect, text } from './fixture-home.mjs';

// Each test gets its own fixture Codex home and in-process wrapper; the backend is fixture-backend.mjs.
async function session(t, options = {}, builds) {
  const { home, remove } = codexHome(builds);
  const c = connect({ env: testEnv(home), ...options });
  t.after(async () => { await c.close(); remove(); });
  return c;
}

test('serves its own initialize from the backend handshake and forwards unknown tools with their schemas', async t => {
  const c = await session(t, { capabilities: { roots: {} } });
  const init = (await c.initialize()).result;
  assert.equal(init.serverInfo.name, 'codex-desktop-cua');
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.deepEqual(init.capabilities, { tools: { listChanged: true }, logging: {} });
  // The backend may always ask for form confirmations, which this wrapper answers.
  assert.match(init.instructions, /^backend instructions; client elicitation \{"form":\{\}\}\n\n/);
  assert.match(init.instructions, /call turn_ended with no arguments, then js_reset/);

  const first = (await c.request('tools/list', {})).result;
  assert.equal(first.nextCursor, 'page-2');
  const second = (await c.request('tools/list', { cursor: 'page-2' })).result;
  assert.deepEqual(second.tools, [{ name: 'late_tool', inputSchema: { type: 'object' } }]);
  const tools = Object.fromEntries(first.tools.map(tool => [tool.name, tool]));
  assert.deepEqual(tools.mystery_tool, { name: 'mystery_tool', description: 'Unknown to the wrapper.',
    inputSchema: { type: 'object', properties: { depth: { type: 'integer', minimum: 1 } }, additionalProperties: false }, annotations: { readOnlyHint: true } });
  assert.deepEqual(tools.js_reset, { name: 'js_reset', description: 'Reset.', inputSchema: { type: 'object' } });
  assert.deepEqual(tools.js.inputSchema, { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] });
  assert.match(tools.js.description, /^Run JavaScript\.\n\n[\s\S]*An empty `agent\.browsers\.list\(\)` means this runtime found no connected browser\. If Chrome is not running, open it/);
  // Only the hook arguments the wrapper fills become optional.
  assert.deepEqual(tools.turn_ended.inputSchema.required, ['reason']);

  const mystery = JSON.parse(text((await c.call('mystery_tool', { depth: 2 })).result));
  assert.equal(mystery.name, 'mystery_tool');
  assert.deepEqual(mystery.args, { depth: 2 });
  assert.equal(typeof mystery.meta['x-codex-turn-metadata'].turn_id, 'string');
  assert.equal((await c.request('resources/list', {})).error.message, 'fixture: no method resources/list');
});

test('a backend that dies fails its in-flight calls once and the next call starts a new runtime without replay', async t => {
  const c = await session(t);
  await c.initialize();
  const first = await c.json('state');
  const hung = c.js('hang');
  const died = await c.js('die');
  for (const result of [died, await hung]) {
    assert.equal(result.isError, true);
    assert.match(text(result), /generation 1\) exited \(code 7\) while this request was running\. Its JavaScript state and any input in progress were lost; the request was not retried\. \[backend\/BACKEND_EXITED\]/);
  }
  assert.match(text(died), /fixture: crashing on request/);
  const second = await c.json('state');
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(second.seen, ['state']);
  assert.ok(c.notes.some(n => n.method === 'notifications/tools/list_changed'));

  // A runtime that exits between calls is reported by the next call, which does not run.
  await c.js('exit-soon');
  await new Promise(resolve => setTimeout(resolve, 1500));
  const notice = await c.js('state');
  assert.equal(notice.isError, true);
  assert.match(text(notice), /generation 2\) exited \(code 9\) while idle\. Its JavaScript state was lost, and this call was not run\. \[backend\/STATE_LOST\]/);
  assert.deepEqual((await c.json('state')).seen, ['state']);

  // A message that breaks the JSON-RPC envelope never reaches the client; it ends the runtime like an exit does.
  const broken = await c.js('bad-envelope');
  assert.equal(broken.isError, true);
  assert.match(text(broken), /generation 3\) sent an invalid JSON-RPC message \(jsonrpc is not "2\.0"\) while this request was running\. .*\[backend\/BACKEND_EXITED\]/);
  assert.doesNotMatch(text(broken), /leaked/);
  assert.deepEqual((await c.json('state')).seen, ['state']);
});

test('client ids, cancellation and backend requests keep their own ids in both directions', async t => {
  const c = await session(t, { capabilities: { roots: {} } });
  await c.initialize();
  c.request('tools/call', { name: 'js', arguments: { code: 'hang' } }, 'x');
  const duplicate = await c.request('tools/call', { name: 'js', arguments: { code: 'hang' } }, 'x');
  assert.match(duplicate.error.message, /already in flight/);
  c.send({ method: 'notifications/cancelled', params: { requestId: 'x', reason: 'test' } });
  c.send({ method: 'notifications/cancelled', params: { requestId: 404 } });

  const reverse = c.js('ask:' + JSON.stringify(['roots/list', {}]));
  const ask = await c.until(m => m.method === 'roots/list');
  assert.match(ask.id, /^cua-\d+$/);
  c.send({ id: ask.id, result: { roots: [{ uri: 'file:///work' }] } });
  assert.deepEqual(JSON.parse(text(await reverse)).answer, { roots: [{ uri: 'file:///work' }] });

  const state = await c.json('state');
  assert.equal(state.cancelled.length, 1);
  // The backend saw its own id for the cancelled call, not the client's.
  assert.equal(typeof state.cancelled[0], 'number');
});

test('turn_ended without arguments closes the latest turn, starts the next one, and stays retryable after a failure', async t => {
  const c = await session(t);
  await c.initialize();
  const meta = async (code, extra) => (await c.json(code, extra)).meta['x-codex-turn-metadata'];
  const ended = async (args = {}) => {
    const result = (await c.call('turn_ended', args)).result;
    return result.isError ? 'error' : JSON.parse(text(result)).args;
  };
  const t1 = await meta('one');
  assert.deepEqual(await ended({ hook_event_name: 'Stop', session_id: 's', turn_id: 't' }), { hook_event_name: 'Stop', session_id: 's', turn_id: 't' });
  assert.deepEqual(await meta('still one'), t1);
  assert.equal(await ended({ hook_event_name: 'fail' }), 'error');
  assert.deepEqual(await ended(), { hook_event_name: 'Stop', ...t1 });
  const t2 = await meta('two');
  assert.equal(t2.session_id, t1.session_id);
  assert.notEqual(t2.turn_id, t1.turn_id);
  // A call sent while cleanup is pending belongs to the next turn.
  const [closing, overlap] = await Promise.all([ended(), meta('three')]);
  assert.deepEqual(closing, { hook_event_name: 'Stop', ...t2 });
  assert.notEqual(overlap.turn_id, t2.turn_id);
  // Metadata the client sends is kept, and a bare turn_ended closes that turn.
  const own = { session_id: 'host', turn_id: 'h1' };
  assert.deepEqual(await meta('own', { _meta: { 'x-codex-turn-metadata': own } }), own);
  assert.deepEqual(await ended(), { hook_event_name: 'Stop', ...own });
});

test('an empty browser inventory gets guidance; an unrelated empty array does not', async t => {
  const c = await session(t);
  await c.initialize();
  const hint = /No connected browser was found\. If Chrome is not running, open it through the computer surface[\s\S]*ask the user to enable and connect the ChatGPT extension/;
  for (const code of ['console.log(JSON.stringify(await agent.browsers.list()))', 'await agent.browsers.list()']) {
    const result = await c.js(code);
    assert.equal(result.content.length, 3);
    assert.match(result.content[2].text, hint);
  }
  assert.equal((await c.js('[]')).content.length, 2);
  assert.equal((await c.js('const b = await agent.browsers.list(); console.log(JSON.stringify(b.filter(x => x.ok)))')).content.length, 2);
  assert.doesNotMatch(text(await c.js('pipe')), hint);
  assert.match(text(await c.js('pipe')), /Start ChatGPT or Codex Desktop with Computer Use enabled, reconnect this MCP server .*observe the current state before repeating any input/);
});

const confirmation = (meta, extra = {}) => ['elicitation/create', { message: 'Allow?', requestedSchema: { type: 'object', properties: {} }, _meta: meta, ...extra }];
const app = { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', riskLevel: 'low', tool_params: { app: 'calc.exe' } };

test('confirmations reach the local dialog, and cancelling the owning call cancels the dialog', async t => {
  const asked = [];
  const c = await session(t, { ask: (view, signal) => new Promise(resolve => {
    asked.push(view);
    if (view.message === 'Allow?') return resolve('accept');
    signal.addEventListener('abort', () => resolve('accept'));
  }) });
  await c.initialize();
  assert.deepEqual(JSON.parse(text(await c.js('ask:' + JSON.stringify(confirmation(app))))).answer, { action: 'accept', content: {} });
  assert.equal(asked[0].title, 'calc.exe');

  c.request('tools/call', { name: 'js', arguments: { code: 'ask:' + JSON.stringify(confirmation(app, { message: 'wait' })) } }, 'owner');
  while (asked.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  c.send({ method: 'notifications/cancelled', params: { requestId: 'owner' } });
  const answers = async count => {
    for (;;) {
      const { answers } = await c.json('state');
      if (answers.length >= count) return answers;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  // The dialog's later 'accept' is not delivered; the backend gets cancel.
  assert.deepEqual((await answers(2))[1], { action: 'cancel' });
  // The backend answered the cancelled call late; a request reusing its id gets only its own reply.
  const reused = await c.request('tools/call', { name: 'js', arguments: { code: 'state' } }, 'owner');
  assert.equal(JSON.parse(text(reused.result)).cancelled.length, 1);

  // A cancelled call that never answers does not keep owning later confirmations.
  c.request('tools/call', { name: 'js', arguments: { code: 'hang' } }, 'stuck');
  c.send({ method: 'notifications/cancelled', params: { requestId: 'stuck' } });
  await c.js('post:' + JSON.stringify(confirmation(app, { message: 'orphaned' })));
  assert.deepEqual((await answers(3))[2], { action: 'cancel' });

  // An approval that arrives after its call finished is cancelled without a dialog.
  await c.js('later:' + JSON.stringify(confirmation(app, { message: 'too late' })));
  assert.deepEqual((await answers(4))[3], { action: 'cancel' });
  assert.ok(!asked.some(view => view.message === 'too late'));
  // Any running client request can own an approval, including methods the wrapper does not know.
  const custom = await c.request('custom/ask', confirmation(app)[1]);
  assert.deepEqual(JSON.parse(text(custom.result)).answer, { action: 'accept', content: {} });
});

test('forms the wrapper cannot answer go to a client that accepts forms, and are refused otherwise', async t => {
  const fields = confirmation(app, { requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } });
  const asked = [];
  const ask = async view => { asked.push(view); return 'accept'; };

  const refusing = await session(t, { ask });
  await refusing.initialize();
  const refused = JSON.parse(text(await refusing.js('ask:' + JSON.stringify(fields))));
  assert.equal(refused.answer, null);
  assert.equal(refused.error.data.code, 'UNSUPPORTED_FORM');

  const capable = await session(t, { ask, capabilities: { elicitation: { form: {} } } });
  await capable.initialize();
  const reply = capable.js('ask:' + JSON.stringify(fields));
  const forwarded = await capable.until(m => m.method === 'elicitation/create');
  assert.deepEqual(forwarded.params.requestedSchema.properties, { token: { type: 'string' } });
  capable.send({ id: forwarded.id, result: { action: 'accept', content: { token: 'typed by the user' } } });
  assert.deepEqual(JSON.parse(text(await reply)).answer, { action: 'accept', content: { token: 'typed by the user' } });
  assert.equal(asked.length, 0);

  // Cancelling the call that asked withdraws the forwarded form, and a late answer approves nothing.
  capable.request('tools/call', { name: 'js', arguments: { code: 'ask:' + JSON.stringify(fields) } }, 'asker');
  const second = await capable.until(m => m.method === 'elicitation/create' && m.id !== forwarded.id);
  capable.send({ method: 'notifications/cancelled', params: { requestId: 'asker' } });
  await capable.until(m => m.method === 'notifications/cancelled' && m.params.requestId === second.id);
  capable.send({ id: second.id, result: { action: 'accept', content: { token: 'late' } } });
  const { answers } = await capable.json('state');
  assert.deepEqual(answers.at(-1), { action: 'cancel' });
  assert.equal(answers.length, 2);

  // js_reset withdraws a forwarded form the same way.
  capable.js('ask:' + JSON.stringify(fields));
  const third = await capable.until(m => m.method === 'elicitation/create' && ![forwarded.id, second.id].includes(m.id));
  await capable.call('js_reset', {});
  assert.ok(capable.notes.some(m => m.method === 'notifications/cancelled' && m.params.requestId === third.id));
  capable.send({ id: third.id, result: { action: 'accept', content: { token: 'late' } } });
  const after = (await capable.json('state')).answers;
  assert.deepEqual(after.slice(2), [{ action: 'cancel' }]);
});

test('startup failures name the stage and skip to an older build that completes the handshake', async t => {
  const fallback = await session(t, {}, {
    '26.2': () => ({ env: { FIXTURE_INIT: 'exit' } }),
    '26.10': () => ({ env: { FIXTURE_INIT: 'empty' } }),
    '26.9': () => ({ env: { FIXTURE_INIT: 'silent' }, startup_timeout_sec: 0.5 }),
    '26.1': () => ({ env: { FIXTURE_MARKER: 'older' } }),
    '26.11': () => ({ enabled: false }),
  });
  assert.ok((await fallback.initialize()).result);
  assert.equal((await fallback.json('env')).marker, 'older');

  const broken = await session(t, {}, { '26.3': () => ({ env: { FIXTURE_INIT: 'exit' } }), '26.2': () => ({ env: { FIXTURE_INIT: 'silent' }, startup_timeout_sec: 0.5 }),
    '26.1': () => ({ env: { FIXTURE_INIT: 'array-caps' } }) });
  const error = (await broken.initialize()).error;
  assert.equal(error.data.stage, 'launch');
  assert.equal(error.data.code, 'NO_RUNTIME_STARTED');
  assert.match(error.message, /26\.3: Runtime 26\.3 exited \(code 3\) before completing initialize\. \[handshake\/BACKEND_EXITED\]\nfixture: refusing to start/);
  assert.match(error.message, /26\.2: Runtime 26\.2 did not answer initialize within 0\.5 s\. \[handshake\/INIT_TIMEOUT\]/);
  assert.match(error.message, /26\.1: Runtime 26\.1 did not complete initialize: the result lacks protocolVersion or capabilities\. \[handshake\/INIT_REJECTED\]/);
  assert.doesNotMatch(error.message, /pipe/i);
  // A later call tries again and reports the same explicit failure.
  assert.equal((await broken.call('js', { code: 'x' })).error?.message, 'Send initialize first.');

  const missing = await session(t, {}, {});
  const absent = (await missing.initialize()).error;
  assert.equal(absent.data.stage, 'locate');
  assert.equal(absent.data.code, 'PLUGIN_NOT_FOUND');
  assert.match(absent.message, /No Computer Use plugin folder at .*unified-computer-use\. \[locate\/PLUGIN_NOT_FOUND\]/);
  assert.match(absent.data.recovery, /set CODEX_HOME/);
});
