// Pay.sh (Solana) settlement rail for the Verified Intelligence Mind.
//
// Pay.sh gates an API behind an HTTP 402 and settles per-call in Solana USDC. This module consumes that
// contract: it reads the 402 challenge, parses the MPP "charge" terms (network, token mint, amount, recipient,
// fee payer, recent blockhash), and produces a structured ChargeSpec the signer step turns into a signed Solana
// SPL-token transfer. Parsing + spec is dependency-free and runs against the live public sandbox
// (debugger.pay.sh) on Solana devnet - no real money. The signing step (buildAndPay) needs a Solana devnet
// keypair + @solana/web3.js and is the next increment.
//
// Verified live 2026-11-23 against https://debugger.pay.sh/mpp/quote/AAPL:
//   402, www-authenticate: Payment method="solana" intent="charge",
//   accepts: { amount:"10000", currency:"USDC", network:"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
//              payTo:"7s1hk…", protocol:"mpp", scheme:"charge" }

export type ChargeMethodDetails = {
  decimals: number;
  feePayer: boolean;
  feePayerKey?: string;
  network: string; // e.g. "localnet" / "devnet" in the signed request body
  recentBlockhash?: string;
  tokenProgram?: string;
};

export type ChargeSpec = {
  realm: string;
  method: string; // "solana"
  intent: string; // "charge"
  protocol: string; // "mpp"
  scheme: string; // "charge"
  caip2Network: string; // "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" (devnet)
  amountBaseUnits: string; // "10000"
  amountUsd: number; // amount / 10^decimals
  tokenMint: string; // SPL mint (currency field in the signed request)
  currencyLabel: string; // "USDC"
  payTo: string; // recipient Solana address
  description?: string;
  expires?: string;
  challengeId?: string;
  methodDetails: ChargeMethodDetails;
  rawRequestB64: string; // the base64 charge request to echo back with the proof
};

// Parse the `www-authenticate: Payment ...` header into its key="value" parts.
function parseWwwAuthenticate(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^Payment\s+/i, '');
  for (const m of body.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

function decodeB64Json<T>(b64: string): T | null {
  try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as T; } catch { return null; }
}

// Turn a 402 response (headers + accepts body) into a ChargeSpec, or null if it isn't a Pay.sh Solana charge.
export function parseCharge(headers: Headers, acceptsBody: unknown): ChargeSpec | null {
  const wa = headers.get('www-authenticate');
  if (!wa || !/^Payment\b/i.test(wa)) return null;
  const fields = parseWwwAuthenticate(wa);
  if (fields.method !== 'solana') return null;

  const accepts = (acceptsBody as { accepts?: any[] })?.accepts?.find((a) => a?.protocol === 'mpp' || a?.scheme === 'charge');
  if (!accepts) return null;

  const req = fields.request ? decodeB64Json<any>(fields.request) : null;
  const md = req?.methodDetails ?? {};
  const decimals: number = typeof md.decimals === 'number' ? md.decimals : 6;
  const amount = String(accepts.amount ?? req?.amount ?? '0');

  return {
    realm: fields.realm ?? accepts.realm ?? '',
    method: fields.method,
    intent: fields.intent ?? 'charge',
    protocol: accepts.protocol ?? 'mpp',
    scheme: accepts.scheme ?? 'charge',
    caip2Network: accepts.network ?? '',
    amountBaseUnits: amount,
    amountUsd: Number(amount) / 10 ** decimals,
    tokenMint: req?.currency ?? '',
    currencyLabel: accepts.currency ?? 'USDC',
    payTo: accepts.payTo ?? req?.recipient ?? '',
    description: fields.description,
    expires: fields.expires,
    challengeId: fields.id,
    methodDetails: {
      decimals,
      feePayer: Boolean(md.feePayer),
      feePayerKey: md.feePayerKey,
      network: md.network ?? '',
      recentBlockhash: md.recentBlockhash,
      tokenProgram: md.tokenProgram,
    },
    rawRequestB64: fields.request ?? '',
  };
}

// Fetch a Pay.sh-gated URL unpaid and return its ChargeSpec (the quote). Dependency-free.
export async function quoteCharge(url: string): Promise<ChargeSpec> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (r.status !== 402) throw new Error(`expected 402 from ${url}, got ${r.status}`);
  const body = await r.json().catch(() => ({}));
  const spec = parseCharge(r.headers, body);
  if (!spec) throw new Error(`no Pay.sh Solana charge in the 402 from ${url}`);
  return spec;
}

// CLI: print the parsed charge spec for a Pay.sh-gated URL (default: the public sandbox).
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2] || 'https://debugger.pay.sh/mpp/quote/AAPL';
  const spec = await quoteCharge(url);
  console.log(JSON.stringify(spec, null, 2));
}
