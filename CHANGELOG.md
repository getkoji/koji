# Changelog

Notable, user-visible changes. Newest first.

## 0.48.0 — 2026-07-03

**Projects are now a real isolation boundary.** Previously a project was an
overview page; every resource actually lived at the workspace level.

- Schemas, pipelines, jobs, sources, classifiers, review items, model
  endpoints, parse endpoints, webhooks, and API keys now belong to exactly
  one project, enforced with row-level security. Existing resources are
  migrated into each workspace's default project (the one whose slug matches
  the workspace slug) automatically.
- New `x-koji-project` request header selects the project; without it,
  requests resolve to the API key's project or the workspace default. See
  the [API reference](docs/api-reference.md#tenant--project-scoping).
- **API keys are project-bound.** A key can only operate inside the project
  it was created in, is rejected for other workspaces, and stops working if
  its project is deleted.
- Resource slugs are now unique per project (previously per workspace): two
  projects can each have a pipeline named `invoices`.
- Webhook fan-out is confined to the project the event originated in.
- Plan quantity limits (max schemas, pipelines, sources, webhooks) remain
  per-workspace.
- Deleting a workspace's last project is rejected.
- CLI: a profile's `--project` (or `KOJI_PROJECT`) is now sent as
  `x-koji-project` and must match the key's project. If you had a stale
  value stored from an earlier version, re-run `koji login`.
