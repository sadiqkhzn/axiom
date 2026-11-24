// Three-way comparison for the Verified Intelligence Economy use case.
//
// Same institutional question, answered three ways on Telegraph:
//   1. Model on its own          - run separately with `node src/route.mjs --baseline "<task>"`
//   2. Pick a provider from the listing (not by rank) - a low-ranked specialist for the intent
//   3. Axiom: the top-ranked, independently evaluated specialist for the intent
//
// This file runs paths 2 and 3 as real paid purchases by miner id and prints the answer,
// cost, latency and the receipt for each. Usage:
//   node bench/three-way.ts
//
// Key is read from the repo-root .env (EVM_PRIVATE_KEY), same as src/direct.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SpendLimiter, PaymentGuard, TelegraphClient, MemorySpendStore, checkPurchase, type Purchase } from '../src/telegraph.ts';
import { payingFetchFromKey } from '../src/wallet.ts';

function loadKey(): string {
  if (process.env.EVM_PRIVATE_KEY) return process.env.EVM_PRIVATE_KEY;
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  const m = readFileSync(envPath, 'utf8').match(/^EVM_PRIVATE_KEY=(.+)$/m);
  if (!m) throw new Error('EVM_PRIVATE_KEY not found in .env');
  return m[1].trim();
}

type Candidate = { label: string; minerId: string; endpoint: string; param: string; value: string };

async function buy(c: Candidate) {
  const limiter = new SpendLimiter({ perCallUusdc: 50_000, dailyUusdc: 500_000, store: new MemorySpendStore() });
  const guard = new PaymentGuard(limiter);
  const wallet = payingFetchFromKey(loadKey(), guard);
  const client = new TelegraphClient({ payingFetch: wallet.fetch, guard, limiter });
  const t0 = Date.now();
  try {
    const p: Purchase = await client.askMiner(c.minerId, 'GET', c.endpoint, { [c.param]: c.value });
    let verified: boolean | null = null;
    if (p.signalHash) {
      const chk = await checkPurchase(client, p).catch(() => null);
      verified = chk ? chk.published && (chk.nodeVerified ?? false) && (chk.sameAnswer ?? false) : null;
    }
    const r: any = p.result;
    const answer = r?.answer ?? r?.summary ?? JSON.stringify(r)?.slice(0, 200);
    return { label: c.label, minerId: c.minerId, answer, label_field: r?.label ?? null, costUsd: p.costUsd, ms: Date.now() - t0, receiptHash: p.receipt?.receipt_hash ?? null, verified };
  } catch (err) {
    return { label: c.label, minerId: c.minerId, error: (err as Error).message, ms: Date.now() - t0 };
  }
}

async function main() {
  const subject = process.argv[2] ?? 'Rosoboronexport';
  // Sanctions intent. Ranked = top-tier 1.0 specialist (731002). Listing pick = a live but lower-ranked
  // provider an agent might choose from the catalog by its authoritative-sounding name (miner 78021,
  // score about 0.86).
  const candidates: Candidate[] = [
    { label: 'Pick from the listing (unranked)', minerId: '78021', endpoint: '/query', param: 'entity', value: subject },
    { label: 'Axiom, top-ranked specialist', minerId: '731002', endpoint: '/screen', param: 'name', value: subject },
  ];
  const out = [];
  for (const c of candidates) out.push(await buy(c));
  console.log(JSON.stringify({ subject, question: `Is ${subject} on the OFAC sanctions list?`, results: out }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
