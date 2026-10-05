import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Only the empty access-confirmation form observed in the local CUA protocol.
// A schema change requires explicit implementation rather than a guessed approval.
export function isAccessConfirmation(params) {
 const schema = params?.requestedSchema;
 return !!params && (params.mode === undefined || params.mode === 'form') &&
  typeof params.message === 'string' && params.message.length > 0 && params.message.length <= 10000 &&
  schema?.type === 'object' && schema.properties != null && typeof schema.properties === 'object' &&
  !Array.isArray(schema.properties) && Object.keys(schema.properties).length === 0 &&
  (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0)) &&
  Object.keys(schema).every(key => ['type','properties','required','additionalProperties','title','description','$schema'].includes(key)) &&
  (schema.additionalProperties === undefined || typeof schema.additionalProperties === 'boolean');
}

function isComputerUseConfirmation(params) {
 return isAccessConfirmation(params) && params._meta?.connector_id === 'computer-use' &&
  params._meta.codex_approval_kind === 'mcp_tool_call';
}

export function isApplicationAccessConfirmation(params) {
 const input = params?._meta?.tool_params;
 return isComputerUseConfirmation(params) && params._meta.riskLevel === 'low' &&
  !!input && typeof input.app === 'string' && input.app.length > 0 && Object.keys(input).every(key => key === 'app');
}

export function canReuseApproval(scope, params) {
 return scope === 'yolo' ? isComputerUseConfirmation(params) : scope === 'apps' && isApplicationAccessConfirmation(params);
}

export function parseChoice(output, exitCode, scopes = {}) {
 if (exitCode !== 0) return { action: 'cancel' };
 if (output.trim() === 'accept_all' && scopes.apps) return {action:'accept',content:{},scope:'apps'};
 if (output.trim() === 'yolo' && scopes.yolo) return {action:'accept',content:{},scope:'yolo'};
 if (output.trim() === 'accept') return { action: 'accept', content: {} };
 if (output.trim() === 'decline') return { action: 'decline' };
 return { action: 'cancel' };
}

export async function requestConsent(params, signal) {
 if (!isAccessConfirmation(params) || signal.aborted || process.platform !== 'win32') return { action: 'cancel' };
 let dir;
 let child;
 let timer;
 let output = '';
 let cancelled = false;
 let visible = false;
 let diagnostics = '';
 const scopes = {apps:isApplicationAccessConfirmation(params),yolo:isComputerUseConfirmation(params)};
 const abort = () => { cancelled = true; child?.kill(); };
 try {
  dir = mkdtempSync(join(tmpdir(), 'cua-access-confirmation-'));
  const path = join(dir, 'request.json');
  // Payload is data read by the fixed script, never interpolated into PowerShell.
  writeFileSync(path, JSON.stringify({...params,allowSessionAll:scopes.apps,allowYolo:scopes.yolo}), { mode: 0o600 });
  return await new Promise(resolve => {
   child = spawn('pwsh', ['-NoProfile','-NonInteractive','-STA','-File',fileURLToPath(new URL('./confirm-access.ps1',import.meta.url)),'-RequestPath',path],
    { stdio: ['ignore','pipe','pipe'], windowsHide: false });
   signal.addEventListener('abort',abort,{once:true});
   if (signal.aborted) abort();
   child.stdout.setEncoding('utf8');
   child.stdout.on('data',chunk => { output += chunk; if (output.length > 256) abort(); });
   child.stderr.setEncoding('utf8');
   child.stderr.on('data',chunk => {
    diagnostics = (diagnostics + chunk).slice(-2048);
    if (!visible && /^CUA_CONFIRM_VISIBLE\r?$/m.test(diagnostics)) {
     visible = true;
     console.error('[codex-desktop-cua] Confirmation window is visible; awaiting your choice.');
    }
   });
   child.once('error',() => {
    console.error('[codex-desktop-cua] Unable to launch native confirmation; cancelling.');
    resolve({action:'cancel'});
   });
   child.once('close',code => {
    if (!visible) console.error('[codex-desktop-cua] Confirmation did not become visible; cancelling.');
    const result = cancelled || !visible ? {action:'cancel'} : parseChoice(output,code,scopes);
    console.error(`[codex-desktop-cua] Local confirmation result: ${result.scope || result.action}.`);
    resolve(result);
   });
   timer = setTimeout(abort,45000);
   console.error('[codex-desktop-cua] Waiting for local app-access confirmation (45s; default cancel).');
  });
 } catch {
  return {action:'cancel'};
 } finally {
  clearTimeout(timer);
  signal.removeEventListener('abort',abort);
  if (dir) rmSync(dir,{recursive:true,force:true});
 }
}
