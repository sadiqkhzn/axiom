# Counterparty-clearance agent

A commercial agent that consumes **multiple specialist intelligences** before a payment is released,
reaches a **GO / REVIEW / STOP** decision, and settles its per-call spend on **Solana through Pay.sh** —
with complete execution and payment evidence for every step.

This is the agent layer of Axiom. The intelligence it buys comes from our own Telegraph miners; the agent
is what composes several specialist answers into one auditable commercial decision with a money trail.

## What it does

Given a counterparty (and optionally the order size and the supplier's website), the agent:

1. **Legal identity** — buys from miner `731005`: is this a real, registered, active legal entity
   (registered legal name, LEI, jurisdiction, status from the GLEIF Global LEI Index)?
2. **Sanctions** — buys from miner `731002`: a CLEAR / REVIEW / BLOCK verdict across US OFAC, UN, EU and UK.
3. **Website safety** — buys from miner `731006` when a domain is given: is the supplier's site free of
   known phishing/malware listings and does it resolve over valid transport?

It then decides:

- **STOP** if sanctions return a BLOCK — do not release payment.
- **REVIEW** if a counterparty can't be confirmed as a real active entity, sanctions are a partial match,
  or the website is flagged — hold for a human.
- **GO** if every check clears.

## Evidence

Every intelligence call carries a **Telegraph receipt** and a **signal hash** the node independently
verified, so each line of the decision is re-verifiable by anyone. Each spend is settled on **Solana via
Pay.sh**: the agent reads the live Pay.sh charge (network, USDC mint, amount, recipient, fee payer) for the
spend and, on the public sandbox, executes the settlement through the official `pay` tool and records the
proof. The full evidence pack (per-step answer, receipt, signal hash, verification, and settlement) is
returned as JSON alongside the human-readable report.

## Run it

```bash
# one counterparty
node src/agent.ts "Siemens AG" --order 250000 --website siemens.com

# a sanctioned entity is stopped
node src/agent.ts "Rosoboronexport" --order 50000

# the two-case demo (clean GO + sanctioned STOP)
node bench/clearance.ts
```

By default the agent only **reads** the Pay.sh charge terms for each spend — it settles nothing. To
execute a real settlement with **test tokens**, set the mode explicitly:

```bash
# local sandbox validator (test tokens)
PAYSH_MODE=sandbox node bench/clearance.ts --settle

# Solana devnet with a faucet-funded account (test tokens)
PAYSH_MODE=devnet PAYSH_ACCOUNT=<devnet account name> node bench/clearance.ts --settle
```

**Safety:** this never spends real money. Execution is off unless `PAYSH_MODE` is set; the only networks
it will settle on are the local sandbox and Solana devnet (both test tokens); and before any devnet
settlement it checks the named account's network and **refuses if the account is on mainnet**. There is
no code path that settles against mainnet or the default account.

### Example — clean supplier (GO)

```
Counterparty clearance — Siemens AG
Order: 250,000 USD
Decision: GO ✅

✓ Legal identity — Registered: Siemens Aktiengesellschaft (LEI W38RGI023J3WT1HWRP32, DE, ACTIVE)
    receipt 0x…· signal 0x… · node-verified
✓ Sanctions screen — Clear. Siemens AG does not appear on the OFAC, UN, EU or UK sanctions lists.
    receipt 0x… · signal 0x… · node-verified
✓ Website safety — Safe within the checks performed. siemens.com is absent from the threat feeds…
    receipt 0x… · signal 0x… · node-verified
```

### Example — sanctioned entity (STOP)

```
Counterparty clearance — Rosoboronexport
Decision: STOP ⛔

⛔ Sanctions screen — Listed. Rosoboronexport matches "JSC ROSOBORONEXPORT" on the EU and US OFAC lists.
    receipt 0x… · signal 0x… · node-verified
```

## Settlement status (honest)

- **Intelligence rail — works today.** Real paid calls to our Telegraph miners, each with a verifiable
  receipt and a node-verified signal hash, over x402 in test USDC on Ethereum Sepolia.
- **Settlement rail — Pay.sh on Solana (test tokens only).** The agent reads the live Pay.sh charge terms
  for each spend in code (`src/paysh.ts`, `src/settle.ts`). Settlement execution is **off by default** and,
  when enabled, runs only on the local sandbox or Solana **devnet** with test tokens through the official
  `pay` tool (see `docs/SOLANA.md`). A hard guard refuses to settle with any account on mainnet, so no run
  can spend real money. The sandbox validator is ephemeral (its wallet resets); Solana devnet with a
  faucet-funded account is the stable path for repeatable settlement evidence.
- **To produce completed-settlement evidence:** create a devnet pay account, fund it from the free devnet
  faucet, then run with `PAYSH_MODE=devnet PAYSH_ACCOUNT=<name>`. Each spend then settles on devnet and the
  agent records the transaction signature and the gated resource returned after the 402 clears.
