#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isAccessConfirmation, canReuseApproval, rememberApproval, requestConsent } from './consent.mjs';

const hint = 'The local Computer Use pipe is unavailable. Start ChatGPT Desktop (or Codex Desktop with Computer Use enabled), then reconnect this server in the MCP client to load the current pipe configuration.';
const pipeFailure = /(?:native pipe|named pipe).*(?:unavailable|timed out|closed|failed|not found)|failed to connect native pipe/i;
const knownTools = new Set(['js', 'js_reset', 'turn_ended']);
const home = process.env.CODEX_HOME || join(homedir(), '.codex');
const root = join(home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
const isFile = path => typeof path === 'string' && isAbsolute(path) && statSync(path, { throwIfNoEntry: false })?.isFile();

function discover() {
  let versions;
  try {
    versions = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d+(?:\.\d+)+$/.test(d.name))
      .map(d => d.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  } catch {
    throw new Error(`Codex Desktop CUA plugin not found. ${hint}`);
  }
  for (const version of versions) {
    try {
      const config = JSON.parse(readFileSync(join(root, version, '.mcp.json'), 'utf8')).mcpServers?.cua_repl;
      if (!config || config.enabled === false || !isFile(config.command) || !Array.isArray(config.args) ||
          !config.args.every(a => typeof a === 'string') || !isFile(config.args[0]) || !isFile(config.env?.CUA_REPL_NODE_REPL_PATH)) continue;
      if (Object.values(config.env || {}).some(v => typeof v !== 'string')) continue;
      const services = JSON.parse(config.env?.NODE_REPL_TRUSTED_SERVICES || '{}');
      if (!services || Array.isArray(services) || typeof services !== 'object') continue;
      return { config, version, services };
    } catch { /* An incomplete update must not hide an older usable runtime. */ }
  }
  throw new Error(`No complete, usable Codex Desktop CUA runtime found. ${hint}`);
}

async function write(stream, value) {
  if (!stream.write(JSON.stringify(value) + '\n')) await once(stream, 'drain');
}

// Split on LF only: U+2028/U+2029 are valid inside MCP JSON strings.
async function* records(stream) {
  stream.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) yield JSON.parse(line);
    }
    if (buffer.length > 64 * 1024 * 1024) throw new Error('MCP record exceeds 64 MiB');
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

