# Invoice template

Simple invoice extraction — vendor, dates, totals, line items.

Scaffolded files:

- `koji.yaml` — project config with a parse + extract pipeline wired to `schemas/invoice.yaml`
- `schemas/invoice.yaml` — extraction schema with invoice number, vendor, dates, currency, total, and line items

Good starting point for accounts-payable workflows and general receipt-style documents.
