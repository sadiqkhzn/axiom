// Reproducible demo of the counterparty-clearance agent: one clean supplier that clears to GO and one
// sanctioned entity that is stopped, each with the full evidence pack. Real paid Telegraph calls.
//
//   node bench/clearance.ts            # both cases, settlement off (fast)
//   node bench/clearance.ts --settle   # also settle each spend on Solana via Pay.sh (needs the `pay` tool)
//
// Key is read from the repo-root .env (EVM_PRIVATE_KEY), same as src/direct.ts.

import { ClearanceAgent, renderReport, type ClearanceInput } from '../src/agent.ts';

const CASES: ClearanceInput[] = [
  { counterparty: 'Siemens AG', order: { amountUsd: 250_000, currency: 'USD', description: 'industrial controllers' }, website: 'siemens.com' },
  { counterparty: 'Rosoboronexport', order: { amountUsd: 50_000, currency: 'USD', description: 'equipment order' } },
];

async function main() {
  const settle = process.argv.includes('--settle');
  const agent = new ClearanceAgent({ settle });
  for (const c of CASES) {
    const pack = await agent.clear(c);
    console.log('\n' + '='.repeat(72));
    console.log(renderReport(pack));
  }
  console.log('\n' + '='.repeat(72));
  console.log('Each line above is backed by a Telegraph receipt + signal hash anyone can re-verify.');
}

main().catch((e) => { console.error(e); process.exit(1); });
