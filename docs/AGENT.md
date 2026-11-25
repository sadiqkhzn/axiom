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

Add `--settle` (or omit `--no-settle`) to also execute the Solana settlement for each spend.

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
- **Settlement rail — Pay.sh on Solana.** The agent reads the live Pay.sh charge terms for each spend in
  code (`src/paysh.ts`, `src/settle.ts`) and executes settlement on the public sandbox through the official
  `pay` tool (see `docs/SOLANA.md`). The sandbox validator is ephemeral: its wallet is funded on first use
  and resets, so a settled run depends on the sandbox having funds at that moment. When it does not, the
  agent records the signed charge terms and marks the settlement pending rather than blocking the clearance.
- **Next step:** a persistent Pay.sh-gated endpoint on Solana devnet with a funded wallet (or the in-repo
  programmatic signer noted in `docs/SOLANA.md`) so every run produces a completed on-chain settlement.
