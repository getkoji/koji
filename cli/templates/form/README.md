# Form template

Government form extraction — names, dates, addresses, checkboxes.

Scaffolded files:

- `koji.yaml` — project config with a parse + extract pipeline wired to `schemas/form.yaml`
- `schemas/form.yaml` — extraction schema covering form identifiers, filer name, date of birth, contact details, mailing address (as a nested object), checkbox fields, and signature presence

Use this as a starting point for any structured intake form: W-9, I-9, passport applications, DMV paperwork, intake questionnaires, and so on.
