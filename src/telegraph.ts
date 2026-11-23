// Buying intelligence from Telegraph: discover miners, ask (routed or direct), pay per call with x402, keep the
// receipt, and check a purchase against the node's public signal record.
//
// Spending is guarded here, not left to the payment library: every paid call is quoted first (the unpaid request
// returns a free 402 challenge), and the quote must fit the per-call and daily caps before anything is signed.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
// A fetch-compatible function. Inlined so this client stands alone.
export type FetchFn = typeof fetch;

export const BASE_SEPOLIA = 'eip155:84532';
export const ETHEREUM_SEPOLIA = 'eip155:11155111';
// Test networks only: a challenge on any other network, a mainnet included, is never paid.
// The devnode moved its payments from Base Sepolia to Ethereum Sepolia in November 2026; either is accepted.
export const TEST_NETWORKS: readonly string[] = [ETHEREUM_SEPOLIA, BASE_SEPOLIA];
// The only token paid with on each test network: Telegraph's own test USDC on Ethereum Sepolia, Circle's on Base Sepolia.
export const TEST_USDC: Readonly<Record<string, string>> = {
  [ETHEREUM_SEPOLIA]: '0xcc194e1a843B658526D0D5C431f670028582Ae17',
  [BASE_SEPOLIA]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
const isTestUsdc = (network: string, asset: string | undefined): boolean => !!asset && TEST_USDC[network]?.toLowerCase() === asset.toLowerCase();
export const DEFAULT_NODE = 'https://devnode.telegraphprotocol.com';

export type Receipt = {
  receipt_hash: string;
  rail: string;
  payer: string;
  miner: string;
  intent: string;
  amount_uusdc: string;
  epoch_id: number;
  settlement: string;
  chain: string;
  tx_hash: string;
  timestamp: number;
};

export type Purchase = {
  minerId: string;
  minerName: string;
  intent: string | null;
  endpoint: string | null;
  reasoning: string | null;
  result: unknown;
  costUsd: number;
  durationMs: number;
  signalHash: string | null;
  receipt: Receipt | null;
};

export type Quote = { amountUusdc: number; payTo: string; network: string; asset: string };

export type MinerInfo = {
  id: string;
  slug: string;
  name: string;
  supported_intents?: string[];
  activation_status?: string;
  min_price_usdc?: number | string;
  endpoints?: { path: string; method: string; description?: string }[];
};

export class TelegraphError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Where the day's spend is kept. reserve() is the only write and it is atomic: the amount is added only if the day's
// total stays within the cap, so two app instances paying at the same moment cannot both fit under it.
export interface SpendStore {
  reserve(day: string, amount: number, cap: number): Promise<boolean>;
  spent(day: string): Promise<number>;
}

export class MemorySpendStore implements SpendStore {
  private day = '';
  private total = 0;

  private roll(day: string): void {
    if (day !== this.day) {
      this.day = day;
      this.total = 0;
    }
  }

  async reserve(day: string, amount: number, cap: number): Promise<boolean> {
    this.roll(day);
    if (this.total + amount > cap) return false;
    this.total += amount;
    return true;
  }

  async spent(day: string): Promise<number> {
    this.roll(day);
    return this.total;
  }
}

// One process with a disk (local runs, Docker): the day's spend survives restarts. Reads and writes are synchronous,
// so a reservation cannot interleave with another in the same process.
export class FileSpendStore implements SpendStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private read(day: string): number {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { day?: unknown; spent?: unknown };
      return saved.day === day && isAmount(saved.spent) ? saved.spent : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  async reserve(day: string, amount: number, cap: number): Promise<boolean> {
    const total = this.read(day);
    if (total + amount > cap) return false;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ day, spent: total + amount }), { mode: 0o600 });
    renameSync(temp, this.file);
    return true;
  }

  async spent(day: string): Promise<number> {
    return this.read(day);
  }
}

// Caps in micro-USDC (6 decimals): 10_000 = $0.01. Days are UTC. If the store cannot be reached, nothing is paid.
export class SpendLimiter {
  private readonly perCall: number;
  private readonly daily: number;
  private readonly now: () => Date;
  private readonly store: SpendStore;

