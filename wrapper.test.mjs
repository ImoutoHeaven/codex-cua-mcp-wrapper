import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexHome, testEnv, client, connect } from './fixture-home.mjs';

const wrapper = fileURLToPath(new URL('./wrapper.mjs', import.meta.url));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function gone(pid, ms = 8000) {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return true;
}

// The real entry point as an MCP client starts it; stdout must carry only protocol records.
function start(t) {
  const { home, remove } = codexHome();
  const child = spawn(process.execPath, [wrapper], { env: testEnv(home), windowsHide: true });
  let raw = '', stderr = '';
  child.stdout.on('data', chunk => { raw += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit').then(([code]) => code);
  const c = client({ write: line => child.stdin.write(line), end: () => child.stdin.end(), output: child.stdout, done: exited });
  t.after(async () => { if (child.exitCode === null) child.kill(); remove(); });
  return { child, c, exited, stdout: () => raw, stderr: () => stderr };
}

test('malformed input gets a parse error, stdout stays protocol-only, and end of input stops every backend process', async t => {
  const { child, c, exited, stdout, stderr } = start(t);
  child.stdin.write('this is not json\n[1,2]\n');
  await c.initialize();
  const { pid } = await c.json('env');
  const { helper } = await c.json('helper');
  assert.ok(alive(pid) && alive(helper));
  c.send({ id: 'no-method' });
  c.send({ id: 'bad-method', method: 42 });
  c.send({ id: true, method: 'ping' });
  assert.deepEqual((await c.request('ping', {}, 'after')).result, {});
  const started = Date.now();
  child.stdin.end();
  assert.equal(await exited, 0);
  assert.ok(Date.now() - started < 8000);
  assert.ok(await gone(pid), 'backend survived');
  assert.ok(await gone(helper), 'backend helper survived');
  const records = stdout().trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.slice(0, 2).map(r => [r.id, r.error.code]), [[null, -32700], [null, -32700]]);
  assert.deepEqual(records.filter(r => r.error?.code === -32600).map(r => r.id), ['no-method', 'bad-method', null]);
  assert.ok(records.every(r => r.jsonrpc === '2.0'));
  assert.match(stderr(), /\[codex-desktop-cua\] Started runtime 26\.1023\.1 \(generation 1\)\./);
});

test('killing the wrapper stops the backend and its helpers', { skip: process.platform !== 'win32' }, async t => {
  const { child, c } = start(t);
  await c.initialize();
  const { pid } = await c.json('env');
  const { helper } = await c.json('helper');
  child.kill('SIGKILL');
  assert.ok(await gone(pid), 'backend survived');
  assert.ok(await gone(helper), 'backend helper survived');
});

// Answers initialize, then closes its stdout and keeps running.
const MUTE = `Add-Type -Namespace Fixture -Name Kernel -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);'
$id = ([Console]::In.ReadLine() | ConvertFrom-Json).id
[Console]::Out.Write('{"jsonrpc":"2.0","id":' + $id + ',"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}}}}' + [char]10)
[Console]::Out.Flush()
$null = [Fixture.Kernel]::CloseHandle([Fixture.Kernel]::GetStdHandle(-11))
Start-Sleep -Seconds 60
`;

test('a runtime that closes its output while still running is stopped instead of leaving requests pending', { skip: process.platform !== 'win32' }, async t => {
  const { home, remove } = codexHome({ '26.1': dir => {
    writeFileSync(join(dir, 'mute.ps1'), MUTE);
    return { command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-File', join(dir, 'mute.ps1')] };
  } });
  const c = connect({ env: testEnv(home) });
  t.after(async () => { await c.close(); remove(); });
  assert.ok((await c.initialize()).result);
  const listed = await c.request('tools/list', {});
  assert.match(listed.error.message, /generation 1\) closed its output while this request was running\./);
  // The generation is over before any process exits, so the next tool call reports the loss instead of running.
  const next = (await c.call('js', { code: 'state' })).result;
  assert.equal(next.isError, true);
  assert.match(next.content[0].text, /generation 1\) closed its output while idle\. .*\[backend\/STATE_LOST\]/);
});

test('a backend root that exits early takes the descendant holding its output with it', { skip: process.platform !== 'win32' }, async t => {
  const { home, remove } = codexHome();
  const c = connect({ env: testEnv(home) });
  t.after(async () => { await c.close(); remove(); });
  await c.initialize();
  const { helper } = await c.json('orphan');
  assert.ok(await gone(helper), 'descendant survived its root');
  // A call may still reach the exiting runtime; the next one runs on a new runtime.
  let result = await c.js('state');
  if (result.isError) result = await c.js('state');
  assert.match(result.content[0].text, /"seen":\["state"\]/);
});
