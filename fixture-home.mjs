import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { Supervisor } from './supervisor.mjs';
import { Consent } from './consent.mjs';

export const backend = fileURLToPath(new URL('./fixture-backend.mjs', import.meta.url));
const HOST = ['BROWSER_USE_ACCESS_EXECUTOR_ID', 'BROWSER_USE_ACCESS_PIPE_PATH', 'BROWSER_USE_ACCESS_VERIFYING_IDENTITY', 'CODEX_WINDOWS_REGISTERED_CORE'];

// A Codex home holding plugin builds whose cua_repl server is the fixture backend. server(dir) returns the manifest entry.
export function codexHome(builds = { '26.1023.1': () => ({}) }) {
  const home = mkdtempSync(join(tmpdir(), 'cua-wrapper-test-'));
  for (const [name, server] of Object.entries(builds)) {
    const dir = join(home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', name);
    mkdirSync(dir, { recursive: true });
    const entry = { command: process.execPath, args: [backend], ...server(dir) };
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: entry } }));
  }
  return { home, remove: () => rmSync(home, { recursive: true, force: true }) };
}

// The test's environment without any inherited Desktop host context, pointed at a fixture Codex home.
export function testEnv(home, extra = {}) {
  const env = { ...process.env, CODEX_HOME: home, ...extra };
  for (const name of HOST) if (!(name in extra)) delete env[name];
  return env;
}

// An MCP client speaking to an in-process Supervisor.
export function connect({ env, ask = async () => 'cancel', capabilities = {} }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const supervisor = new Supervisor({ input, output, env, consent: new Consent({ ask }) });
  const done = supervisor.run();
  return client({ write: line => input.write(line), end: () => input.end(), output, done, capabilities });
}

export function client({ write, end, output, done, capabilities = {} }) {
  const waiters = new Map();
  const notes = [];
  const requests = [];
  let nextId = 0, buffer = '';
  const handlers = [];
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.method && message.id !== undefined) { requests.push(message); handlers.forEach(h => h(message)); }
      else if (message.method) { notes.push(message); handlers.forEach(h => h(message)); }
      else waiters.get(JSON.stringify(message.id))?.(message);
    }
  });
  const send = message => write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params, id = ++nextId) => new Promise(resolve => {
    waiters.set(JSON.stringify(id), resolve);
    send({ id, method, params });
  });
  const api = {
    send, request, notes, requests, done,
    on: handler => handlers.push(handler),
    initialize: () => request('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'test', version: '1' } }),
    call: (name, args, extra = {}) => request('tools/call', { name, arguments: args, ...extra }),
    js: async (code, extra) => api.call('js', { code }, extra).then(r => r.result),
    json: async (code, extra) => JSON.parse((await api.js(code, extra)).content[0].text),
    // Waits until a message matching predicate has arrived.
    until: async (predicate, ms = 8000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = [...requests, ...notes].find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('timed out waiting for a message');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    close: async () => { end(); await done; },
  };
  return api;
}

export const text = result => result.content.map(c => c.text).join('\n');
