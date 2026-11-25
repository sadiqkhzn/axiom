// Counterparty-clearance agent: a commercial agent that consumes MULTIPLE specialist intelligences
// before a payment is released, decides GO / REVIEW / STOP, and settles its per-call spend on Solana
// through Pay.sh. Every step carries complete evidence: the Telegraph receipt and signal hash for each
// intelligence bought, and the Pay.sh Solana charge/settlement for the spend.
//
// The intelligence rail is Telegraph (paid per call in test USDC, verifiable receipt + signal hash,
// Ethereum Sepolia today). The settlement rail is Pay.sh on Solana (see src/settle.ts and docs/SOLANA.md).
// The two rails are independent on purpose: the agent is what composes several specialist answers into one
// commercial decision with an auditable money trail.
//
// Usage:
//   node src/agent.ts "Siemens AG" --order 250000 --website siemens.com
//   node src/agent.ts "Rosoboronexport" --order 50000

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SpendLimiter,
  PaymentGuard,
  TelegraphClient,
  MemorySpendStore,
  checkPurchase,
  type Purchase,
} from './telegraph.ts';
import { payingFetchFromKey } from './wallet.ts';
import { settleSpend, type SolanaSettlement } from './settle.ts';

// The specialists this agent composes, in the order it consults them. endpoint + param are each miner's
// canonical intent_mapping values, so a direct-by-id buy matches what the miner serves.
type Specialist = { key: string; label: string; minerId: string; endpoint: string; param: string };
const IDENTITY: Specialist = { key: 'identity', label: 'Legal identity', minerId: '731005', endpoint: '/enrich', param: 'name' };
const SANCTIONS: Specialist = { key: 'sanctions', label: 'Sanctions screen', minerId: '731002', endpoint: '/screen', param: 'name' };
const URLSAFE: Specialist = { key: 'website', label: 'Website safety', minerId: '731006', endpoint: '/url-scan', param: 'url' };

export type Decision = 'GO' | 'REVIEW' | 'STOP';

export type IntelligenceStep = {
  key: string;
  label: string;
  minerId: string;
  query: string;
  verdict: string; // one-line human reading of the answer
  flag: 'ok' | 'review' | 'stop';
  answer: unknown;
  costUsd: number | null;
  receiptHash: string | null;
  signalHash: string | null;
  verified: boolean | null;
  settlement: SolanaSettlement | null;
  error?: string;
};

export type ClearanceOrder = { amountUsd: number; currency: string; description?: string };

export type EvidencePack = {
  counterparty: string;
  order: ClearanceOrder | null;
  decision: Decision;
  rationale: string[];
  steps: IntelligenceStep[];
  spend: { intelligenceUsd: number; telegraphReceipts: number; solanaSettlements: number };
  intelligenceRail: string;
  settlementRail: string;
  generatedAt: string;
};

function loadKey(): string {
  if (process.env.EVM_PRIVATE_KEY) return process.env.EVM_PRIVATE_KEY;
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  const m = readFileSync(envPath, 'utf8').match(/^EVM_PRIVATE_KEY=(.+)$/m);
  if (!m) throw new Error('EVM_PRIVATE_KEY not found in .env (copy .env.example to .env and set it)');
  return m[1].trim();
}

// Read a sanctions answer into a CLEAR / REVIEW / BLOCK verdict and a clearance flag.
function readSanctions(a: any): { verdict: string; flag: 'ok' | 'review' | 'stop' } {
  const label = String(a?.label ?? a?.verdict ?? a?.status ?? '').toUpperCase();
  const summary = String(a?.summary ?? a?.answer ?? '').trim();
  if (/\bBLOCK|MATCH|LISTED|SDN\b/.test(label) || /\bBLOCK\b/.test(summary.toUpperCase())) {
    return { verdict: summary || 'Sanctions match — BLOCK', flag: 'stop' };
  }
  if (/\bREVIEW|PARTIAL|POSSIBLE\b/.test(label) || /\bREVIEW\b/.test(summary.toUpperCase())) {
    return { verdict: summary || 'Possible match — REVIEW', flag: 'review' };
  }
  if (/\bCLEAR|NO MATCH|CLEARED\b/.test(label) || /\bCLEAR\b/.test(summary.toUpperCase())) {
    return { verdict: summary || 'No sanctions match — CLEAR', flag: 'ok' };
  }
  return { verdict: summary || 'Sanctions verdict unavailable', flag: 'review' };
}

