# Three ways to answer the same institutional question

The Verified Intelligence Economy use case asks for one thing to be shown: an agent that completes a hard task
through independently evaluated specialists, compared against a frontier model and against picking a provider
from an API listing. The measure is correctness, cost, latency and whether the answer can actually be acted on.

So here is one institutional question answered three ways on Telegraph, run live on 2026-11-24.

Question: Is "Rosoboronexport" on the OFAC sanctions list? (Rosoboronexport is the Russian state arms exporter,
a real OFAC-listed entity. Clearing it by mistake is a consequential error.)

## The three paths

1. **Frontier model on its own.** The agent answers from its model with specialists off.
   Reproduce: `node src/route.mjs --baseline "Is Rosoboronexport on the OFAC sanctions list?"`
2. **Pick a provider from the listing.** An agent that chooses a provider by its name in the catalog, not by
   rank, lands on a plausible, authoritative-sounding provider ranked about #15 of 31.
   Reproduce: `node bench/three-way.ts "Rosoboronexport"` (this leg).
3. **Axiom: the top-ranked specialist.** The task is routed to a top-ranked, independently evaluated sanctions
   specialist and paid per call. Reproduce: `node bench/three-way.ts "Rosoboronexport"` (this leg).

## Result

| | Frontier model, no tools | Pick from the listing (unranked) | Axiom, top-ranked specialist |
| --- | --- | --- | --- |
| Answer | "subject to sanctions by various countries... whether it is specifically listed on OFAC requires verification... I cannot confirm its current status with certainty" | `{"entity":"Rosoboronexport","on_list":1,"sanctioned":1,"source":"ofac_sdn_xml"}` | "Listed. Matches JSC ROSOBORONEXPORT on the US OFAC list and the EU consolidated list. Block the transaction and check the official notice." |
| Verdict | none, it declines to commit | a bare flag, on_list = 1 | BLOCK |
| Names the match and lists | no | one list only (OFAC SDN), no matched entity | yes, JSC ROSOBORONEXPORT on US OFAC and EU |
| Receipt you can verify | none | yes, `0x3e341853...` | yes, `0xca1c10ae...` |
| Cost | none | 0.01 USD | 0.01 USD |
| Latency | 15.2s | 3.3s | 2.4s |
| Usable for a decision | no | barely, a boolean from one source with no action | yes, cited, receipted, with the action |

## What this actually shows

The interesting line is not frontier versus specialist. That gap is obvious: the model hedges and will not commit,
with no source and no receipt, so it cannot authorize or block anything.

The interesting line is **picking from the listing versus picking by rank.** Both of those are real paid Telegraph
purchases, both cost the same cent, and both come back with a verified receipt. Verification and price do not
separate them. What separates them is the answer. The unranked pick returns a bare boolean from a single list. The
top-ranked specialist names the matched entity, both lists it appears on, and the action to take, and it was
faster. That difference is exactly what independent performance ranking surfaces, and it is invisible if an agent
chooses a provider from a catalog listing instead.

Ranking also filters out providers that do not work at all. A second authoritative-sounding sanctions provider in
the same listing (ranked 0) returned "circuit opened due to repeated failures" on the same question: a dead
endpoint an unranked agent would still have paid to try.

## A second domain, same pattern

Entity identity, model on its own versus the ranked specialist (run 2026-11-23):

| | Frontier model, no tools | Axiom, top-ranked specialist |
| --- | --- | --- |
| Task | What is the exact LEI of Citigold Corporation Limited? | same |
| Answer | "I cannot provide the exact LEI without a lookup" | LEI 529900C4YHWJ2XJ8A350, jurisdiction AU, status ACTIVE |
| Source and receipt | none | the global entity register, verified receipt |
| Usable for a decision | no | yes, an exact identifier that can be checked |

One integration served both the sanctions check and the identity lookup. Adding a domain is one row in a map, not
new code per task.

## Reproducing

The frontier baseline is a language model, so its wording changes from run to run; the behaviour does not. The two
paid legs are fresh purchases each time, so a re-run produces new receipt hashes for the same answers. Every figure
above is from the live runs on the dates stated.
