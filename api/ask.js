// src/telegraph.ts
var BASE_SEPOLIA = "eip155:84532";
var ETHEREUM_SEPOLIA = "eip155:11155111";
var TEST_NETWORKS = [ETHEREUM_SEPOLIA, BASE_SEPOLIA];
var TEST_USDC = {
  [ETHEREUM_SEPOLIA]: "0xcc194e1a843B658526D0D5C431f670028582Ae17",
  [BASE_SEPOLIA]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
};
var isTestUsdc = (network, asset) => !!asset && TEST_USDC[network]?.toLowerCase() === asset.toLowerCase();
var DEFAULT_NODE = "https://devnode.telegraphprotocol.com";
var TelegraphError = class extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
};
var MemorySpendStore = class {
  day = "";
  total = 0;
  roll(day) {
    if (day !== this.day) {
      this.day = day;
      this.total = 0;
    }
  }
  async reserve(day, amount, cap) {
    this.roll(day);
    if (this.total + amount > cap) return false;
    this.total += amount;
    return true;
  }
  async spent(day) {
    this.roll(day);
    return this.total;
  }
};
var SpendLimiter = class {
  perCall;
  daily;
  now;
  store;
  constructor(options) {
    this.perCall = options.perCallUusdc;
    this.daily = options.dailyUusdc;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.store = options.store ?? new MemorySpendStore();
  }
  today() {
    return this.now().toISOString().slice(0, 10);
  }
  validate(amount) {
    if (!isAmount(amount)) throw new TelegraphError("BAD_AMOUNT", `refusing to pay a non-numeric or negative amount (${String(amount)})`);
    if (amount > this.perCall) throw new TelegraphError("OVER_PER_CALL_CAP", `quoted ${amount} uUSDC is over the per-call cap of ${this.perCall}`);
  }
  async fromStore(read) {
    try {
      return await read();
    } catch (error) {
      throw new TelegraphError("SPEND_RECORD_UNAVAILABLE", `the spending record could not be reached, so nothing is paid (${error.message})`);
    }
  }
  // Before asking to pay: refuses early, but binds nothing. Only reserve() counts money.
  async check(amount) {
    this.validate(amount);
    const spent = await this.fromStore(() => this.store.spent(this.today()));
    if (spent + amount > this.daily) throw new TelegraphError("OVER_DAILY_CAP", `quoted ${amount} uUSDC would pass the daily cap of ${this.daily} (spent ${spent})`);
  }
  // Counts the amount against today's cap, or refuses. Called just before a payment is signed.
  async reserve(amount) {
    this.validate(amount);
    const reserved = await this.fromStore(() => this.store.reserve(this.today(), amount, this.daily));
    if (!reserved) throw new TelegraphError("OVER_DAILY_CAP", `quoted ${amount} uUSDC would pass the daily cap of ${this.daily}`);
  }
  async spent() {
    return this.fromStore(() => this.store.spent(this.today()));
  }
};
var isAmount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
var PaymentGuard = class {
  limiter;
  expected = null;
  constructor(limiter) {
    this.limiter = limiter;
  }
  expect(quote) {
    this.expected = quote;
  }
  clear() {
    this.expected = null;
  }
  // Returns why the payment must not be signed, or null after counting it against the caps.
  async authorize(terms) {
    const quote = this.expected;
    if (!quote) return "no purchase is in progress";
    if (terms.scheme !== "exact" || !TEST_NETWORKS.includes(terms.network)) return `only exact payments on ${TEST_NETWORKS.join(" or ")} are allowed`;
    if (terms.network !== quote.network) return "network differs from the quote";
    if (!/^\d+$/.test(terms.amount) || Number(terms.amount) !== quote.amountUusdc) return `amount ${terms.amount} differs from the quoted ${quote.amountUusdc}`;
    if (terms.payTo.toLowerCase() !== quote.payTo.toLowerCase()) return "pay-to address differs from the quote";
    if (terms.asset.toLowerCase() !== quote.asset.toLowerCase()) return "asset differs from the quote";
    try {
      await this.limiter.reserve(quote.amountUusdc);
    } catch (error) {
      return error.message;
    }
    return null;
  }
};
function decodeBase64Json(header) {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
function quoteFromChallenge(header) {
  const option = decodeBase64Json(header)?.accepts?.find((a) => a.scheme === "exact" && isTestUsdc(a.network, a.asset));
  if (!option || !/^\d+$/.test(String(option.amount)) || !option.asset) return null;
  return { amountUusdc: Number(option.amount), payTo: option.payTo, network: option.network, asset: option.asset };
}
var PAID_TIMEOUT_MS = 45e3;
var PAYMENT_RETRIES = 2;
var TelegraphClient = class {
  node;
  fetchFn;
  payingFetch;
  limiter;
  guard;
  sleep;
  // One payment at a time from this wallet: concurrent x402 payments collide on the nonce.
  queue = Promise.resolve();
  // A paying fetch must come with the PaymentGuard its signer consults (see wallet.ts), or nothing binds what it signs.
  constructor(options) {
    if (options.payingFetch && !options.guard) throw new TelegraphError("NO_GUARD", "a paying fetch needs the PaymentGuard its signer was built with");
    this.guard = options.guard ?? null;
    this.node = (options.nodeUrl ?? DEFAULT_NODE).replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.payingFetch = options.payingFetch ?? null;
    this.limiter = options.limiter;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  async getJson(path) {
    const response = await this.fetchFn(`${this.node}${path}`, { signal: AbortSignal.timeout(15e3) });
    if (!response.ok) throw new TelegraphError(`HTTP_${response.status}`, `Telegraph ${path}: HTTP ${response.status}`);
    return await response.json();
  }
  async miners(intent, limit = 50) {
    const body = await this.getJson(`/api/miners?intent=${encodeURIComponent(intent)}&limit=${limit}`);
    return Array.isArray(body) ? body : body.miners;
  }
  async intents() {
    return (await this.getJson("/engine/v1/intents")).intents;
  }
  // The unpaid request costs nothing and returns the price.
  async quote(path, body) {
    const response = await this.fetchFn(`${this.node}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15e3)
    });
    if (response.status !== 402) throw new TelegraphError("NO_CHALLENGE", `expected a 402 price quote from ${path}, got HTTP ${response.status}`);
    const quote = quoteFromChallenge(response.headers.get("payment-required"));
    if (!quote) throw new TelegraphError("NO_TEST_NETWORK_OPTION", `the challenge from ${path} offers no exact test-USDC payment on a supported test network (${TEST_NETWORKS.join(", ")})`);
    return quote;
  }
  ask(query, context) {
    return this.buy("/engine/v1/ask", context ? { query, context } : { query });
  }
  // Names the intent instead of describing it in words, so the node cannot route the request to another intent family.
  askIntent(intent, params) {
    return this.buy("/engine/v1/ask", { intent, params });
  }
  askMiner(minerId, method, endpoint, payload) {
    return this.buy(`/engine/v1/ask/${encodeURIComponent(minerId)}`, { method, endpoint, payload });
  }
  buy(path, body) {
    const run = this.queue.then(() => this.buyNow(path, body));
    this.queue = run.catch(() => void 0);
    return run;
  }
  async buyNow(path, body) {
    if (!this.payingFetch) throw new TelegraphError("NO_WALLET", "no paying wallet is configured (set the burner wallet key)");
    const quote = await this.quote(path, body);
    await this.limiter.check(quote.amountUusdc);
    const started = Date.now();
    const deadline = AbortSignal.timeout(PAID_TIMEOUT_MS);
    let response = null;
    this.guard.expect(quote);
    try {
      for (let attempt = 0; attempt <= PAYMENT_RETRIES; attempt++) {
        response = await this.payingFetch(`${this.node}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: deadline
        });
        if (response.status !== 402 || attempt === PAYMENT_RETRIES) break;
        await this.sleep(500 * (attempt + 1));
      }
    } catch (error) {
      if (error instanceof TelegraphError) throw error;
      throw new TelegraphError("PAYMENT_FAILED", `payment not completed: ${error.message}`);
    } finally {
      this.guard.clear();
    }
    const data = await response.json().catch(() => null);
    if (response.status === 402) throw new TelegraphError("PAYMENT_NOT_ACCEPTED", "payment was not accepted after retries");
    if (response.status === 422) throw new TelegraphError("PREDICTED_TO_FAIL", data?.error ?? "request is predicted to fail", data);
    if (!response.ok || !data) throw new TelegraphError(`HTTP_${response.status}`, data?.error ?? `Telegraph answered HTTP ${response.status}`, data);
    const receipt = decodeBase64Json(response.headers.get("x-telegraph-receipt"));
    const signalHash = data.signal_hash ?? null;
    return {
      minerId: data.miner_id ?? "",
      minerName: data.miner_name ?? "",
      intent: data.intent ?? null,
      endpoint: data.endpoint ?? null,
      reasoning: data.reasoning ?? null,
      result: (signalHash ? await this.recordedAnswer(signalHash) : void 0) ?? data.result ?? null,
      costUsd: data.cost_usd ?? quote.amountUusdc / 1e6,
      durationMs: data.duration_ms ?? Date.now() - started,
      signalHash,
      receipt
    };
  }
  // The answer in the paid reply is a shortened copy (some fields only, an empty list sent as null). The full answer
  // the miner returned is what the node records under the signal hash, and what checkPurchase compares a pack against,
  // so that is the one kept. The lookup is free; if the record is not there yet, the reply's copy is kept instead.
  async recordedAnswer(signalHash) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = await this.signal(signalHash).catch(() => null);
      if (record?.signal_hash === signalHash && record.payload && "response" in record.payload) return record.payload.response;
      if (attempt === 0) await this.sleep(1e3);
    }
    return void 0;
  }
  async signal(hash) {
    const response = await this.fetchFn(`${this.node}/engine/v1/signal/${encodeURIComponent(hash)}`, { signal: AbortSignal.timeout(15e3) });
    if (response.status === 404) return null;
    if (!response.ok) throw new TelegraphError(`HTTP_${response.status}`, `signal lookup: HTTP ${response.status}`);
    return await response.json();
  }
};
function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => sameJson(a[k], b[k]));
}
async function checkPurchase(client, purchase) {
  if (!purchase.signalHash) throw new TelegraphError("NO_SIGNAL", "this purchase has no signal hash to check");
  const record = await client.signal(purchase.signalHash);
  if (!record) return { signalHash: purchase.signalHash, published: false, nodeVerified: null, sameAnswer: null, sameMiner: null, record: null };
  return {
    signalHash: purchase.signalHash,
    published: record.signal_hash === purchase.signalHash,
    nodeVerified: record.verification?.verified ?? null,
    sameAnswer: "response" in record.payload ? sameJson(record.payload.response, purchase.result) : null,
    sameMiner: record.payload.subnet_id ? record.payload.subnet_id === purchase.minerId : null,
    record
  };
}