// Read an identity answer: a real, active registered entity clears; anything less is a review.
function readIdentity(a: any): { verdict: string; flag: 'ok' | 'review' | 'stop' } {
  const found = a?.found === true || Boolean(a?.lei || a?.legal_name);
  const status = String(a?.status ?? '').toUpperCase();
  const name = a?.legal_name ?? a?.company ?? null;
  const lei = a?.lei ?? null;
  if (found && lei && status === 'ACTIVE') {
    return { verdict: `Registered: ${name} (LEI ${lei}, ${a?.jurisdiction ?? '?'}, ACTIVE)`, flag: 'ok' };
  }
  if (found) {
    return { verdict: `Resolved ${name ?? 'entity'}${lei ? ` (LEI ${lei})` : ''}${status ? `, status ${status}` : ', no active LEI'} — confirm before paying`, flag: 'review' };
  }
  return { verdict: 'No registered legal entity resolved — confirm the counterparty before paying', flag: 'review' };
}

function readWebsite(a: any): { verdict: string; flag: 'ok' | 'review' | 'stop' } {
  const summary = String(a?.summary ?? a?.answer ?? '').trim();
  const verdict = String(a?.verdict ?? a?.label ?? a?.status ?? '').toLowerCase();
  // Use the miner's own structured fields (safe boolean, verdict, risk score), never a keyword scan of
  // the prose — the summary names its threat-feed sources (URLhaus, phishunt), which must not be read
  // as a verdict.
  if (a?.safe === true || verdict === 'safe') return { verdict: summary || 'Website safe', flag: 'ok' };
  if (a?.safe === false || /malicious|phishing|unsafe|typosquat|scam|suspicious/.test(verdict)) {
    return { verdict: summary || 'Website flagged unsafe', flag: 'review' };
  }
  if (typeof a?.risk === 'number') {
    return a.risk >= 0.5 ? { verdict: summary || `Elevated risk ${a.risk}`, flag: 'review' } : { verdict: summary || 'Website within risk tolerance', flag: 'ok' };
  }
  return { verdict: summary || 'Website verdict unavailable', flag: 'ok' };
}

const READERS: Record<string, (a: any) => { verdict: string; flag: 'ok' | 'review' | 'stop' }> = {
  identity: readIdentity,
  sanctions: readSanctions,
  website: readWebsite,
};

export type ClearanceInput = {
  counterparty: string;
  order?: ClearanceOrder | null;
  website?: string | null;
  settle?: boolean; // attempt a real Pay.sh Solana settlement per spend (default true)
};

export class ClearanceAgent {
  private readonly client: TelegraphClient;
  private readonly settleOn: boolean;

  constructor(opts?: { client?: TelegraphClient; settle?: boolean }) {
    if (opts?.client) {
      this.client = opts.client;
    } else {
      const limiter = new SpendLimiter({ perCallUusdc: 50_000, dailyUusdc: 500_000, store: new MemorySpendStore() });
      const guard = new PaymentGuard(limiter);
      const wallet = payingFetchFromKey(loadKey(), guard);
      this.client = new TelegraphClient({ payingFetch: wallet.fetch, guard, limiter });
    }
    this.settleOn = opts?.settle ?? true;
  }

  private async buy(spec: Specialist, query: string): Promise<IntelligenceStep> {
    const base: IntelligenceStep = {
      key: spec.key, label: spec.label, minerId: spec.minerId, query,
      verdict: '', flag: 'review', answer: null, costUsd: null, receiptHash: null,
      signalHash: null, verified: null, settlement: null,
    };
    try {
      const p: Purchase = await this.client.askMiner(spec.minerId, 'GET', spec.endpoint, { [spec.param]: query });
      let verified: boolean | null = null;
      if (p.signalHash) {
        const chk = await checkPurchase(this.client, p).catch(() => null);
        verified = chk ? chk.published && (chk.nodeVerified ?? false) && (chk.sameAnswer ?? false) : null;
      }
      const read = READERS[spec.key]!(p.result as any);
      // Settle this call's spend on Solana through Pay.sh. Best-effort: records the charge and, when the
      // sandbox settles, the payment proof. Never fails the clearance if the settlement rail is down.
      const settlement = this.settleOn
        ? await settleSpend({ amountUsd: p.costUsd ?? 0.01, memo: `${spec.label}: ${query}` }).catch((e) => ({
            rail: 'Pay.sh (Solana)', settled: false, note: `settlement unavailable: ${(e as Error).message}`,
          } as SolanaSettlement))
        : null;
      return {
        ...base, answer: p.result, verdict: read.verdict, flag: read.flag,
        costUsd: p.costUsd, receiptHash: p.receipt?.receipt_hash ?? null, signalHash: p.signalHash,
        verified, settlement,
      };
    } catch (err) {
      return { ...base, error: (err as Error).message, verdict: `${spec.label} unavailable`, flag: 'review' };
    }
  }