async function main() {
  const { config, version, services } = discover();
  const allowed = new Set((config.enabled_tools || [...knownTools]).filter(t => knownTools.has(t)));
  if (!allowed.has('js')) throw new Error('The installed plugin does not enable the js tool.');
  // Use the documented computer surface, retaining the installed approval/pipe settings.
  const env = { ...process.env, ...config.env, CUA_REPL_ENABLED_SURFACES: 'computer',
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ ...services, sky: '@oai/sky/service' }) };
  const child = spawn(config.command, config.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  // Elicitation id -> { controller, calls }: calls are the client tool calls pending when it arrived.
  // The wire format does not name the parent request, so any of them may own it.
  const confirmations = new Map();
  const progressTokens = new Map();
  let confirmationQueue = Promise.resolve();
  const approvals = { yolo: false, apps: new Set() };
  // Without an id, cancel every confirmation; with one, only those it may own.
  const cancelConfirmations = id => {
    for (const { controller, calls } of confirmations.values()) if (id === undefined || calls.has(id)) controller.abort();
  };
  let closing = false;
  let timer;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    cancelConfirmations();
    child.stdin.end();
    timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode) return;
      if (process.platform === 'win32') {
        spawn(process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else child.kill('SIGTERM');
    }, 5000);
    timer.unref();
  };
  child.stdin.on('error', () => {});
  child.stderr.pipe(process.stderr);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      cancelConfirmations();
      process.stdin.destroy();
      resolve(signal ? 1 : code ?? 1);
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  console.error(`[codex-desktop-cua] Using installed plugin ${version}; computer surface, local stdio.`);
  try {
    await Promise.all([
      (async () => {
        for await (const message of records(process.stdin)) {
          if (message.method === 'initialize') {
            message.params ||= {};
            message.params.capabilities ||= {};
            message.params.capabilities.elicitation = { form: {} };
          }
          if (message.method === 'notifications/cancelled' && pending.get(message.params?.requestId) === 'tools/call') cancelConfirmations(message.params.requestId);
          if (message.method === 'tools/call' && ['js_reset','turn_ended'].includes(message.params?.name)) cancelConfirmations();
          if (message.method === 'tools/call' && !allowed.has(message.params?.name)) {
            if (message.id !== undefined) await write(process.stdout, { jsonrpc: '2.0', id: message.id,
              error: { code: -32602, message: 'Tool is not enabled by this desktop wrapper.' } });
            continue;
          }
          if (message.method && message.id !== undefined) {
            pending.set(message.id, message.method);
            if (message.params?._meta?.progressToken !== undefined) progressTokens.set(message.id,message.params._meta.progressToken);
          }
          // Forward non-elicitation messages and responses without changing their meaning.
          await write(child.stdin, message);
        }
        shutdown();
      })(),
      (async () => {
        for await (const message of records(child.stdout)) {
          if (message.method === 'notifications/cancelled') confirmations.get(message.params?.requestId)?.controller.abort();
          if (message.method === 'elicitation/create' && message.id !== undefined) {
            if (closing || !isAccessConfirmation(message.params)) {
              console.error('[codex-desktop-cua] Unsupported or cancelled confirmation; refusing to authorize.');
              await write(child.stdin,{jsonrpc:'2.0',id:message.id,result:{action:'cancel'}});
              continue;
            }
            const controller = new AbortController();
            const entry = { controller, calls: new Set([...pending].filter(([, method]) => method === 'tools/call').map(([id]) => id)) };
            confirmations.set(message.id,entry);
            // Do not block the protocol reader while the user decides; queue dialogs locally.
            confirmationQueue = confirmationQueue.then(async () => {
              const heartbeat = setInterval(() => {
                for (const id of entry.calls) {
                  const token = progressTokens.get(id);
                  if (token !== undefined) write(process.stdout,{jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:token,progress:0,message:'Waiting for local app-access confirmation'}}).catch(() => {});
                }
              },5000);
              try {
                const result = controller.signal.aborted ? {action:'cancel'} : canReuseApproval(approvals,message.params)
                  ? {action:'accept',content:{}} : await requestConsent(message.params,controller.signal);
                if (!closing && !controller.signal.aborted && result.action === 'accept' && result.scope) {
                  rememberApproval(approvals,result.scope,message.params);
                  console.error(`[codex-desktop-cua] Session authorization enabled: ${result.scope}; reset on reconnect.`);
                }
                if (!closing && child.stdin.writable) await write(child.stdin,{jsonrpc:'2.0',id:message.id,
                  result:controller.signal.aborted ? {action:'cancel'} : result.action === 'accept'
                    ? {action:'accept',content:result.content || {}} : {action:result.action}});
              } finally {
                clearInterval(heartbeat);
                if (confirmations.get(message.id) === entry) confirmations.delete(message.id);
              }
            }).catch(error => { console.error('[codex-desktop-cua] Confirmation delivery failed; closing the runtime.'); shutdown(); });
            continue;
          }
          if (!message.method && message.id !== undefined) {
            const method = pending.get(message.id);
            pending.delete(message.id);
            progressTokens.delete(message.id);
            // A confirmation is orphaned once every request that may own it has finished.
            for (const { controller, calls } of confirmations.values()) {
              if (calls.delete(message.id) && !calls.size) controller.abort();
            }
            if (method === 'tools/list' && Array.isArray(message.result?.tools)) {
              message.result.tools = message.result.tools.filter(t => allowed.has(t.name));
              const js = message.result.tools.find(t => t.name === 'js');
              if (typeof js?.description === 'string') js.description += '\n\nOn Windows, `cua.getApp` accepts only `{ windowId }` from `cua.listApps()` or `cua.listWindows()`; app names and paths fail. ' +
                'If the first observation after input looks unchanged, observe again before acting.';
            }
            if (method === 'initialize' && message.result) {
              message.result.instructions = (message.result.instructions || '') +
                '\nUse js for Windows computer operations. Confirmation uses a local Windows dialog. The user can decline, approve once, allow the same app for this connection, or select YOLO for supported Computer Use confirmations; after 15 seconds the dialog applies its default (allow the same app, or decline when that option is unavailable). Session choices reset on reconnect. Unsupported forms are cancelled. ' +
                'This wrapper does not install Codex turn hooks and nothing else here detects the end of a turn. End every turn that used computer control by calling turn_ended and js_reset, so the local Computer Use indication does not outlive the work. Never retry failed input automatically.';
            }
            if (message.result?.isError && pipeFailure.test((message.result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'))) {
              message.result.content.push({ type: 'text', text: hint });
            }
            if (message.error && pipeFailure.test(message.error.message || '')) message.error.message += '\n' + hint;
          }
          await write(process.stdout, message);
        }
      })(),
      exited.then(code => { process.exitCode = code; }),
    ]);
  } finally { shutdown(); }
}

main().catch(error => {
  console.error(`[codex-desktop-cua] ${error.message}`);
  process.exitCode = 1;
  process.stdin.destroy();
});
