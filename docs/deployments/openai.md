---
title: OpenAI
description: Point Koji at the OpenAI API in three steps — get a key, add a provider, pick a model.
---

# OpenAI

The default path. Fastest to set up, widest model catalog, cheapest per 1M tokens at the small-model tier.

## 1. Get an API key

1. Sign in at [platform.openai.com](https://platform.openai.com).
2. **Settings → Organization → Billing** — add a payment method. New accounts can't call the chat-completions API until billing is active.
3. **API keys → Create new secret key**. Copy it — it's only shown once. It starts with `sk-`.

## 2. Add the provider in Koji

In the dashboard, go to **Settings → Model Providers → Add provider**.

| Field | Value |
|-------|-------|
| Name | Anything memorable (e.g. `openai-prod`) |
| Provider | `OpenAI` |
| Base URL | `https://api.openai.com/v1` (prefilled) |
| API key | `sk-...` from step 1 |
| Default model | Pick after saving — see below |

Save. The key is encrypted at rest immediately.

## 3. Populate the model catalog

Click **Fetch models** on the new provider row. Koji calls `GET /v1/models` on OpenAI and caches the list so you get a dropdown instead of free-text.

Set a **default model**. For most extraction workloads, `gpt-4o-mini` is the right starting point — it's an order of magnitude cheaper than `gpt-4o` and the accuracy delta on well-scoped schemas is small.

## 4. Wire a pipeline to it

In your pipeline's **extract** step, select the provider + model. That's it — next document processed routes through your new endpoint.

## Models worth knowing

| Model | When to use it |
|-------|----------------|
| `gpt-4o-mini` | **Default.** Best cost/accuracy for schema extraction. |
| `gpt-4o` | Complex documents, long forms, or when `gpt-4o-mini` is making structured-output mistakes you can't hint away. |
| `gpt-4.1-mini` | Similar tier to `gpt-4o-mini`; try both and compare with `koji bench`. |
| `o1-mini` / `o3-mini` | Heavy reasoning workloads. Overkill for most extraction. |

Use [`koji bench`](../cli.md) to compare models against your own corpus before committing.

## Cost expectations

Rough order of magnitude on `gpt-4o-mini` at 2026-Q2 prices:

- **Input**: ~$0.15 per 1M tokens
- **Output**: ~$0.60 per 1M tokens

A typical single-page invoice runs ~2,000 input + ~500 output tokens per extraction → under $0.001/document. Check [openai.com/api/pricing](https://openai.com/api/pricing) for current numbers.

## Rate limits that matter

OpenAI enforces **TPM** (tokens-per-minute) and **RPM** (requests-per-minute) per model per organisation, scaled to your usage tier. Koji processes documents in parallel by default, so a large batch can saturate these quickly.

If you see `429` errors in the extraction trace:

1. Check your [tier](https://platform.openai.com/account/limits) on the OpenAI dashboard.
2. Lower the pipeline concurrency (`cluster.extract_concurrency` in `koji.yaml`) until the backoff clears.
3. Spend enough over a billing period to advance tiers automatically — OpenAI gates tier-3+ behind a minimum historical spend.

## See also

- [Azure OpenAI](azure.md) — same models, different tenancy
- [Anthropic (direct)](anthropic.md) — Claude without an OpenAI-shaped API
- Provider adapter source: `services/extract/providers.py` (`OpenAIProvider`)
- Provider UI: `dashboard/src/app/(app)/t/[tenantSlug]/projects/[projectSlug]/settings/model-providers/page.tsx`
