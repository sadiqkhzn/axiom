// Example requests and responses for miners 731005 (identity) and 731002 (sanctions),
// with the receipt hash and signal hash for each, for integrators (e.g. Countersign).
//
//   node bench/examples.ts
//
// Each call is a real paid purchase by miner id. Key is read from the repo-root .env (EVM_PRIVATE_KEY).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SpendLimiter, PaymentGuard, TelegraphClient, MemorySpendStore, checkPurchase, type Purchase } from '../src/telegraph.ts';
import { payingFetchFromKey } from '../src/wallet.ts';

function loadKey(): string {
  if (process.env.EVM_PRIVATE_KEY) return process.env.EVM_PRIVATE_KEY;
  const m = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8').match(/^EVM_PRIVATE_KEY=(.+)$/m);
  if (!m) throw new Error('EVM_PRIVATE_KEY not found in .env');
  return m[1].trim();
}

type Call = { note: string; minerId: string; endpoint: string; params: Record<string, string> };

async function run(c: Call) {
  const limiter = new SpendLimiter({ perCallUusdc: 50_000, dailyUusdc: 500_000, store: new MemorySpendStore() });
  const guard = new PaymentGuard(limiter);
  const client = new TelegraphClient({ payingFetch: payingFetchFromKey(loadKey(), guard).fetch, guard, limiter });
  const t0 = Date.now();
  try {
    const p: Purchase = await client.askMiner(c.minerId, 'GET', c.endpoint, c.params);
    let verified: boolean | null = null;
    if (p.signalHash) {
      const chk = await checkPurchase(client, p).catch(() => null);
      verified = chk ? chk.published && (chk.nodeVerified ?? false) && (chk.sameAnswer ?? false) : null;
    }
    return {
      note: c.note,
      request: { minerId: c.minerId, method: 'GET', endpoint: c.endpoint, params: c.params },
      response: p.result,
      receipt_hash: p.receipt?.receipt_hash ?? null,
      signal_hash: p.signalHash ?? null,
      verified,
      cost_usd: p.costUsd,
      ms: Date.now() - t0,
    };
  } catch (err) {
    return { note: c.note, request: c, error: (err as Error).message, ms: Date.now() - t0 };
  }
}

const calls: Call[] = [
  { note: 'Identity, resolves: a real active company', minerId: '731005', endpoint: '/enrich', params: { name: 'Citigold Corporation Limited' } },
  { note: 'Sanctions, GO: clean supplier', minerId: '731002', endpoint: '/screen', params: { name: 'Citigold Corporation Limited', type: 'entity' } },
  { note: 'Sanctions, STOP: listed entity', minerId: '731002', endpoint: '/screen', params: { name: 'Rosoboronexport', type: 'entity' } },
  { note: 'Sanctions, REVIEW: a person by name only', minerId: '731002', endpoint: '/screen', params: { name: 'Igor Sechin', type: 'individual' } },
];

const out = [];
for (const c of calls) out.push(await run(c));
console.log(JSON.stringify(out, null, 2));
