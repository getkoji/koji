# Insurance template

Commercial insurance policy extraction with category routing and hints.

Scaffolded files:

- `koji.yaml` — project config with a parse + extract pipeline wired to `schemas/insurance_policy.yaml`
- `schemas/insurance_policy.yaml` — extraction schema covering declarations, coverages, and agent info with `look_in`, `patterns`, and `signals` hints

Demonstrates the full extraction intelligence layer: categories route sections, hints steer fields, and structured output captures policy number, insured, dates, premium, carrier, and a list of coverages with limits and deductibles.
