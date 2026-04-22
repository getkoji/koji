---
title: Anthropic (direct)
description: Point Koji at the Anthropic Messages API for direct Claude access.
---

# Anthropic (direct)

For Claude-first users who want the latest model snapshots without waiting for them to cycle through Bedrock or a cloud provider. Calls go straight to `api.anthropic.com`.

Koji's Anthropic adapter targets the native [Messages API](https://docs.anthropic.com/en/api/messages) (`POST /v1/messages`), not an OpenAI-compatible shim — the request shape and auth headers differ enough that routing Claude through the generic OpenAI adapter simply 404s.

## 1. Get an API key

1. Sign in at [console.anthropic.com](https://console.anthropic.com).
2. **Settings → Billing** — add credits. Anthropic uses a prepaid credit model rather than monthly billing by default.
3. **API keys → Create Key.** Copy the key — only shown once. Starts with `sk-ant-`.

## 2. Add the provider in Koji

**Settings → Model Providers → Add provider.**

| Field | Value |
|-------|-------|
| Name | e.g. `anthropic-prod` |
| Provider | `Anthropic` |
| Base URL | `https://api.anthropic.com` (prefilled) |
| API key | `sk-ant-...` from step 1 |
| Default model | See cheat sheet below |

Save. Koji sends the key as `x-api-key` and pins the Messages API version to `2023-06-01`.

## 3. Models

Anthropic uses date-suffixed model IDs. Pick a specific snapshot — Anthropic deprecates older snapshots on published timelines, so "latest" aliases are best avoided in config.

| Model | Use it for |
|-------|------------|
| `claude-3-5-sonnet-20241022` | **Default** for extraction. Best accuracy/cost balance. |
| `claude-3-5-haiku-20241022` | High-throughput, simple-schema extraction. ~3× cheaper than Sonnet. |
| `claude-3-opus-20240229` | Most complex documents; slowest and most expensive. |

Deprecation cadence: Anthropic typically announces ~6 months ahead of a snapshot cut-off. When a model you're using gets a deprecation notice, add a new provider with the newer snapshot, benchmark with `koji bench`, and flip the pipeline.

## JSON mode — how it works

The Anthropic Messages API has no native equivalent to OpenAI's `response_format: json_object`. Koji's adapter emulates JSON mode by appending a short instruction to the user prompt:

```
Respond with ONLY a JSON object.
```

In practice this is reliable for schema extraction — Claude is good at obeying format instructions when the task is well-scoped. But there is one failure mode to know about:

!!! warning "`max_tokens` truncation"
    Anthropic requires `max_tokens` on every request. Koji defaults to 4096. For schemas that produce long nested arrays (e.g. invoices with 100+ line items, transcripts with many speakers), the model can truncate mid-JSON, and the `json.loads(...)` in the extract step then fails. If you see JSON-parse errors on Anthropic but not on OpenAI for the same schema + document, raise `max_tokens` — either per-pipeline or via a custom extraction step.

## Rate limits

Anthropic scales limits by usage tier (Build, Scale, Enterprise). On lower tiers you can saturate with modest parallelism:

- **Tier 1**: ~50 RPM, 40,000 ITPM (input tokens/min) per model
- **Tier 4**: ~4,000 RPM, 2,000,000 ITPM

Check your organisation's [rate limits page](https://console.anthropic.com/settings/limits) for current numbers. Same remediation as OpenAI — lower pipeline concurrency, wait for the tier to auto-promote, or contact Anthropic sales for a custom limit.

## Known limitation: no tool use yet

Anthropic's tool use uses `tool_use` / `tool_result` content blocks rather than OpenAI's `tool_calls` array. Koji's Anthropic adapter does not yet translate between the two — schemas relying on tool-call-style field extraction will raise `NotImplementedError` on an Anthropic endpoint.

Workaround: for tool-use workloads that need Claude, route through Bedrock or an OpenAI-compatible proxy (LiteLLM, Portkey) that handles the translation. Native Anthropic tool-use is tracked on the internal roadmap.

## See also

- [AWS Bedrock](bedrock.md) — Claude through AWS if you prefer single-cloud billing
- [Azure OpenAI](azure.md) — if you'd rather use GPT-class models under an enterprise DPA
- Provider adapter source: `services/extract/providers.py` (`AnthropicProvider`)
- Provider UI: `dashboard/src/app/(app)/t/[tenantSlug]/projects/[projectSlug]/settings/model-providers/page.tsx`
