# Receipt template

Point-of-sale receipt extraction — merchant, items, tax, totals.

Scaffolded files:

- `koji.yaml` — project config with a parse + extract pipeline wired to `schemas/receipt.yaml`
- `schemas/receipt.yaml` — extraction schema covering merchant, timestamp, payment method, tax, tip, total, and itemized purchases

Good fit for expense tracking, reimbursement workflows, and POS receipt digitization.
