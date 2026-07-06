# Changelog

Notable, user-visible changes. Newest first.

## 0.51.0 — 2026-07-05

**Per-project access control.** Projects are now a permission boundary, not
just data scoping. By default every workspace member can access every project
(unchanged). An admin can now restrict a member to specific projects from
Settings → Members → "project access": that member then only sees and can act
in their granted projects, and requests to any other project are refused
(`403`). A member's workspace role still applies wherever they have access.
API: `GET`/`PUT /api/members/{id}/project-access`.

## 0.50.0 — 2026-07-05

**Move a resource between projects.** Schemas, pipelines, sources, classifiers,
model/parse endpoints, webhooks, and API keys can now be reassigned to another
project via `POST /api/projects/{slug}/move` (and a "Move" action on the
pipeline page). A pipeline's jobs and review items move with it. Because
resources resolve within their project, a move that would strand a
cross-project reference (a pipeline whose schema stays behind) is rejected
with the list of what to move first — preview it with `dry_run: true`.

## 0.49.0 — 2026-07-05

**Project isolation, second wave.** The in-app notification bell and the
schema-agent chat sessions are now project-scoped, completing the isolation
that landed in 0.48 for the remaining user-facing surfaces.

- The notification bell now shows the selected project's notifications plus
  tenant-level ones (queue failures, billing alerts) — the latter stay
  visible in every project. Existing notifications are backfilled to the
  project of the job/document/pipeline they reference.
- Schema-agent (schema builder) chat sessions belong to their schema's
  project and are only visible there.

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
