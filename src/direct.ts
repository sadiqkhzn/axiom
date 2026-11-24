// General-purpose Telegraph Mind - DIRECT-BY-ID path.
//
// The rank-based router (/agent/chat) hangs during the platform's ranking rollover. This path does what
// the Gold Rush teams do: buy from a named specialist by miner id via /engine/v1/ask/{id}, which does NOT
// depend on rankings and returns a verifiable receipt + signal hash. One integration, every intent, works
// today. A plain-language task is classified to an intent, the intent maps to a known specialist id, and
// the miner is paid directly through the spend-capped engine client.
//
// Key is read from the repo-root .env (EVM_PRIVATE_KEY). It is never logged.
//
// Usage:  node direct.ts "Is 'Vladimir Putin' on a sanctions list?"
//         node direct.ts --intent SANCTIONS_SCREENING_MATCH_GENERAL "Acme Bakery Pty Ltd"

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

// Our live specialists by intent, with the endpoint each serves. Direct-by-id, so no ranking needed.
type Spec = { minerId: string; method: 'GET' | 'POST'; endpoint: string; param: string; label: string };
const SPECIALISTS: Record<string, Spec> = {
  // endpoint + param are each miner's CANONICAL intent_mapping values (not the public alias), so the node's
  // direct-by-id buy matches what the miner serves.
  SANCTIONS_SCREENING_MATCH_GENERAL: { minerId: '731002', method: 'GET', endpoint: '/screen',   param: 'name', label: 'Sanctions screen' },
  B2B_IDENTITY_ENRICHMENT_GENERAL:   { minerId: '731005', method: 'GET', endpoint: '/enrich',   param: 'name', label: 'B2B identity' },
  URL_SAFE_GENERAL:                  { minerId: '731006', method: 'GET', endpoint: '/url-scan', param: 'url',  label: 'URL/TLS safety' },
};

// Lightweight intent classification from the plain-language task. Deterministic and transparent - no LLM guess.
function classify(task: string): keyof typeof SPECIALISTS | null {
  const t = task.toLowerCase();
  if (/\b(sanction|ofac|sdn|watch\s?list|blocklist|embargo)/.test(t)) return 'SANCTIONS_SCREENING_MATCH_GENERAL';
  if (/\bhttps?:\/\/|\b(tls|ssl|certificate|domain safe|url safe|is .* safe)\b/.test(t)) return 'URL_SAFE_GENERAL';
  if (/\b(company|entity|lei|legal name|jurisdiction|incorporat|who is .*(ltd|inc|corp|pty)|enrich)\b/.test(t)) return 'B2B_IDENTITY_ENRICHMENT_GENERAL';
  return null;
}

// Framing words and acronyms that are never the subject (OFAC, LEI, SDN, "company", "exact", ...).
const SUBJECT_STOP = new Set(
  'ofac sdn ofsi un eu uk us usa lei tls ssl url ssn vat iban swift bic treasury sanction sanctions sanctioned watchlist watch blocklist blacklist embargo listed company companies entity entities business firm legal jurisdiction incorporated registered exact government a an the is are was were be been do does did can could would should it on in of to for by with from against per and or not any all please check screen screened scan lookup look resolve enrich verify about who what which whose when where why how tell me give show list lists name named'.split(
      /\s+/,
    ),
);
const stripEdges = (w: string) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