// src/wallet.ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
function payingFetchFromKey(privateKey, guard) {
  if (!privateKey) throw new TelegraphError("NO_WALLET", "EVM_PRIVATE_KEY is not set");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new TelegraphError("BAD_WALLET_KEY", "EVM_PRIVATE_KEY must be 0x followed by 64 hex characters");
  const account = privateKeyToAccount(privateKey);
  const client = new x402Client();
  for (const network of TEST_NETWORKS) client.register(network, new ExactEvmScheme(account));
  client.setSpendControls({ allowedAssets: [{ network: ETHEREUM_SEPOLIA, asset: TEST_USDC[ETHEREUM_SEPOLIA] }] });
  client.onBeforePaymentCreation(async ({ selectedRequirements: terms }) => {
    const reason = await guard.authorize(terms);
    return reason ? { abort: true, reason } : void 0;
  });
  return { fetch: wrapFetchWithPayment(fetch, client), address: account.address };
}

// api/ask.ts
var config = { maxDuration: 60 };
var SPECIALISTS = {
  SANCTIONS_SCREENING_MATCH_GENERAL: { minerId: "731002", endpoint: "/screen", param: "name", label: "Sanctions screen", source: "US OFAC, UN, EU, UK lists" },
  B2B_IDENTITY_ENRICHMENT_GENERAL: { minerId: "731005", endpoint: "/enrich", param: "name", label: "B2B identity", source: "Global LEI Index" },
  URL_SAFE_GENERAL: { minerId: "731006", endpoint: "/url-scan", param: "url", label: "URL/TLS safety", source: "URLhaus, phishunt, CERT Polska" }
};
function classify(t) {
  const s = t.toLowerCase();
  if (/\b(sanction|ofac|sdn|watch\s?list|blocklist|embargo)/.test(s)) return "SANCTIONS_SCREENING_MATCH_GENERAL";
  if (/\bhttps?:\/\/|\b(tls|ssl|certificate|domain safe|url safe|is .* safe)\b/.test(s)) return "URL_SAFE_GENERAL";
  if (/\b(company|entity|lei|legal name|jurisdiction|incorporat|who\s+is .*(ltd|inc|corp|pty)|enrich)\b/.test(s)) return "B2B_IDENTITY_ENRICHMENT_GENERAL";
  return null;
}
function subjectOf(task, intent) {
  if (intent === "URL_SAFE_GENERAL") {
    const u = task.match(/\bhttps?:\/\/\S+/i);
    if (u) return u[0].replace(/[).,?!"']+$/, "");
  }
  const q = task.match(/["']([^"']{2,})["']/);
  if (q) return q[1].trim();
  return task.replace(/^[^A-Za-z0-9]*/, "").replace(/\b(please|is|are|was|does|do|check|screen|look\s*up|resolve|enrich|tell me about|who\s+is|what\s+is|the\s+company|the\s+entity|company|entity|the)\b/gi, " ").replace(/\bon (any|a|the)? ?(sanctions?|watch)\s*list\??/gi, " ").replace(/[?.]+\s*$/, "").replace(/["']/g, "").replace(/\s+/g, " ").trim() || task.trim();
}
var DAILY_MAX = 50;
var IP_MAX = 3;
var IP_WINDOW_S = 600;
async function kv(cmd) {
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  if (!url || !tok) return null;
  try {
    const r = await fetch(`${url}/${cmd}`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(4e3) });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return typeof d?.result === "number" ? d.result : null;
  } catch {
    return null;
  }
}
async function overLimit(ip) {
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const n = await kv(`incr/axiom:day:${day}`);
  if (n === 1) await kv(`expire/axiom:day:${day}/172800`);
  if (n !== null && n > DAILY_MAX) return "The live demo has hit its daily budget. The three examples below are real verified runs.";
  const win = Math.floor(Date.now() / (IP_WINDOW_S * 1e3));
  const m = await kv(`incr/axiom:ip:${ip}:${win}`);
  if (m === 1) await kv(`expire/axiom:ip:${ip}:${win}/${IP_WINDOW_S}`);
  if (m !== null && m > IP_MAX) return "Too many requests from here. Give it a minute, or try the examples below.";
  return null;
}
async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ error: "use POST" });
    return;
  }
  const task = String(req.body?.task ?? "").slice(0, 300).trim();
  if (!task) {
    res.status(400).json({ error: "give a task" });
    return;
  }
  const intent = classify(task);
  if (!intent) {
    res.status(200).json({ error: "That one is outside the specialists wired up here (sanctions, company identity, URL safety). Try one of those." });
    return;
  }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const limited = await overLimit(ip);
  if (limited) {
    res.status(429).json({ error: limited });
    return;
  }
  const key = process.env.EVM_PRIVATE_KEY;
  if (!key) {
    res.status(500).json({ error: "server wallet not configured" });
    return;
  }
  const spec = SPECIALISTS[intent];
  const limiter = new SpendLimiter({ perCallUusdc: 5e4, dailyUusdc: 2e6, store: new MemorySpendStore() });
  const guard = new PaymentGuard(limiter);
  const wallet = payingFetchFromKey(key, guard);
  const client = new TelegraphClient({ payingFetch: wallet.fetch, guard, limiter });
  try {
    const buy = await client.askMiner(spec.minerId, "GET", spec.endpoint, { [spec.param]: subjectOf(task, intent) });
    let verified = false;
    if (buy.signalHash) {
      const chk = await checkPurchase(client, buy).catch(() => null);
      verified = !!chk && chk.published && (chk.nodeVerified ?? false) && (chk.sameAnswer ?? false);
    }
    const a = buy.result;
    const answer = typeof a === "string" ? a : a?.summary || a?.answer || JSON.stringify(a);
    res.status(200).json({
      answer,
      specialist: spec.label,
      source: spec.source,
      costUsd: buy.costUsd ?? 0.01,
      receiptHash: buy.receipt?.receipt_hash ?? "",
      signalHash: buy.signalHash ?? "",
      verified
    });
  } catch (e) {
    res.status(200).json({ error: "The specialist call did not complete. The examples below are real verified runs you can check now." });
  }
}
export {
  config,
  handler as default
};
