import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { codexHome, testEnv, connect, backend } from './fixture-home.mjs';
import { plan } from './launcher.mjs';

const BOOTSTRAP = 'process.env.BROWSER_USE_ACCESS_EXECUTOR_ID ??= "";\n';

// Starts the wrapper on one plugin build and returns what the fixture backend saw at launch.
async function launched(t, server, extraEnv = {}) {
  const { home, remove } = codexHome({ '26.1023.51421': server });
  const c = connect({ env: testEnv(home, extraEnv) });
  t.after(async () => { await c.close(); remove(); });
  assert.ok((await c.initialize()).result);
  return c.json('env');
}

const preload = (dir, content = BOOTSTRAP, name = 'require-browser-access.mjs') => {
  writeFileSync(join(dir, name), content);
  return pathToFileURL(join(dir, name)).href;
};

test('the browser-access bootstrap is omitted only when no Desktop host context is inherited', async t => {
  const separate = await launched(t, dir => ({ args: ['--import', preload(dir), backend] }));
  assert.deepEqual(separate.execArgv, []);
  assert.equal(separate.executor, null);

  const inline = await launched(t, dir => ({ args: [`--import=${preload(dir, '\uFEFF' + BOOTSTRAP.replace('\n', '\r\n'))}`, backend] }));
  assert.deepEqual(inline.execArgv, []);

  for (const host of ['BROWSER_USE_ACCESS_PIPE_PATH', 'CODEX_WINDOWS_REGISTERED_CORE']) {
    const kept = await launched(t, dir => ({ args: ['--import', preload(dir), backend] }), { [host]: 'from-desktop' });
    assert.equal(kept.execArgv[0], '--import');
    assert.equal(kept.executor, '');
  }
  const inherited = await launched(t, dir => ({ args: ['--import', preload(dir), backend] }), { BROWSER_USE_ACCESS_EXECUTOR_ID: 'desktop-executor' });
  assert.equal(inherited.executor, 'desktop-executor');
});

test('other preloads, argument text and manifest environment reach the backend unchanged', async t => {
  const other = await launched(t, dir => ({
    args: ['--import', preload(dir, 'process.env.FIXTURE_MARKER = "preloaded";\n', 'other.mjs'), backend, 'a b', 'quote " inside', 'trailing\\', '', 'ünïcode'],
    env: { CUA_REPL_ENABLED_SURFACES: 'browser', NODE_REPL_TRUSTED_SERVICES: '{"browser":"@oai/browser-desktop/service"}' },
    unknown_field: { kept: true },
  }));
  assert.equal(other.marker, 'preloaded');
  assert.equal(other.execArgv[0], '--import');
  assert.deepEqual(other.argv, ['a b', 'quote " inside', 'trailing\\', '', 'ünïcode']);
  assert.equal(other.hostArgv, null);
  assert.equal(other.surfaces, 'browser');
  assert.equal(other.services, '{"browser":"@oai/browser-desktop/service"}');

  const changed = await launched(t, dir => ({ args: ['--import', preload(dir, BOOTSTRAP + 'process.env.FIXTURE_MARKER = "changed";\n'), backend] }));
  assert.equal(changed.marker, 'changed');
  assert.equal(changed.executor, '');
});

test('the manifest startup budget bounds the handshake', () => {
  const budget = startup_timeout_sec => plan({ name: 'x', server: { command: 'node', startup_timeout_sec } }, {}).startupMs;
  assert.deepEqual([120, 0.5, undefined, 0, -1, '120', Infinity, 1e12].map(budget), [120000, 500, 30000, 30000, 30000, 30000, 30000, 2 ** 31 - 1]);
});

test('the bootstrap is recognized only in the leading preload options', async t => {
  // After an option of unknown arity, `--import` may be its value; after the entry it is a script argument.
  const afterUnknown = await launched(t, dir => ({ args: ['--conditions', 'cua', '--import', preload(dir), backend] }));
  assert.deepEqual(afterUnknown.execArgv.slice(0, 3), ['--conditions', 'cua', '--import']);
  assert.equal(afterUnknown.executor, '');
  const asArgument = await launched(t, dir => ({ args: [backend, '--import', preload(dir)] }));
  assert.deepEqual(asArgument.argv.slice(0, 1), ['--import']);
  const afterRequire = await launched(t, dir => ({ args: ['-r', fileURLToPath(preload(dir, 'process.env.FIXTURE_MARKER = "required";\n', 'r.cjs')), '--import', preload(dir), backend] }));
  assert.equal(afterRequire.marker, 'required');
  assert.equal(afterRequire.executor, null);
});
