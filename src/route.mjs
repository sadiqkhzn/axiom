// General-purpose Telegraph Mind - core router.
// One integration (Anjoman agent API) routes ANY plain-language task to the right
// Telegraph specialist and returns a sourced, receipted answer. No per-task wiring.
//
// Usage:
//   node route.mjs "Is ACME Corp on a sanctions list?"            # Telegraph-backed
//   node route.mjs --baseline "Is ACME Corp on a sanctions list?" # no-specialist A/B baseline
//
// Key is read from the repo-root .env (ANJOMAN_API_KEY). It is never hardcoded and never logged.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://backend.telegraphprotocol.com';

function loadKey() {
  if (process.env.ANJOMAN_API_KEY) return process.env.ANJOMAN_API_KEY;
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  const txt = readFileSync(envPath, 'utf8');
  const m = txt.match(/^ANJOMAN_API_KEY=(.+)$/m);
  if (!m) throw new Error('ANJOMAN_API_KEY not found in .env (copy .env.example to .env and set it)');
  return m[1].trim();
}

const KEY = loadKey();
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function getJSON(path) {
  const r = await fetch(BASE + path, { headers: H });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export async function escrowBalance() {
  return (await getJSON('/engine/escrow/balance')).body;
}

// Poll an async job until terminal. Respects the 30/min limit with a steady interval.
async function pollJob(jobId, { timeoutMs = 240000, intervalMs = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, intervalMs));
    const { body } = await getJSON(`/agent/jobs/${jobId}`);
    const st = body?.status;
    if (st === 'complete' || st === 'completed' || st === 'failed') return body;
  }
  return { status: 'timeout', jobId };
}

// Route one task. mode: 'telegraph' (default) uses specialists; 'baseline' forbids them (A/B control).
export async function route(task, { mode = 'telegraph', maxSpendUsd = 0.9, conversationId } = {}) {
  const message =
    mode === 'baseline'
      ? `Answer from your own general knowledge only. Do NOT use any specialist provider, miner, or paid lookup, and do not spend. If you are not certain, say so.\n\nQuestion: ${task}`
      : task;
  const payload = { message, stream: false, maxSpendUsd };
  if (conversationId) payload.conversationId = conversationId;

  const t0 = Date.now();
  const r = await fetch(BASE + '/agent/chat', { method: 'POST', headers: H, body: JSON.stringify(payload) });
  let body;
  if (r.status === 504 || r.status === 202) {
    // Edge timed out or async accepted; the job keeps running server-side.
    const partial = await r.json().catch(() => null);
    // The job record keys its id as `id` (chat/spend) - accept jobId too for forward-compat.
    let jobId = partial?.jobId || partial?.id;
    if (!jobId) {
      // Recover the running job id from recent spend (jobs[].id, newest first).
      const sp = (await getJSON('/agent/spend')).body;
      const running = (sp?.jobs || []).find(
        (j) => j.status === 'running' || j.status === 'waiting_authorization' || j.status === 'pending',
      );
      jobId = running?.id || running?.jobId;
    }
    body = jobId ? await pollJob(jobId) : { status: 'failed', answer: `edge ${r.status}, no jobId` };
  } else {
    body = await r.json().catch(async () => ({ status: 'failed', answer: (await r.text()).slice(0, 200) }));
  }
  const ms = Date.now() - t0;
  const sources = body?.sources || [];
  return {
    mode,
    task,
    status: body?.status,
    answer: body?.answer || '',
    costUsd: body?.costUsd ?? null,
    sourced: sources.length > 0,
    sources: sources.map((s) => ({
      intent: s.intent,
      miner: s.miner?.slug,
      minerName: s.miner?.name,
      rank: s.miner?.rank,
      delivery: s.delivery,
      receiptHash: s.receiptHash,
    })),
    conversationId: body?.conversationId,
    jobId: body?.jobId,
    ms,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const baseline = args[0] === '--baseline';
  const task = (baseline ? args.slice(1) : args).join(' ').trim();
  if (!task) {
    console.error('usage: node route.mjs [--baseline] "<task>"');
    process.exit(1);
  }
  const bal = await escrowBalance();
  console.error(`escrow: effective=$${bal?.effectiveBalance} debt=$${bal?.agentDebt}`);
  const out = await route(task, { mode: baseline ? 'baseline' : 'telegraph' });
  console.log(JSON.stringify(out, null, 2));
}
