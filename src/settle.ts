// Pay.sh (Solana) settlement for the clearance agent.
//
// Each specialist call the agent makes is a spend. This module settles that spend on Solana through
// Pay.sh: it reads the live Pay.sh charge (the real payment terms — network, USDC mint, amount,
// recipient, fee payer) via src/paysh.ts, and can execute the settlement through the official `pay`
// tool. It is best-effort: when execution is off or the wallet is unavailable it still returns the
// signed charge terms and says settlement is pending, so a clearance is never blocked by the rail.
//
// SAFETY — this module never spends real money. Execution is OFF by default (it only reads the charge
// terms). The only networks it will ever settle on are the local sandbox and Solana devnet, both of
// which use test tokens. Before any devnet settlement it looks up the named account's network with
// `pay account list` and ABORTS if that account is on mainnet. There is no code path that runs a
// settlement against mainnet or against the default account. See docs/SOLANA.md.

import { execFile } from 'node:child_process';
import { quoteCharge, type ChargeSpec } from './paysh.ts';

export type SolanaSettlement = {
  rail: string; // "Pay.sh (Solana)"
  settled: boolean;
  mode: SettleMode;
  chargeUrl?: string;
  network?: string; // CAIP-2 network from the charge
  amountUsd?: number; // the spend settled, from the charge terms
  tokenMint?: string;
  payTo?: string; // recipient Solana address
  feePayer?: boolean;
  account?: string; // the pay account used (devnet only)
  txSignature?: string | null; // Solana signature, when the tool reports one
  gatedContent?: unknown; // the resource returned after payment: proof the 402 cleared
  memo?: string;
  note?: string;
};

export type SettleMode = 'quote' | 'sandbox' | 'devnet';

// The Pay.sh-gated resource used to exercise settlement. Overridable so the same code points at a real
// gated endpoint when one is available.
const DEFAULT_PAYSH_URL = process.env.PAYSH_URL || 'https://debugger.pay.sh/mpp/quote/AAPL';

// Settlement mode, OFF (quote-only) unless explicitly opted in. 'sandbox' = local validator (test
// tokens). 'devnet' = Solana devnet with a named, faucet-funded account (test tokens). Mainnet is never
// a valid mode here.
function configuredMode(): SettleMode {
  const m = (process.env.PAYSH_MODE || 'quote').toLowerCase();
  return m === 'sandbox' || m === 'devnet' ? m : 'quote';
}

let payToolPath: string | null | undefined;
function findPayTool(): Promise<string | null> {
  if (payToolPath !== undefined) return Promise.resolve(payToolPath);
  return new Promise((resolve) => {
    execFile('sh', ['-lc', 'command -v pay || true'], { timeout: 5_000 }, (_e, stdout) => {
      payToolPath = stdout.trim() || null;
      resolve(payToolPath);
    });
  });
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}\n${stderr}` });
    });
  });
}

// Resolve which Solana network a named pay account belongs to, by parsing `pay account list` (which
// groups accounts under "localnet:" / "devnet:" / "mainnet:" headers). Returns null if not found.
async function accountNetwork(account: string): Promise<string | null> {
  const { out } = await run('pay', ['account', 'list'], 10_000);
  // Strip ANSI, then walk lines tracking the current network header.
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  let net: string | null = null;
  for (const raw of plain.split('\n')) {
    const header = raw.match(/^([a-z]+):\s*$/i);
    if (header) { net = header[1]!.toLowerCase(); continue; }
    if (net && new RegExp(`\\b${account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(raw)) return net;
  }
  return null;
}

const SAFE_NETWORKS = new Set(['localnet', 'devnet', 'testnet']);

function captureSignature(out: string): string | null {
  const sig = out.replace(/\x1b\[[0-9;]*m/g, '').match(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/);
  return sig ? sig[0]! : null;
}

function captureContent(out: string): unknown {
  const m = out.match(/\{[\s\S]*\}/g);
  if (!m) return null;
  try { return JSON.parse(m[m.length - 1]!); } catch { return null; }
}

export async function settleSpend(opts: { amountUsd: number; memo?: string; url?: string }): Promise<SolanaSettlement> {
  const url = opts.url || DEFAULT_PAYSH_URL;
  const mode = configuredMode();
  const base: SolanaSettlement = { rail: 'Pay.sh (Solana)', settled: false, mode, chargeUrl: url, amountUsd: opts.amountUsd, memo: opts.memo };

  // 1) Read the live Pay.sh charge: the real Solana payment terms for this spend. Dependency-free, free.
  try {
    const charge: ChargeSpec = await quoteCharge(url);
    base.network = charge.caip2Network;
    base.tokenMint = charge.tokenMint;
    base.payTo = charge.payTo;
    base.feePayer = charge.methodDetails.feePayer;
  } catch (e) {
    base.note = `could not read Pay.sh charge: ${(e as Error).message}`;
    return base;
  }

  if (mode === 'quote') {
    base.note = 'charge terms read; settlement execution off (set PAYSH_MODE=sandbox|devnet to execute test-token settlement)';
    return base;
  }

  const tool = await findPayTool();
  if (!tool) {
    base.note = 'charge terms read; `pay` tool not installed, settlement not executed';
    return base;
  }

  // 2a) Sandbox: local validator, test tokens, no real money.
  if (mode === 'sandbox') {
    const { ok, out } = await run('pay', ['--sandbox', 'fetch', url], 30_000);
    if (!ok && captureContent(out) == null) { base.note = `sandbox settlement unavailable (${out.trim().slice(0, 160)})`; return base; }
    return { ...base, settled: true, gatedContent: captureContent(out), txSignature: captureSignature(out) };
  }

  // 2b) Devnet: a named, faucet-funded account. Hard guard — never settle with a mainnet account or the
  // default account, so no code path can spend real money.
  const account = process.env.PAYSH_ACCOUNT;
  if (!account) { base.note = 'devnet mode needs PAYSH_ACCOUNT=<devnet account name>; settlement not executed'; return base; }
  const net = await accountNetwork(account);
  if (!net) { base.note = `account "${account}" not found in pay account list; settlement not executed`; return base; }
  if (!SAFE_NETWORKS.has(net)) {
    base.account = account;
    base.note = `REFUSED: account "${account}" is on ${net}, not a test network; no real-money settlement is ever executed`;
    return base;
  }
  const { ok, out } = await run('pay', ['fetch', '--from', account, url], 40_000);
  base.account = account;
  if (!ok && captureContent(out) == null) { base.note = `devnet settlement unavailable (${out.trim().slice(0, 160)})`; return base; }
  return { ...base, settled: true, gatedContent: captureContent(out), txSignature: captureSignature(out) };
}

// CLI: read (and, with PAYSH_MODE set, settle) a single demonstration spend and print the evidence.
if (import.meta.url === `file://${process.argv[1]}`) {
  const amount = Number(process.argv[2] ?? '0.01');
  const s = await settleSpend({ amountUsd: amount, memo: 'manual settle test' });
  console.log(JSON.stringify(s, null, 2));
}
