import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, Consent, parseChoice, showDialog } from './consent.mjs';

const schema = { type: 'object', properties: {} };
const cu = { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call' };
const app = (name = 'calc.exe', meta = {}) => ({ message: 'Allow Codex to use Calculator?', requestedSchema: schema, _meta: { ...cu, riskLevel: 'low', tool_params: { app: name }, ...meta } });
const site = (origin, meta = {}) => ({ message: `Allow access to ${origin}?`, requestedSchema: schema,
  _meta: { connector_id: 'browser-use', codex_approval_kind: 'mcp_tool_call', tool_name: 'access_browser_origin', origin, persist: 'always', tool_params: { origin }, ...meta } });

test('only form requests with an empty schema can be answered locally', () => {
  assert.ok(classify(app()));
  assert.ok(classify({ ...app(), requestedSchema: { type: 'object', properties: {}, required: [], additionalProperties: false, title: 'Approve' } }));
  for (const params of [undefined, {}, { ...app(), mode: 'url' }, { ...app(), message: '' }, { ...app(), message: 'x'.repeat(10001) },
    { ...app(), requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } },
    { ...app(), requestedSchema: { type: 'object', properties: {}, required: ['approved'] } },
    { ...app(), requestedSchema: { type: 'object', properties: {}, allOf: [] } }]) {
    assert.equal(classify(params), undefined);
  }
});

test('grants cover one low-risk app or one exact site with identical approval metadata', () => {
  const grant = params => classify(params).grant?.key;
  assert.equal(grant(app('CALC.EXE')), grant(app('calc.exe')));
  assert.notEqual(grant(app('notepad.exe')), grant(app()));
  assert.notEqual(grant(app('calc.exe', { persist: 'always' })), grant(app()));
  for (const params of [app('calc.exe', { riskLevel: 'high' }), app('calc.exe', { tool_params: { app: 'calc.exe', action: 'type' } }),
    app(''), app('calc.exe', { connector_id: 'browser-use' }), app('calc.exe', { codex_approval_kind: 'other' })]) {
    assert.equal(grant(params), undefined);
  }
  assert.equal(classify(site('https://example.com')).grant.kind, 'site');
  assert.notEqual(grant(site('https://example.com')), grant(site('http://example.com')));
  assert.notEqual(grant(site('https://example.com', { reviewer: 'auto' })), grant(site('https://example.com')));
  for (const params of [site('https://example.com/'), site('file:///C:/x'), site('not a url'), site('https://example.com', { origin: 'https://other.com' }),
    site('https://example.com', { tool_name: 'other' }), site('https://example.com', { tool_params: { origin: 'https://example.com', path: '/' } })]) {
    assert.equal(grant(params), undefined);
  }
});

test('the dialog shows request text as inert data with a safe default', () => {
  const view = classify({ ...app('evil\u202Eexe.txt'), message: 'Run \u202Egnp.exe\u0007 now?' }).view;
  assert.equal(view.title, 'evil\uFFFDexe.txt');
  assert.equal(view.message, 'Run \uFFFDgnp.exe\uFFFD now?');
  assert.equal(view.defaultChoice, 'grant');
  assert.equal(view.remembered, false);
  const browser = classify(site('https://example.com')).view;
  assert.deepEqual([browser.defaultChoice, browser.grant, browser.yolo, browser.remembered], ['decline', 'site', true, true]);
  const other = classify({ message: 'Continue?', requestedSchema: schema, _meta: { connector_id: 'other', riskLevel: 'high' } }).view;
  assert.deepEqual([other.defaultChoice, other.grant, other.yolo, other.risk, other.title], ['decline', undefined, false, 'high', 'Computer Use']);
});

const settle = () => new Promise(resolve => setImmediate(resolve));

