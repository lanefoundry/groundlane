// Controlled live D1/auth smoke. Never rotates or revokes an existing credential.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { z } from 'zod';

const sqlRows = z.array(z.object({ success: z.literal(true), results: z.array(z.record(z.string(), z.unknown())) }));
const initialization = z.object({ result: z.object({ serverInfo: z.object({ name: z.string() }), protocolVersion: z.string() }).optional() });
interface InitializationResult { status: number; initialized: boolean; protocolVersion: string | null }

if (!process.argv.includes('--run')) {
  console.log('Set GROUNDLANE_AUTH_TOKEN and run with --run. Creates and removes one short-lived smoke credential in groundlane-managed-tokens; no provider calls.');
  process.exit(0);
}
const control = process.env.GROUNDLANE_AUTH_TOKEN;
if (!control) throw new Error('GROUNDLANE_AUTH_TOKEN is required for the healthy control request');
const endpoint = 'https://groundlane.vincent-xu-work.workers.dev/mcp';
const id = `smoke721_${randomUUID().replaceAll('-', '')}`;
const secret = randomBytes(32).toString('base64url');
const verifier = createHash('sha256').update(secret).digest('hex');
const token = `glmt_${id}.${secret}`;
const directory = await mkdtemp(join(tmpdir(), 'groundlane-revoke-smoke-'));
const sqlPath = join(directory, 'query.sql');
const evidence = { checkedAt: new Date().toISOString(), endpoint, credentialId: id,
  fixtureTtlSeconds: 600, revokeMethod: 'direct D1 conditional UPDATE; admin API not tested',
  before: [] as InitializationResult[], after: [] as InitializationResult[], control: null as InitializationResult | null, revokeCommitted: false, cleaned: false, ok: false };

async function sql(statement: string, query = false): Promise<z.infer<typeof sqlRows>> {
  // Generated SQL contains a verifier, never the bearer secret. Owner-only temp
  // file keeps it out of argv and output; remove it in the outer finally block.
  await writeFile(sqlPath, statement, { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'groundlane-managed-tokens',
      '--remote', ...(query ? ['--command', statement] : ['--file', sqlPath]), '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 262144) child.kill('SIGTERM'); });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('D1 smoke command failed')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('D1 smoke command failed'));
      try { resolve(sqlRows.parse(JSON.parse(output.slice(output.indexOf('['))) as unknown)); }
      catch { reject(new Error('D1 smoke response invalid')); }
    });
  });
}

async function initialize(bearer: string): Promise<InitializationResult> {
  const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25',
      capabilities: {}, clientInfo: { name: 'groundlane-revoke-smoke', version: '1' } } }) });
  const reader = response.body?.getReader();
  let text = '';
  if (reader) try {
    for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); if (text.length > 65536) throw new Error('MCP response too large'); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(text) as unknown; }
  catch { for (const line of text.split('\n')) if (line.startsWith('data:')) { try { body = JSON.parse(line.slice(5)) as unknown; } catch { /* Ignore SSE comments. */ } } }
  const parsed = initialization.safeParse(body);
  return { status: response.status, initialized: parsed.success && parsed.data.result !== undefined,
    protocolVersion: parsed.success ? parsed.data.result?.protocolVersion ?? null : null };
}

let failure: string | undefined;
try {
  evidence.control = await initialize(control);
  if (!evidence.control.initialized) throw new Error('Control MCP initialization failed');
  const now = Date.now();
  await sql(`INSERT INTO managed_credentials(id,verifier,principal_id,scopes,label,status,created_at,updated_at,expires_at)
    VALUES('${id}','${verifier}','owner','["mcp"]','${id}','active',${now},${now},${now + 600000});`);
  for (let i = 0; i < 3; i++) evidence.before.push(await initialize(token));
  if (evidence.before.some(row => row.status !== 200 || !row.initialized)) throw new Error('Managed fixture did not initialize before revoke');
  const revokedAt = Date.now();
  await sql(`UPDATE managed_credentials SET status='revoked',revoked_at=${revokedAt},updated_at=${revokedAt}
    WHERE id='${id}' AND label='${id}' AND status='active';`);
  const committed = await sql(`SELECT status FROM managed_credentials WHERE id='${id}' AND label='${id}';`, true);
  evidence.revokeCommitted = committed.some(row => row.results?.some(record => record.status === 'revoked'));
  if (!evidence.revokeCommitted) throw new Error('Revoke commit not verified');
  for (let i = 0; i < 10; i++) evidence.after.push(await initialize(token));
  evidence.control = await initialize(control);
  evidence.ok = evidence.after.every(row => row.status === 401 && !row.initialized) && evidence.control.initialized;
  if (!evidence.ok) throw new Error('Post-revoke authorization invariant failed');
} catch (error) { failure = error instanceof Error ? error.message : 'Smoke failed'; }
finally {
  try {
    await sql(`DELETE FROM managed_credentials WHERE id='${id}' AND label='${id}';`);
    const rows = await sql(`SELECT COUNT(*) AS remaining FROM managed_credentials WHERE id='${id}';`, true);
    evidence.cleaned = rows.some(row => row.results?.some(record => record.remaining === 0));
  } catch { evidence.cleaned = false; }
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...evidence, ...(failure ? { failure } : {}) }, null, 2));
if (!evidence.ok || !evidence.cleaned) process.exitCode = 1;