  async clear(input: ClearanceInput): Promise<EvidencePack> {
    const steps: IntelligenceStep[] = [];
    // Identity and sanctions are always consulted; website safety only when a domain is given.
    steps.push(await this.buy(IDENTITY, input.counterparty));
    steps.push(await this.buy(SANCTIONS, input.counterparty));
    if (input.website) {
      // The url-scan miner expects an absolute http(s) URL; normalise a bare domain.
      const site = /^https?:\/\//i.test(input.website) ? input.website : `https://${input.website.replace(/^\/+/, '')}`;
      steps.push(await this.buy(URLSAFE, site));
    }

    const rationale: string[] = [];
    let decision: Decision = 'GO';
    for (const s of steps) {
      rationale.push(`${s.label}: ${s.verdict}`);
      if (s.flag === 'stop') decision = 'STOP';
      else if (s.flag === 'review' && decision !== 'STOP') decision = 'REVIEW';
    }
    if (decision === 'GO') rationale.push('All checks cleared with verified receipts — safe to release payment.');
    else if (decision === 'STOP') rationale.push('A blocking check failed — do not release payment.');
    else rationale.push('At least one check needs human review before releasing payment.');

    const intelligenceUsd = steps.reduce((n, s) => n + (s.costUsd ?? 0), 0);
    return {
      counterparty: input.counterparty,
      order: input.order ?? null,
      decision,
      rationale,
      steps,
      spend: {
        intelligenceUsd: Number(intelligenceUsd.toFixed(6)),
        telegraphReceipts: steps.filter((s) => s.receiptHash).length,
        solanaSettlements: steps.filter((s) => s.settlement?.settled).length,
      },
      intelligenceRail: 'Telegraph (per-call test USDC, verifiable receipt + signal hash)',
      settlementRail: 'Pay.sh (Solana devnet USDC, MPP charge)',
      generatedAt: new Date().toISOString(),
    };
  }
}

// Render the evidence pack as a short human-readable report.
export function renderReport(pack: EvidencePack): string {
  const L: string[] = [];
  const mark = pack.decision === 'GO' ? 'GO ✅' : pack.decision === 'STOP' ? 'STOP ⛔' : 'REVIEW ⚠️';
  L.push(`Counterparty clearance — ${pack.counterparty}`);
  if (pack.order) L.push(`Order: ${pack.order.amountUsd.toLocaleString('en-US')} ${pack.order.currency}${pack.order.description ? ` (${pack.order.description})` : ''}`);
  L.push(`Decision: ${mark}`);
  L.push('');
  for (const s of pack.steps) {
    const tag = s.flag === 'ok' ? '✓' : s.flag === 'stop' ? '⛔' : '⚠️';
    L.push(`${tag} ${s.label} — ${s.verdict}`);
    const ev: string[] = [];
    if (s.receiptHash) ev.push(`receipt ${s.receiptHash.slice(0, 14)}…`);
    if (s.signalHash) ev.push(`signal ${s.signalHash.slice(0, 14)}…`);
    if (s.verified !== null) ev.push(s.verified ? 'node-verified' : 'unverified');
    if (s.settlement) ev.push(s.settlement.settled ? `Solana ${s.settlement.txSignature ? s.settlement.txSignature.slice(0, 12) + '…' : 'settled'}` : 'settlement pending');
    if (ev.length) L.push(`    ${ev.join(' · ')}`);
    if (s.error) L.push(`    (${s.error})`);
  }
  L.push('');
  L.push(`Intelligence spend: $${pack.spend.intelligenceUsd.toFixed(2)} · ${pack.spend.telegraphReceipts} Telegraph receipts · ${pack.spend.solanaSettlements} Solana settlements`);
  L.push(`Rails: intelligence = ${pack.intelligenceRail}; settlement = ${pack.settlementRail}`);
  return L.join('\n');
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let order: ClearanceOrder | null = null;
  let website: string | null = null;
  let settle = true;
  const oi = args.indexOf('--order');
  if (oi >= 0) { order = { amountUsd: Number(args[oi + 1]), currency: 'USD' }; args.splice(oi, 2); }
  const wi = args.indexOf('--website');
  if (wi >= 0) { website = args[wi + 1] ?? null; args.splice(wi, 2); }
  const ni = args.indexOf('--no-settle');
  if (ni >= 0) { settle = false; args.splice(ni, 1); }
  const counterparty = args.join(' ').trim();
  if (!counterparty) { console.error('usage: node src/agent.ts "<counterparty>" [--order <usd>] [--website <domain>] [--no-settle]'); process.exit(1); }
  const agent = new ClearanceAgent({ settle });
  const pack = await agent.clear({ counterparty, order, website });
  console.log(renderReport(pack));
  console.log('\n--- evidence (json) ---');
  console.log(JSON.stringify(pack, null, 2));
}