  constructor(options: { perCallUusdc: number; dailyUusdc: number; now?: () => Date; store?: SpendStore }) {
    this.perCall = options.perCallUusdc;
    this.daily = options.dailyUusdc;
    this.now = options.now ?? (() => new Date());
    this.store = options.store ?? new MemorySpendStore();
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private validate(amount: number): void {
    if (!isAmount(amount)) throw new TelegraphError('BAD_AMOUNT', `refusing to pay a non-numeric or negative amount (${String(amount)})`);
    if (amount > this.perCall) throw new TelegraphError('OVER_PER_CALL_CAP', `quoted ${amount} uUSDC is over the per-call cap of ${this.perCall}`);
  }

  private async fromStore<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw new TelegraphError('SPEND_RECORD_UNAVAILABLE', `the spending record could not be reached, so nothing is paid (${(error as Error).message})`);
    }
  }

  // Before asking to pay: refuses early, but binds nothing. Only reserve() counts money.
  async check(amount: number): Promise<void> {
    this.validate(amount);
    const spent = await this.fromStore(() => this.store.spent(this.today()));
    if (spent + amount > this.daily) throw new TelegraphError('OVER_DAILY_CAP', `quoted ${amount} uUSDC would pass the daily cap of ${this.daily} (spent ${spent})`);
  }

  // Counts the amount against today's cap, or refuses. Called just before a payment is signed.
  async reserve(amount: number): Promise<void> {
    this.validate(amount);
    const reserved = await this.fromStore(() => this.store.reserve(this.today(), amount, this.daily));
    if (!reserved) throw new TelegraphError('OVER_DAILY_CAP', `quoted ${amount} uUSDC would pass the daily cap of ${this.daily}`);
  }

  async spent(): Promise<number> {
    return this.fromStore(() => this.store.spent(this.today()));
  }
}

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// The payment library signs whatever a 402 challenge asks for. The guard binds each signature to the quote this
// client checked against its caps: same amount, payee, network, asset and scheme, or nothing is signed. Authorising a
// payment counts it at once, whatever the paid call returns afterwards.
export type PaymentTerms = { scheme: string; network: string; amount: string; payTo: string; asset: string };

export class PaymentGuard {
  private readonly limiter: SpendLimiter;
  private expected: Quote | null = null;

  constructor(limiter: SpendLimiter) {
    this.limiter = limiter;
  }

  expect(quote: Quote): void {
    this.expected = quote;
  }

  clear(): void {
    this.expected = null;
  }

  // Returns why the payment must not be signed, or null after counting it against the caps.
  async authorize(terms: PaymentTerms): Promise<string | null> {
    const quote = this.expected;
    if (!quote) return 'no purchase is in progress';
    if (terms.scheme !== 'exact' || !TEST_NETWORKS.includes(terms.network)) return `only exact payments on ${TEST_NETWORKS.join(' or ')} are allowed`;
    if (terms.network !== quote.network) return 'network differs from the quote';
    if (!/^\d+$/.test(terms.amount) || Number(terms.amount) !== quote.amountUusdc) return `amount ${terms.amount} differs from the quoted ${quote.amountUusdc}`;
    if (terms.payTo.toLowerCase() !== quote.payTo.toLowerCase()) return 'pay-to address differs from the quote';
    if (terms.asset.toLowerCase() !== quote.asset.toLowerCase()) return 'asset differs from the quote';
    try {
      await this.limiter.reserve(quote.amountUusdc);
    } catch (error) {
      return (error as Error).message;
    }
    return null;
  }
}

export function decodeBase64Json<T>(header: string | null): T | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}

type Challenge = { accepts?: { scheme: string; network: string; amount: string; payTo: string; asset?: string }[] };

export function quoteFromChallenge(header: string | null): Quote | null {
  const option = decodeBase64Json<Challenge>(header)?.accepts?.find((a) => a.scheme === 'exact' && isTestUsdc(a.network, a.asset));
  if (!option || !/^\d+$/.test(String(option.amount)) || !option.asset) return null;
  return { amountUusdc: Number(option.amount), payTo: option.payTo, network: option.network, asset: option.asset };
}

type AskBody = {
  miner_id?: string; miner_name?: string; endpoint?: string; result?: unknown; cost_usd?: number; duration_ms?: number;
  reasoning?: string; intent?: string; signal_hash?: string; error?: string; warnings?: string[];
};

