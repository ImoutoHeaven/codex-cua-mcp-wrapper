import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { records, writer } from './rpc.mjs';

test('an oversized record is rejected and the stream keeps going', async () => {
  const input = new PassThrough();
  const seen = [];
  const reading = (async () => { for await (const record of records(input)) seen.push(record); })();
  const huge = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { data: 'a'.repeat(64 * 1024 * 1024) } });
  input.write(huge.slice(0, 40 * 1024 * 1024));
  input.write(huge.slice(40 * 1024 * 1024) + '\n{"jsonrpc":"2.0","method":"after"}\n[]\n');
  input.end('{"jsonrpc":"2.0","method":"tail"}');
  await reading;
  assert.deepEqual(seen, [{ error: 'Record exceeds 64 MiB' }, { message: { jsonrpc: '2.0', method: 'after' } },
    { error: 'Record is not a JSON object' }, { message: { jsonrpc: '2.0', method: 'tail' } }]);
});

test('writes wait for a slow reader in order, leave no listeners, and fail once the stream closes', async () => {
  const lines = [];
  const slow = new Writable({ highWaterMark: 16, write(chunk, _, done) { lines.push(String(chunk)); setTimeout(done, 1); } });
  const send = writer(slow);
  await Promise.all(Array.from({ length: 20 }, (_, i) => send({ i })));
  assert.deepEqual(lines.map(line => JSON.parse(line).i), Array.from({ length: 20 }, (_, i) => i));
  assert.equal(slow.listenerCount('drain') + slow.listenerCount('close'), 0);
  slow.destroy();
  await assert.rejects(send({ late: true }), /stream closed/);
});
