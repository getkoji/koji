# Contract template

Basic contract extraction — parties, effective dates, term, and key clauses.

Scaffolded files:

- `koji.yaml` — project config with a parse + extract pipeline wired to `schemas/contract.yaml`
- `schemas/contract.yaml` — extraction schema covering title, contract type, parties, effective and expiration dates, term length, governing law, and termination notice

Uses category routing (preamble, term, payment, termination, governing_law) plus hints so the extractor focuses on the right sections of long agreements.