const PAID_TIMEOUT_MS = 45_000;
const PAYMENT_RETRIES = 2;

export class TelegraphClient {
  private readonly node: string;
  private readonly fetchFn: FetchFn;
  private readonly payingFetch: FetchFn | null;
  private readonly limiter: SpendLimiter;
  private readonly guard: PaymentGuard | null;
  private readonly sleep: (ms: number) => Promise<void>;
  // One payment at a time from this wallet: concurrent x402 payments collide on the nonce.
  private queue: Promise<unknown> = Promise.resolve();

  // A paying fetch must come with the PaymentGuard its signer consults (see wallet.ts), or nothing binds what it signs.
  constructor(options: { nodeUrl?: string; fetchFn?: FetchFn; payingFetch?: FetchFn | null; guard?: PaymentGuard; limiter: SpendLimiter; sleep?: (ms: number) => Promise<void> }) {
    if (options.payingFetch && !options.guard) throw new TelegraphError('NO_GUARD', 'a paying fetch needs the PaymentGuard its signer was built with');
    this.guard = options.guard ?? null;
    this.node = (options.nodeUrl ?? DEFAULT_NODE).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.payingFetch = options.payingFetch ?? null;
    this.limiter = options.limiter;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${this.node}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new TelegraphError(`HTTP_${response.status}`, `Telegraph ${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  async miners(intent: string, limit = 50): Promise<MinerInfo[]> {
    const body = await this.getJson<MinerInfo[] | { miners: MinerInfo[] }>(`/api/miners?intent=${encodeURIComponent(intent)}&limit=${limit}`);
    return Array.isArray(body) ? body : body.miners;
  }

  async intents(): Promise<{ intent_id: string; description?: string; miner_count?: number }[]> {
    return (await this.getJson<{ intents: { intent_id: string; description?: string; miner_count?: number }[] }>('/engine/v1/intents')).intents;
  }

  // The unpaid request costs nothing and returns the price.
  async quote(path: string, body: unknown): Promise<Quote> {
    const response = await this.fetchFn(`${this.node}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 402) throw new TelegraphError('NO_CHALLENGE', `expected a 402 price quote from ${path}, got HTTP ${response.status}`);
    const quote = quoteFromChallenge(response.headers.get('payment-required'));
    if (!quote) throw new TelegraphError('NO_TEST_NETWORK_OPTION', `the challenge from ${path} offers no exact test-USDC payment on a supported test network (${TEST_NETWORKS.join(', ')})`);
    return quote;
  }

  ask(query: string, context?: Record<string, unknown>): Promise<Purchase> {
    return this.buy('/engine/v1/ask', context ? { query, context } : { query });
  }

  // Names the intent instead of describing it in words, so the node cannot route the request to another intent family.
  askIntent(intent: string, params: Record<string, unknown>): Promise<Purchase> {
    return this.buy('/engine/v1/ask', { intent, params });
  }

  askMiner(minerId: string, method: 'GET' | 'POST', endpoint: string, payload: Record<string, unknown>): Promise<Purchase> {
    return this.buy(`/engine/v1/ask/${encodeURIComponent(minerId)}`, { method, endpoint, payload });
  }

