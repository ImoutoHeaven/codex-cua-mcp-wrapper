import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { log } from './rpc.mjs';

const DIALOG_LIMIT_MS = 45000;

// A confirmation this wrapper can answer locally: a form request with an empty schema, so accepting supplies no data.
// Anything else returns undefined and is never answered on the user's behalf.
export function classify(params) {
  const schema = params?.requestedSchema;
  const supported = !!params && (params.mode === undefined || params.mode === 'form') &&
    typeof params.message === 'string' && params.message.length > 0 && params.message.length <= 10000 &&
    schema?.type === 'object' && schema.properties !== null && typeof schema.properties === 'object' && !Array.isArray(schema.properties) &&
    Object.keys(schema.properties).length === 0 &&
    (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0)) &&
    Object.keys(schema).every(key => ['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema'].includes(key)) &&
    (schema.additionalProperties === undefined || typeof schema.additionalProperties === 'boolean');
  if (!supported) return;
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
  const input = meta.tool_params && typeof meta.tool_params === 'object' ? meta.tool_params : undefined;
  const computerUse = ['computer-use', 'browser-use'].includes(meta.connector_id) && meta.codex_approval_kind === 'mcp_tool_call';
  const grant = appGrant(meta, input, computerUse) || siteGrant(meta, input, computerUse);
  const risk = ['low', 'medium', 'high'].includes(meta.riskLevel) ? meta.riskLevel : undefined;
  return {
    grant,
    yolo: computerUse,
    view: {
      title: inert(grant?.target || (typeof input?.app === 'string' && input.app) || 'Computer Use'),
      message: inert(params.message),
      risk: risk === 'medium' || risk === 'high' ? risk : undefined,
      details: inert(JSON.stringify(input ?? {}, null, 2).slice(0, 20000)),
      grant: grant?.kind,
      yolo: computerUse,
      // Desktop's browser service may save the answer itself, even for Allow once or Decline.
      remembered: meta.connector_id === 'browser-use',
      // Low-risk app access keeps its established default; every other request defaults to Decline.
      defaultChoice: grant?.kind === 'app' ? 'grant' : 'decline',
    },
  };
}

// Grants match on the whole approval metadata, so a change in scope, persistence, reviewer or any other field asks again.
function appGrant(meta, input, computerUse) {
  if (!computerUse || meta.connector_id !== 'computer-use' || meta.riskLevel !== 'low' || !input ||
    typeof input.app !== 'string' || !input.app || Object.keys(input).some(key => key !== 'app')) return;
  return { kind: 'app', target: input.app, key: identity({ ...meta, tool_params: { app: input.app.toLowerCase() } }) };
}

function siteGrant(meta, input, computerUse) {
  const origin = input?.origin;
  if (!computerUse || meta.connector_id !== 'browser-use' || meta.tool_name !== 'access_browser_origin' ||
    typeof origin !== 'string' || meta.origin !== origin || Object.keys(input).some(key => key !== 'origin')) return;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return;
  } catch { return; }
  return { kind: 'site', target: origin, key: identity(meta) };
}

const identity = value => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

// Request text is shown as data: controls and bidirectional overrides cannot reorder or hide what the user reads.
const inert = text => String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '\uFFFD');

// Answers supported confirmations one dialog at a time and keeps this connection's grants.
export class Consent {
  constructor({ ask = showDialog } = {}) {
    this.ask = ask;
    this.grants = new Set();
    this.yolo = false;
    this.queue = Promise.resolve();
    this.open = new Set();
  }

  // owners: the in-flight tool calls when the request arrived. The request names no parent, so any of them may own it.
  // Returns { result, abort } or undefined when the form is unsupported.
  request(params, owners = new Set()) {
    const request = classify(params);
    if (!request) return;
    const entry = { controller: new AbortController(), owners };
    this.open.add(entry);
    const { signal } = entry.controller;
    const run = async () => {
      if (signal.aborted) return { action: 'cancel' };
      if (this.reusable(request)) {
        log(`Approved from this connection's ${this.yolo ? 'YOLO' : `${request.grant.kind} grant`}: ${request.view.title}.`);
        return { action: 'accept', content: {} };
      }
      const choice = await this.ask(request.view, signal);
      if (signal.aborted) return { action: 'cancel' };
      if (choice === 'grant' && request.grant) this.grants.add(request.grant.key);
      else if (choice === 'yolo' && request.yolo) this.yolo = true;
      else if (choice !== 'accept') return { action: choice === 'decline' ? 'decline' : 'cancel' };
      return { action: 'accept', content: {} };
    };
    const result = this.queue.then(run).catch(() => ({ action: 'cancel' })).finally(() => this.open.delete(entry));
    this.queue = result;
    return { result, abort: () => entry.controller.abort() };
  }

  reusable(request) {
    return (this.yolo && request.yolo) || (!!request.grant && this.grants.has(request.grant.key));
  }

  // A cancelled call cancels every confirmation it may own.
  cancelled(id) {
    for (const entry of this.open) if (entry.owners.has(id)) entry.controller.abort();
  }

  // A confirmation is orphaned once every call that may own it has finished.
  settled(id) {
    for (const entry of this.open) if (entry.owners.delete(id) && !entry.owners.size) entry.controller.abort();
  }

  cancelAll() {
    for (const entry of this.open) entry.controller.abort();
  }
}

export function parseChoice(output, exitCode, view) {
  const choice = exitCode === 0 ? output.trim() : '';
  if (choice === 'accept' || choice === 'decline') return choice;
  if (choice === 'grant' && view.grant) return choice;
  if (choice === 'yolo' && view.yolo) return choice;
  return 'cancel';
}

// Shows the native dialog. Resolves 'decline' | 'accept' | 'grant' | 'yolo' | 'cancel'.
export async function showDialog(view, signal) {
  if (process.platform !== 'win32') {
    log('Local confirmation needs Windows; cancelled.');
    return 'cancel';
  }
  if (signal.aborted) return 'cancel';
  let dir, child, timer;
  let output = '', diagnostics = '', visible = false, cancelled = false;
  const abort = () => { cancelled = true; child?.kill(); };
  try {
    dir = mkdtempSync(join(tmpdir(), 'cua-confirmation-'));
    const path = join(dir, 'request.json');
    // The request is data read by a fixed script, never interpolated into PowerShell or XAML.
    writeFileSync(path, JSON.stringify(view), { mode: 0o600 });
    return await new Promise(resolve => {
      child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-STA', '-File', fileURLToPath(new URL('./confirm-access.ps1', import.meta.url)), '-RequestPath', path],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 256) abort(); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        diagnostics = (diagnostics + chunk).slice(-4096);
        if (!visible && /^CUA_CONFIRM_VISIBLE\r?$/m.test(diagnostics)) {
          visible = true;
          log('Confirmation window is visible; waiting for your choice.');
        }
      });
      child.once('error', error => {
        log(`Could not open the confirmation window (${error.message}); cancelled.`);
        resolve('cancel');
      });
      child.once('close', code => {
        if (!visible && !cancelled) log(`Confirmation window did not appear; cancelled.${diagnostics.trim() ? ` ${diagnostics.trim().slice(-500)}` : ''}`);
        const choice = cancelled || !visible ? 'cancel' : parseChoice(output, code, view);
        log(`Confirmation result: ${choice}.`);
        resolve(choice);
      });
      timer = setTimeout(abort, DIALOG_LIMIT_MS);
    });
  } catch (error) {
    log(`Confirmation failed (${error.message}); cancelled.`);
    return 'cancel';
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
