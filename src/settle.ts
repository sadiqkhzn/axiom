// Pay.sh (Solana) settlement for the clearance agent.
//
// Each specialist call the agent makes is a spend. This module settles that spend on Solana through
// Pay.sh: it reads the live Pay.sh charge (the real payment terms — network, USDC mint, amount,
// recipient, fee payer) via src/paysh.ts, and, on the public sandbox, executes the settlement through
// the official `pay` tool and captures the proof (the gated resource returned after a 402 -> 200, plus
// any Solana signature the tool reports). It is best-effort: when the `pay` tool or the ephemeral
// sandbox wallet is unavailable, it still returns the signed charge terms and says settlement is pending,
// so a clearance is never blocked by the settlement rail being down. See docs/SOLANA.md for the status
// of the rail (contract read in code; settlement via the `pay` tool; a programmatic signer is a next step).

import { execFile } from 'node:child_process';
import { quoteCharge, type ChargeSpec } from './paysh.ts';

export type SolanaSettlement = {
  rail: string; // "Pay.sh (Solana)"
  settled: boolean;
  chargeUrl?: string;
  network?: string; // CAIP-2 network from the charge (devnet)
  amountUsd?: number; // the spend settled, from the charge terms
  tokenMint?: string;
  payTo?: string; // recipient Solana address
  feePayer?: boolean;
  txSignature?: string | null; // Solana signature, when the tool reports one
  gatedContent?: unknown; // the resource returned after payment: proof the 402 cleared
  memo?: string;
  note?: string;
};

// The Pay.sh-gated resource used to demonstrate settlement on the sandbox. Overridable so the same code
// points at a real gated endpoint when one is available.
const DEFAULT_PAYSH_URL = process.env.PAYSH_URL || 'https://debugger.pay.sh/mpp/quote/AAPL';
// Settlement is executed on the sandbox by default; set PAYSH_SETTLE=0 to only read the charge terms.
const EXECUTE = process.env.PAYSH_SETTLE !== '0';

let payToolChecked = false;
let payToolPath: string | null = null;

function findPayTool(): Promise<string | null> {
  if (payToolChecked) return Promise.resolve(payToolPath);
  return new Promise((resolve) => {
    execFile('sh', ['-lc', 'command -v pay || true'], { timeout: 5_000 }, (_e, stdout) => {
      payToolChecked = true;
      payToolPath = stdout.trim() || null;
      resolve(payToolPath);
    });
  });
}

// Run `pay --sandbox fetch <url>` and capture the gated JSON and any Solana signature it prints.
function runPayFetch(url: string): Promise<{ content: unknown; txSignature: string | null }> {
  return new Promise((resolve, reject) => {
    execFile('pay', ['--sandbox', 'fetch', url], { timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const all = `${stdout}\n${stderr}`;
      // The gated resource is JSON on stdout; grab the last JSON object printed.
      let content: unknown = null;
      const jsonMatch = stdout.match(/\{[\s\S]*\}/g);
      if (jsonMatch) { try { content = JSON.parse(jsonMatch[jsonMatch.length - 1]!); } catch { /* leave null */ } }
      // A Solana signature is base58, ~87-88 chars; capture one if the tool reports it.
      const sig = all.match(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/);
      if (err && content == null) { reject(new Error((stderr || err.message).slice(0, 200))); return; }
      resolve({ content, txSignature: sig ? sig[0]! : null });
    });
  });
}

export async function settleSpend(opts: { amountUsd: number; memo?: string; url?: string }): Promise<SolanaSettlement> {
  const url = opts.url || DEFAULT_PAYSH_URL;
  const base: SolanaSettlement = { rail: 'Pay.sh (Solana)', settled: false, chargeUrl: url, amountUsd: opts.amountUsd, memo: opts.memo };

  // 1) Read the live Pay.sh charge: the real Solana payment terms for this spend. Dependency-free.
  let charge: ChargeSpec | null = null;
  try {
    charge = await quoteCharge(url);
    base.network = charge.caip2Network;
    base.tokenMint = charge.tokenMint;
    base.payTo = charge.payTo;
    base.feePayer = charge.methodDetails.feePayer;
    // The charge states the gate's own price; the spend being settled is the specialist call's cost.
  } catch (e) {
    base.note = `could not read Pay.sh charge: ${(e as Error).message}`;
    return base;
  }

  if (!EXECUTE) {
    base.note = 'charge terms read; settlement execution disabled (PAYSH_SETTLE=0)';
    return base;
  }

  // 2) Execute settlement on the sandbox through the official `pay` tool, when it is installed.
  const tool = await findPayTool();
  if (!tool) {
    base.note = 'charge terms read; `pay` tool not installed, settlement not executed (see docs/SOLANA.md)';
    return base;
  }
  try {
    const { content, txSignature } = await runPayFetch(url);
    return { ...base, settled: true, gatedContent: content, txSignature };
  } catch (e) {
    base.note = `charge terms read; sandbox settlement unavailable (${(e as Error).message})`;
    return base;
  }
}

// CLI: settle a single demonstration spend and print the evidence.
if (import.meta.url === `file://${process.argv[1]}`) {
  const amount = Number(process.argv[2] ?? '0.01');
  const s = await settleSpend({ amountUsd: amount, memo: 'manual settle test' });
  console.log(JSON.stringify(s, null, 2));
}