  private buy(path: string, body: unknown): Promise<Purchase> {
    const run = this.queue.then(() => this.buyNow(path, body));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async buyNow(path: string, body: unknown): Promise<Purchase> {
    if (!this.payingFetch) throw new TelegraphError('NO_WALLET', 'no paying wallet is configured (set the burner wallet key)');
    const quote = await this.quote(path, body);
    await this.limiter.check(quote.amountUusdc);

    const started = Date.now();
    const deadline = AbortSignal.timeout(PAID_TIMEOUT_MS);
    let response: Response | null = null;
    this.guard!.expect(quote);
    try {
      for (let attempt = 0; attempt <= PAYMENT_RETRIES; attempt++) {
        response = await this.payingFetch(`${this.node}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: deadline,
        });
        // A bare 402 after signing is a rejected settlement (usually a nonce race), not a decline: retry with a fresh one.
        // Each retry signs again, so the guard re-checks the caps and counts it.
        if (response.status !== 402 || attempt === PAYMENT_RETRIES) break;
        await this.sleep(500 * (attempt + 1));
      }
    } catch (error) {
      if (error instanceof TelegraphError) throw error;
      throw new TelegraphError('PAYMENT_FAILED', `payment not completed: ${(error as Error).message}`);
    } finally {
      this.guard!.clear();
    }

    const data = (await response!.json().catch(() => null)) as AskBody | null;
    if (response!.status === 402) throw new TelegraphError('PAYMENT_NOT_ACCEPTED', 'payment was not accepted after retries');
    // 422: the node predicts the call will fail and charged nothing. The caller decides whether to resend.
    if (response!.status === 422) throw new TelegraphError('PREDICTED_TO_FAIL', data?.error ?? 'request is predicted to fail', data);
    if (!response!.ok || !data) throw new TelegraphError(`HTTP_${response!.status}`, data?.error ?? `Telegraph answered HTTP ${response!.status}`, data);

    // Spend was already counted when each payment was authorised, just before it was signed.
    const receipt = decodeBase64Json<Receipt>(response!.headers.get('x-telegraph-receipt'));
    const signalHash = data.signal_hash ?? null;
    return {
      minerId: data.miner_id ?? '',
      minerName: data.miner_name ?? '',
      intent: data.intent ?? null,
      endpoint: data.endpoint ?? null,
      reasoning: data.reasoning ?? null,
      result: (signalHash ? await this.recordedAnswer(signalHash) : undefined) ?? data.result ?? null,
      costUsd: data.cost_usd ?? quote.amountUusdc / 1e6,
      durationMs: data.duration_ms ?? Date.now() - started,
      signalHash,
      receipt,
    };
  }

  // The answer in the paid reply is a shortened copy (some fields only, an empty list sent as null). The full answer
  // the miner returned is what the node records under the signal hash, and what checkPurchase compares a pack against,
  // so that is the one kept. The lookup is free; if the record is not there yet, the reply's copy is kept instead.
  private async recordedAnswer(signalHash: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = await this.signal(signalHash).catch(() => null);
      if (record?.signal_hash === signalHash && record.payload && 'response' in record.payload) return record.payload.response;
      if (attempt === 0) await this.sleep(1_000);
    }
    return undefined;
  }

  async signal(hash: string): Promise<SignalRecord | null> {
    const response = await this.fetchFn(`${this.node}/engine/v1/signal/${encodeURIComponent(hash)}`, { signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new TelegraphError(`HTTP_${response.status}`, `signal lookup: HTTP ${response.status}`);
    return (await response.json()) as SignalRecord;
  }
}

export type SignalRecord = {
  signal_hash: string;
  kind: string;
  signal: { miner_slug?: string; subnet_id?: string; intent_id?: string; tx_hash?: string; wallet_address?: string; created_at?: string };
  payload: { request?: unknown; response?: unknown; miner_slug?: string; subnet_id?: string; intent_id?: string; timestamp?: string };
  verification?: { algorithm?: string; commitment?: string; verified?: boolean };
};

export type PurchaseCheck = {
  signalHash: string;
  published: boolean; // the node serves a public record under this hash
  nodeVerified: boolean | null; // the node's own hash check of that record
  sameAnswer: boolean | null; // the recorded response equals the answer we were given
  sameMiner: boolean | null;
  record: SignalRecord | null;
};

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// Anyone can run this check later from the purchase alone: it needs no wallet and no trust in our own records.
export async function checkPurchase(client: Pick<TelegraphClient, 'signal'>, purchase: Pick<Purchase, 'signalHash' | 'result' | 'minerId'>): Promise<PurchaseCheck> {
  if (!purchase.signalHash) throw new TelegraphError('NO_SIGNAL', 'this purchase has no signal hash to check');
  const record = await client.signal(purchase.signalHash);
  if (!record) return { signalHash: purchase.signalHash, published: false, nodeVerified: null, sameAnswer: null, sameMiner: null, record: null };
  return {
    signalHash: purchase.signalHash,
    published: record.signal_hash === purchase.signalHash,
    nodeVerified: record.verification?.verified ?? null,
    sameAnswer: 'response' in record.payload ? sameJson(record.payload.response, purchase.result) : null,
    sameMiner: record.payload.subnet_id ? record.payload.subnet_id === purchase.minerId : null,
    record,
  };
}