test('dialogs open one at a time, and a grant chosen in one answers the queued request it covers', async () => {
  const asked = [];
  const answers = [];
  const consent = new Consent({ ask: view => new Promise(resolve => { asked.push(view.title); answers.push(resolve); }) });
  const first = consent.request(app());
  const second = consent.request(app('Calc.exe'));
  const third = consent.request(app('notepad.exe'));
  await settle();
  assert.deepEqual(asked, ['calc.exe']);
  answers[0]('grant');
  assert.deepEqual(await first.result, { action: 'accept', content: {} });
  assert.deepEqual(await second.result, { action: 'accept', content: {} });
  await settle();
  assert.deepEqual(asked, ['calc.exe', 'notepad.exe']);
  answers[1]('decline');
  assert.deepEqual(await third.result, { action: 'decline' });
  // A grant never covers a different request shape.
  const high = consent.request(app('calc.exe', { riskLevel: 'high' }));
  await settle();
  assert.equal(asked.length, 3);
  answers[2]('accept');
  assert.deepEqual(await high.result, { action: 'accept', content: {} });
});

test('YOLO is chosen explicitly and covers later Computer Use and browser confirmations only', async () => {
  const choices = ['yolo', 'decline'];
  const consent = new Consent({ ask: async () => choices.shift() });
  assert.deepEqual(await consent.request(site('https://example.com')).result, { action: 'accept', content: {} });
  assert.deepEqual(await consent.request(app('calc.exe', { riskLevel: 'high', tool_params: { app: 'calc.exe', action: 'type' } })).result, { action: 'accept', content: {} });
  assert.deepEqual(await consent.request({ message: 'Other?', requestedSchema: schema, _meta: { connector_id: 'other' } }).result, { action: 'decline' });
  assert.equal(consent.request({ ...app(), requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } }), undefined);
  // YOLO from a request that does not offer it grants nothing.
  const strict = new Consent({ ask: async () => 'yolo' });
  assert.deepEqual(await strict.request({ message: 'Other?', requestedSchema: schema }).result, { action: 'cancel' });
  assert.equal(strict.yolo, false);
});

test('a confirmation is cancelled when a call that may own it is cancelled or when all of them finish', async () => {
  const signals = [];
  const consent = new Consent({ ask: (view, signal) => new Promise(resolve => {
    signals.push(signal);
    signal.addEventListener('abort', () => resolve('accept'));
  }) });
  const shared = consent.request(app(), new Set([1, 2]));
  await settle();
  consent.settled(1);
  assert.equal(signals[0].aborted, false);
  consent.settled(2);
  assert.deepEqual(await shared.result, { action: 'cancel' });

  const owned = consent.request(app('a.exe'), new Set([3, 4]));
  const queued = consent.request(app('b.exe'), new Set([4]));
  await settle();
  consent.cancelled(4);
  assert.deepEqual(await owned.result, { action: 'cancel' });
  assert.deepEqual(await queued.result, { action: 'cancel' });
  assert.equal(signals.length, 2);
  assert.equal(consent.grants.size, 0);
});

test('only an offered choice printed by a dialog that exited normally counts', () => {
  const view = { grant: 'app', yolo: false };
  assert.equal(parseChoice('accept\r\n', 0, view), 'accept');
  assert.equal(parseChoice('grant\n', 0, view), 'grant');
  for (const [output, code] of [['accept', 1], ['yolo', 0], ['', 0], ['accept\ndecline', 0], ['true', 0]]) assert.equal(parseChoice(output, code, view), 'cancel');
  assert.equal(parseChoice('grant', 0, { yolo: true }), 'cancel');
});

test('a live native dialog closes without authorizing when its request is cancelled',
  { skip: process.platform !== 'win32' || process.env.CUA_WRAPPER_GUI_TESTS !== '1', timeout: 30000 }, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const view = classify({ ...app(), message: 'Automated test. The dialog closes itself; no app is accessed.' }).view;
      assert.equal(await showDialog(view, controller.signal), 'cancel');
    } finally { clearTimeout(timer); }
  });
