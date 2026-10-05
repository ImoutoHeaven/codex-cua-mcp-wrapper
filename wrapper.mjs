#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isAccessConfirmation, canReuseApproval, requestConsent } from './consent.mjs';

const hint = '本地 Computer Use 管道不可用。请启动 ChatGPT Desktop；若使用 Codex Desktop，请启动它并启用 Computer Use，然后在 MCP 客户端重新连接此服务，以读取最新管道配置。';
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
    throw new Error(`未找到 Codex Desktop CUA 插件。${hint}`);
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
  throw new Error(`没有找到完整可用的 Codex Desktop CUA 运行时。${hint}`);
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
  const confirmations = new Map();
  const progressTokens = new Map();
  let confirmationQueue = Promise.resolve();
  let approvalScope = null;
  const cancelConfirmations = () => {
    for (const controller of confirmations.values()) controller.abort();
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
          if (message.method === 'notifications/cancelled' ||
              (message.method === 'tools/call' && ['js_reset','turn_ended'].includes(message.params?.name))) cancelConfirmations();
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
          if (message.method === 'notifications/cancelled') confirmations.get(message.params?.requestId)?.abort();
          if (message.method === 'elicitation/create' && message.id !== undefined) {
            if (closing || !isAccessConfirmation(message.params)) {
              console.error('[codex-desktop-cua] Unsupported or cancelled confirmation; refusing to authorize.');
              await write(child.stdin,{jsonrpc:'2.0',id:message.id,result:{action:'cancel'}});
              continue;
            }
            const controller = new AbortController();
            confirmations.set(message.id,controller);
            // Do not block the protocol reader while the user decides; queue dialogs locally.
            confirmationQueue = confirmationQueue.then(async () => {
              const heartbeat = setInterval(() => {
                for (const token of progressTokens.values()) {
                  write(process.stdout,{jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:token,progress:0,message:'Waiting for local app-access confirmation'}}).catch(() => {});
                }
              },5000);
              try {
                const result = controller.signal.aborted ? {action:'cancel'} : canReuseApproval(approvalScope,message.params)
                  ? {action:'accept',content:{}} : await requestConsent(message.params,controller.signal);
                if (!closing && !controller.signal.aborted && result.action === 'accept' && result.scope) {
                  approvalScope = result.scope;
                  console.error(`[codex-desktop-cua] Session authorization enabled: ${approvalScope}; reset on reconnect.`);
                }
                if (!closing && child.stdin.writable) await write(child.stdin,{jsonrpc:'2.0',id:message.id,
                  result:controller.signal.aborted ? {action:'cancel'} : result.action === 'accept'
                    ? {action:'accept',content:result.content || {}} : {action:result.action}});
              } finally {
                clearInterval(heartbeat);
                if (confirmations.get(message.id) === controller) confirmations.delete(message.id);
              }
            }).catch(error => { console.error('[codex-desktop-cua] Confirmation delivery failed; closing the runtime.'); shutdown(); });
            continue;
          }
          if (!message.method && message.id !== undefined) {
            const method = pending.get(message.id);
            pending.delete(message.id);
            progressTokens.delete(message.id);
            if (method === 'tools/call') cancelConfirmations();
            if (method === 'tools/list' && Array.isArray(message.result?.tools)) {
              message.result.tools = message.result.tools.filter(t => allowed.has(t.name));
            }
            if (method === 'initialize' && message.result) {
              message.result.instructions = (message.result.instructions || '') + '\n' + hint +
                '\nUse js for Windows computer operations. Confirmation uses a local Windows dialog. The user can approve once, allow all app access for this connection, or explicitly select YOLO for supported Computer Use confirmations. Session choices reset on reconnect. Unsupported forms are cancelled. ' +
                'This wrapper does not install Codex turn hooks; end/reset the session when work is interrupted. Never retry failed input automatically.';
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
