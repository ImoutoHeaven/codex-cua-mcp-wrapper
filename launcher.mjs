import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// The plugin's browser-access bootstrap. In a standalone host it only sets an empty executor id, which turns on
// Desktop's signed browser-access check without the Desktop host that answers it.
const ACCESS_BOOTSTRAP = 'process.env.BROWSER_USE_ACCESS_EXECUTOR_ID ??= "";';
// Desktop host context the manifest passes through; with any of it present the launch stays exactly as declared.
const HOST_CONTEXT = ['BROWSER_USE_ACCESS_EXECUTOR_ID', 'BROWSER_USE_ACCESS_PIPE_PATH', 'BROWSER_USE_ACCESS_VERIFYING_IDENTITY', 'CODEX_WINDOWS_REGISTERED_CORE'];
// Leading preload options are examined; the first other argument (an unknown option, `--` or the entry script) ends the
// scan, because its arity is unknown and what follows may be a value.
const PRELOADS = new Set(['--import', '--require', '-r']);

// The launch exactly as the manifest declares it, inheriting this process's environment, with one adaptation:
// the recognized access bootstrap is dropped when no Desktop host context is inherited.
export function plan(candidate, inherited = process.env) {
  const { server } = candidate;
  const env = merge(inherited, server.env || {});
  const args = [...(server.args || [])];
  const notes = [];
  const hostPresent = HOST_CONTEXT.some(name => lookup(env, name) !== undefined);
  for (let i = 0; i < args.length;) {
    const inline = args[i].startsWith('--') && args[i].includes('=');
    const option = inline ? args[i].slice(0, args[i].indexOf('=')) : args[i];
    const value = inline ? args[i].slice(option.length + 1) : args[i + 1];
    if (!PRELOADS.has(option) || value === undefined) break;
    const span = inline ? 1 : 2;
    if (option === '--import' && isAccessBootstrap(value)) {
      if (!hostPresent) {
        args.splice(i, span);
        notes.push(`Omitted browser-access bootstrap ${value}: no Desktop host context is inherited.`);
        continue;
      }
      notes.push('Kept browser-access bootstrap: Desktop host context is inherited.');
    } else notes.push(`Kept unrecognized preload ${option} ${value}.`);
    i += span;
  }
  // The manifest's startup budget bounds the handshake; Node timers hold at most 2^31 - 1 ms.
  const seconds = server.startup_timeout_sec;
  const startupMs = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 2 ** 31 - 1) : 30000;
  return { name: candidate.name, command: server.command, args, env, cwd: server.cwd, startupMs, notes };
}

function isAccessBootstrap(spec) {
  try {
    const path = spec.startsWith('file:') ? fileURLToPath(spec) : undefined;
    if (!path || !(statSync(path, { throwIfNoEntry: false })?.size <= 4096)) return false;
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim() === ACCESS_BOOTSTRAP;
  } catch { return false; }
}

// Windows environment names are case-insensitive: an override replaces every spelling.
function merge(base, override) {
  const env = { ...base };
  for (const [name, value] of Object.entries(override)) {
    if (process.platform === 'win32') for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
    env[name] = value;
  }
  return env;
}

function lookup(env, name) {
  const key = Object.keys(env).find(k => process.platform === 'win32' ? k.toUpperCase() === name : k === name);
  return key === undefined ? undefined : env[key];
}

// On Windows the backend runs under job-host.ps1, which owns a kill-on-close job holding the backend's whole tree.
export function spawnBackend(launch) {
  const options = { env: launch.env, cwd: launch.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (process.platform !== 'win32') return spawn(launch.command, launch.args, options);
  const host = fileURLToPath(new URL('./job-host.ps1', import.meta.url));
  return spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', host, String(process.pid)],
    { ...options, env: { ...launch.env, CUA_JOB_HOST_ARGV: JSON.stringify([launch.command, ...launch.args]) } });
}

const exited = child => child.exitCode !== null || child.signalCode !== null;
const settle = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms).unref())]);

// Ends the backend: end of input first, then a kill. On Windows killing the job host closes the job, which ends
// every backend process. Bounded by about 2 * graceMs. Resolves false when the backend's stdio stayed open.
export async function terminate(child, graceMs = 3000) {
  const closed = child.__closed ||= once(child, 'close').catch(() => {});
  if (!exited(child) && child.pid !== undefined) {
    child.stdin.end();
    await settle(once(child, 'exit'), graceMs);
    if (!exited(child)) child.kill('SIGKILL');
  }
  await settle(closed, graceMs);
  if (child.stdout.readable || child.stderr.readable) {
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
    return false;
  }
  return true;
}
