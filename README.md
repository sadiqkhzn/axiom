# Axiom

The verified answer layer for agents.

An axiom is a truth you build everything else on. That is the idea here. Axiom takes any plain-language question,
routes it to the best-ranked specialist on Telegraph, pays per call, and returns a cited answer with a receipt you
can verify against the network yourself. Every answer comes back proven, not guessed, with the provider that
produced it and the price paid.

If Axiom is useful to you, star the repo. It takes a second and it helps.

Most agents on Telegraph wire up one kind of intelligence: a supplier check, a token risk score, one data feed.
This one is the layer above that. You give it any task. It works out which intent the task belongs to, routes to
the number one ranked specialist for that intent, pays for the call, and returns the answer with its source and a
receipt. Other people's specialists and your own are both supply it can use. As the specialist market competes and
re-ranks, the answers improve on their own, with no code change.

## Why this beats a model answering on its own

Same question, two ways. The first is a frontier model answering from memory with specialists turned off. The
second is this agent buying the ranked specialist. Both runs are live and reproducible. Full detail is in
[docs/COMPARISON.md](docs/COMPARISON.md).

| Question | Model on its own | This agent with a specialist |
| --- | --- | --- |
| Is "Rosoboronexport" on the OFAC list? | "listed, added around 2014, check OFAC for the exact date" (no source) | "Listed. Matches JSC ROSOBORONEXPORT on the EU and US OFAC lists. Block." plus a verified receipt |
| What is the exact LEI of Citigold Corporation Limited? | "I cannot provide it without a lookup" | 529900C4YHWJ2XJ8A350, jurisdiction AU, status ACTIVE, plus a verified receipt |

The model answer is either a plausible guess or an honest refusal. Neither is something you can act on for a real
decision. The specialist answer names its source, carries a receipt, and can be rechecked by anyone at
`GET /engine/v1/signal/<hash>` with no wallet and no trust in us.

## How it works

```
plain task  ->  pick the intent  ->  pay the number one specialist for that intent  ->  answer + receipt + check
```

1. `src/direct.ts` classifies the task, maps it to a known specialist, and buys the answer directly from that
   specialist by id. It returns the answer, the price, a receipt hash, a signal hash, and an independent
   verification of the purchase against the node's public record. Buying by id does not depend on the live
   ranking, so this path keeps working even when rank-routed agents stall.
2. `src/route.mjs` runs the ranked route, and the no-specialist baseline used as the frontier control in the
   comparison.
3. `src/paysh.ts` reads the Solana payment contract used for settlement on Pay.sh. See [docs/SOLANA.md](docs/SOLANA.md).

Adding a new domain is one row in the specialist map in `direct.ts`. There is no new code per task.

## Run it

Requirements: Node 22.18 or newer.

```bash
npm install
cp .env.example .env     # then set EVM_PRIVATE_KEY to a burner key funded with testnet USDC

node src/direct.ts "Is 'Rosoboronexport' on the OFAC sanctions list?"
node src/direct.ts "Enrich the company Citigold Corporation Limited"
node src/route.mjs --baseline "What is the LEI of Citigold Corporation Limited?"   # the model-only control
node src/paysh.ts                                                                  # read the Solana charge contract
```

The wallet key is read from `.env` and is never logged. Payments are capped at 0.05 USD per call and 0.50 USD per
day, on testnet only.

## Settlement

Calls are paid per request over the x402 protocol. Today that runs in test USDC on Ethereum Sepolia, enforced by a
spend cap in `src/wallet.ts`. For Solana, Pay.sh settles the same per-call model in Solana USDC through its MPP
charge protocol. `src/paysh.ts` reads the live Pay.sh charge challenge, and the signed settlement runs through the
official `pay` command line tool. Steps are in [docs/SOLANA.md](docs/SOLANA.md).

## What it does not do

- The ranked route depends on the network's live ranking. The direct-by-id path is the one the demo relies on,
  because it keeps working regardless of ranking state.
- A sanctions query with only a name returns a REVIEW result, not a BLOCK. The agent returns the qualified answer
  and never upgrades it to a certainty it cannot support.
- Solana settlement reads the real Pay.sh contract and runs through the official tool. There is no custom in-repo
  Solana signer yet.

## Layout

```
src/direct.ts      the agent: task in, ranked specialist answer with a receipt out
src/route.mjs      ranked route and the model-only baseline
src/paysh.ts       reads the Pay.sh Solana charge contract
src/telegraph.ts   the Telegraph buying client (discover, quote, pay over x402, keep the receipt, verify)
src/wallet.ts      the paying fetch that signs x402 payments from a burner key
docs/              comparison results, run output, and the Solana guide
```
