# Live results

The direct-by-id path classifies a task, maps it to a specialist, buys the answer from that specialist by id, and
verifies the purchase against the network's public signal record. It does not depend on the live ranking, so it
keeps working when rank-routed agents stall.

## Run on 2026-11-23

One integration, three domains, three specialists, each answer with a verified receipt, about 0.01 USD each.

| Task | Specialist | Answer, short form | Cost | Receipt | Verified |
| --- | --- | --- | --- | --- | --- |
| Is "Vladimir Putin" on any sanctions list? | sanctions screen | REVIEW, possible match to "PUTIN, Vladimir" on OFAC, UK and EU, UN clear, with the OFAC notice linked | 0.01 USD | 0xb04e6086ec1667dba40a5894c76fe8bbecc7148cb97b9f751b5a77651d60d8ad | yes |
| Enrich the company Citigold Corporation Limited | company identity | CITIGOLD CORPORATION LIMITED, HQ Fortitude Valley AU, LEI 529900C4YHWJ2XJ8A350, status ACTIVE | 0.01 USD | 0xc140b1687db5231df7b1 | yes |
| Is https://binance.com safe to use? | URL safety | appears safe, no listing on the phishing and malware feeds checked | 0.01 USD | 0x32c42d238dfcc56fd1c0 | yes |

The receipt hashes below are from one run on 2026-11-23. Each call is a fresh purchase, so re-running mints a new
receipt for the same answer. Verified means the purchase was published by the node, the node confirmed its own
hash of the record, and the recorded answer matched the answer we were given. Example signal hash for the sanctions call:
0x7239f8321a78909818c3765a92393f5c64b6c88487b1a3979a3e43d28e04c143. Anyone can recheck it at
`GET /engine/v1/signal/<hash>` with no wallet and no trust in us.

## What this shows

- Verifiable, not claimed. Each answer is a paid purchase with a receipt the network confirms.
- One integration, every domain. The same path served sanctions, identity and URL safety with no code per domain.
- Resilient. The direct-by-id path works while the ranked route is degraded.
- Cheap. About 0.01 USD per call.

## Reproduce

```bash
node src/direct.ts "Is 'Vladimir Putin' on a sanctions list?"
node src/direct.ts "Enrich the company Citigold Corporation Limited"
node src/direct.ts "Is https://binance.com safe?"
```