// Reduce the question to the exact subject the miner endpoint expects: a url, a quoted phrase, or the
// entity itself (the longest run of proper-noun tokens, skipping framing words). Robust to phrasing.
function subjectOf(task: string, intent: keyof typeof SPECIALISTS): string {
  // URL safety: take the http(s) token or a bare domain verbatim, never the framing words.
  if (intent === 'URL_SAFE_GENERAL') {
    const u = task.match(/\bhttps?:\/\/\S+/i);
    if (u) return u[0].replace(/[).,?!"'”’]+$/, '');
    const d = task.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)/i);
    if (d) return d[1].replace(/[).,?!"'”’]+$/, '');
  }
  // A quoted phrase is the strongest signal.
  const quoted = task.match(/["'“‘]([^"'”’]{2,})["'”’]/);
  if (quoted) return quoted[1].trim();
  // The entity: the longest consecutive run of proper-noun tokens that are not framing words.
  const tokens = task.replace(/[?.!,;:]+/g, ' ').split(/\s+/).filter(Boolean);
  const isEntity = (w: string) => {
    const bare = stripEdges(w);
    if (!bare || SUBJECT_STOP.has(bare.toLowerCase())) return false;
    return /^[A-Z]/.test(bare) || /\d/.test(bare);
  };
  let best: string[] = [];
  let cur: string[] = [];
  for (const w of tokens) {
    if (isEntity(w)) {
      cur.push(stripEdges(w));
      if (cur.length > best.length) best = cur.slice();
    } else cur = [];
  }
  if (best.length) return best.join(' ');
  // Fallback for an all-lowercase subject: strip framing words down to the bare name.
  return (
    task
      .replace(/^[^A-Za-z0-9]*/, '')
      .replace(
        /\b(please|is|are|was|does|do|did|check|screen|scan|look\s*up|resolve|enrich|verify|tell me about|who\s+is|what\s+is|the\s+company|the\s+entity|company|entity|the|on|in|of|to|for|against|per|any|a|an|exact|lei|ofac|sdn|ofsi|sanctions?|sanctioned|watch\s*list|blocklist|embargo|government|list|name)\b/gi,
        ' ',
      )
      .replace(/[?.]+\s*$/, '')
      .replace(/["'“”‘’]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || task.trim()
  );
}

function loadKey(): string {
  if (process.env.EVM_PRIVATE_KEY) return process.env.EVM_PRIVATE_KEY;
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  const m = readFileSync(envPath, 'utf8').match(/^EVM_PRIVATE_KEY=(.+)$/m);
  if (!m) throw new Error('EVM_PRIVATE_KEY not found in .env (copy .env.example to .env and set it)');
  return m[1].trim();
}

export type MindResult = {
  task: string;
  intent: string | null;
  specialist: string | null;
  minerId: string | null;
  answer: unknown;
  costUsd: number | null;
  receiptHash: string | null;
  signalHash: string | null;
  verified: boolean | null;
  ms: number;
  error?: string;
};

export async function runDirect(task: string, forcedIntent?: string): Promise<MindResult> {
  const t0 = Date.now();
  const intent = (forcedIntent as keyof typeof SPECIALISTS) || classify(task);
  const base: MindResult = { task, intent: intent ?? null, specialist: null, minerId: null, answer: null, costUsd: null, receiptHash: null, signalHash: null, verified: null, ms: 0 };
  if (!intent || !SPECIALISTS[intent]) return { ...base, ms: Date.now() - t0, error: 'no specialist mapped for this task' };

  const spec = SPECIALISTS[intent];
  // Spend caps: $0.05 per call, $0.50/day. Testnet USDC only (enforced in wallet.ts + PaymentGuard).
  const limiter = new SpendLimiter({ perCallUusdc: 50_000, dailyUusdc: 500_000, store: new MemorySpendStore() });
  const guard = new PaymentGuard(limiter);
  const wallet = payingFetchFromKey(loadKey(), guard);
  const client = new TelegraphClient({ payingFetch: wallet.fetch, guard, limiter });

  try {
    const buy: Purchase = await client.askMiner(spec.minerId, spec.method, spec.endpoint, { [spec.param]: subjectOf(task, intent) });
    let verified: boolean | null = null;
    if (buy.signalHash) {
      const chk = await checkPurchase(client, buy).catch(() => null);
      verified = chk ? chk.published && (chk.nodeVerified ?? false) && (chk.sameAnswer ?? false) : null;
    }
    return {
      task, intent, specialist: spec.label, minerId: buy.minerId || spec.minerId,
      answer: buy.result, costUsd: buy.costUsd, receiptHash: buy.receipt?.receipt_hash ?? null,
      signalHash: buy.signalHash, verified, ms: Date.now() - t0,
    };
  } catch (err) {
    return { ...base, specialist: spec.label, minerId: spec.minerId, ms: Date.now() - t0, error: (err as Error).message };
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let forced: string | undefined;
  const ix = args.indexOf('--intent');
  if (ix >= 0) { forced = args[ix + 1]; args.splice(ix, 2); }
  const task = args.join(' ').trim();
  if (!task) { console.error('usage: node direct.ts [--intent INTENT] "<task>"'); process.exit(1); }
  const out = await runDirect(task, forced);
  console.log(JSON.stringify(out, null, 2));
}
