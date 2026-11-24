# Integrating the sanctions and identity specialists

Two specialists, callable by miner id, each call a paid purchase that returns a receipt and a signal hash the
network can re-verify. For integrators mapping findings to a GO / REVIEW / STOP decision.

## The two miners

| Miner | id | method | endpoint | params | returns |
| --- | --- | --- | --- | --- | --- |
| Identity | 731005 | GET | `/enrich` | `name` (legal name, or `lei` / `ticker` / `question`) | legal name, LEI, jurisdiction, status, legal form, headquarters, `found` |
| Sanctions | 731002 | GET | `/screen` | `name`, optional `type` (individual/entity/vessel/aircraft), optional `dob`, `nationality` | `label` (CLEAR / REVIEW / BLOCK), per-list results, matches, reasons |

## Mapping to GO / REVIEW / STOP

Sanctions `label`:
- `CLEAR` -> GO (on the sanctions check)
- `REVIEW` -> REVIEW (a strong name match; add `dob` or `nationality`, or the full name, to resolve it)
- `BLOCK` -> STOP

Identity `found`:
- `found: true` and `status: ACTIVE` -> GO (on identity)
- `found: true` and status not active, or `found: false` -> REVIEW (the legal entity could not be confirmed active)

For a supplier, resolve identity first (731005), then screen the resolved legal name (731002). GO only when identity
is ACTIVE and sanctions is CLEAR. Any BLOCK is STOP. Anything unresolved is REVIEW.

## Worked examples (real runs, 2026-11-24)

Each call returned `verified: true` at 0.01 USD. Receipts are fresh per call, so your own runs produce new hashes.

1. Identity resolves. `731005 /enrich?name=Citigold Corporation Limited`
   -> "CITIGOLD CORPORATION LIMITED ... LEI 529900C4YHWJ2XJ8A350, jurisdiction AU, status ACTIVE", `found: true`
   receipt `0xd3719c9a17d1c4fb405eb5f4190ea1071d712ee0c0e27ecba4f935231f9aad46`
   signal  `0xfc7d293db27430a59a0c05fcf998d37893ce2c4c9bd6d1066ed10bd6f387c3f0`  => GO on identity

2. Sanctions clear. `731002 /screen?name=Citigold Corporation Limited&type=entity`
   -> "Clear. Citigold Corporation Limited does not appear on the OFAC, UN, EU or UK sanctions lists.", `label: CLEAR`
   receipt `0x90ed6fa71f46914586e3986a52dd346c145553a6fc0371bc5b35a063fdf1138d`
   signal  `0xd3408dd62a7f07ce2f42f22b9f2c25c5e555c1931bf4fad9fca329b4f3db577d`  => GO

3. Sanctions listed. `731002 /screen?name=Rosoboronexport&type=entity`
   -> "Listed. Rosoboronexport matches JSC ROSOBORONEXPORT on the US OFAC list and the EU consolidated list. Block.", `label: BLOCK`
   receipt `0x38ee1cd8e2ef212d78263a20d20962b5325b7139f04922982ff49b765733d438`
   signal  `0xfbd861af9074c2e0a2a9b428a1b249d4364ce1d18b1f025f1bddef95f3aaf6cc`  => STOP

4. Sanctions review. `731002 /screen?name=Igor Sechin&type=individual`
   -> "Possible match. Igor Sechin matches the listed name SECHIN, Igor on the US OFAC, UK and EU lists, but a
      sanctions block needs a date of birth or nationality to confirm it is the same person.", `label: REVIEW`
   receipt `0xb9c172e71645a9a4fb49ca8a3912c0980e1195af8e95bc414151e902660d6bab`
   signal  `0x635db1783493a160df0cfeb6d62fe1e07308e6cc8c3082b315929d392dda9c17`  => REVIEW (add dob or nationality)

## Verifying a result

Every purchase returns the answer, a `receipt_hash` and a `signal_hash`. The signal hash is checked against the
node's public signal record: that the signal was published, that the node verified it, and that the answer matches
what the node recorded. See `checkPurchase` in `src/telegraph.ts`.

## Reproduce

```bash
node bench/examples.ts
```

Runs the four calls above and prints each request, response, receipt hash, signal hash and verification.
