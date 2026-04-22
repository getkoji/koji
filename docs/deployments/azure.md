---
title: Azure OpenAI
description: Run Koji extractions against an Azure OpenAI deployment inside your own tenancy.
---

# Azure OpenAI

For buyers who need the same models OpenAI sells, but running under Microsoft's data-processing agreement and inside their own Azure subscription. This is the most common enterprise path.

The Azure OpenAI protocol differs from stock OpenAI in three ways: the URL is routed through a deployment name, the `api-version` query parameter is required, and auth uses an `api-key` header instead of a bearer token. Koji's adapter handles all three — you just need to hand it the four values.

## 1. Create the Azure OpenAI resource

If you don't already have one:

1. **Azure Portal → Create a resource → Azure OpenAI.** Pick a subscription, a resource group, and a **region** (see [regional considerations](#regional-considerations) below).
2. Complete the standard-form paperwork for the Responsible AI attestation. Provisioning takes a few minutes.
3. Open the new resource. You now have an endpoint URL and two keys.

## 2. Create a model deployment

In the resource blade: **Model deployments → Manage deployments → Create new deployment**.

1. Pick a **model** (e.g. `gpt-4o-mini`) and a **model version** (leave on *Auto-update to default* unless you need a pinned snapshot).
2. Set the **deployment name** — this is the identifier Koji will use, *not* the model name. Conventionally people set it to the model name (e.g. `gpt-4o-mini`), but it can be anything (e.g. `invoice-extract`).
3. Set the **TPM** (tokens-per-minute) quota. This is your rate cap — start low and raise it as throughput demands.

## 3. Collect the four values

You need all four before opening Koji:

| Value | Where to find it |
|-------|------------------|
| **Resource endpoint URL** | Resource blade → *Keys and Endpoint*. Format: `https://<resource-name>.openai.azure.com` |
| **Deployment name** | Whatever you set in step 2 |
| **API version** | Pick a recent GA version — `2024-10-21` works today. [Microsoft maintains a list.](https://learn.microsoft.com/en-us/azure/ai-services/openai/reference) |
| **API key** | Resource blade → *Keys and Endpoint*. Either KEY 1 or KEY 2 works. |

## 4. Enter them in Koji

**Settings → Model Providers → Add provider.**

| Field | Value |
|-------|-------|
| Name | `azure-<environment>` (e.g. `azure-prod`) |
| Provider | `Azure OpenAI` |
| Base URL | Resource endpoint from step 3 |
| Deployment name | Deployment name from step 3 |
| API version | API version from step 3 |
| API key | API key from step 3 |
| Default model | See the **trap** below |

!!! warning "The `model` field is not the Azure model"
    On Azure, the **deployment** pins the model. The **model** field in Koji's form is cosmetic — it's sent in the request body for logging parity with the OpenAI adapter, but Azure effectively ignores it. Set it to the underlying model name (e.g. `gpt-4o-mini`) so traces are readable, but know that changing it won't route to a different model. To switch models, create a new deployment and add it as a new provider.

## 5. Wire a pipeline

Select the provider in your extract step. The URL Koji calls internally looks like:

```
POST https://my-resource.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21
```

Request body shape is identical to OpenAI chat completions, so every Koji feature that works on OpenAI works on Azure.

## Content-filter gotchas

Azure wraps every model call in Microsoft's content filter. Some prompts will come back as HTTP 400 with a body like:

```json
{
  "error": {
    "code": "content_filter",
    "message": "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
    "innererror": {
      "content_filter_result": { ... }
    }
  }
}
```

This surfaces in Koji's extraction trace as an `httpx.HTTPStatusError: 400 Bad Request`. **This is expected behaviour, not a Koji bug.** Options:

- **Tune the filter.** The resource's *Content filters* blade lets you lower severity thresholds (or disable categories entirely, subject to Microsoft approval for some categories).
- **Route affected documents to a different provider.** Pipeline config can fall back — use a non-Azure endpoint for the small fraction of documents that trip the filter.
- **Mask or summarise before extract.** If the parse step emits the filter-tripping text, strip it before the extract step sees it.

## Regional considerations

Azure rolls new model deployments region-by-region, not all at once. Rough guidance (verify on Microsoft's availability matrix before committing):

- **East US 2** tends to get the newest snapshots first. If you need `gpt-4o` within days of OpenAI's release, deploy here.
- **Sweden Central, West Europe** for EU data-residency requirements.
- **Australia East, UK South, Canada East** if you have local-region compliance needs and don't mind a slightly older model catalog.

Region choice is fixed per resource — create one resource per region if you need models that aren't colocated.

## See also

- [OpenAI direct](openai.md) — if you don't need the Azure tenancy wrapper
- [Bedrock](bedrock.md) — alternative enterprise path if you're AWS-first
- Provider adapter source: `services/extract/providers.py` (`AzureOpenAIProvider`)
- Provider UI: `dashboard/src/app/(app)/t/[tenantSlug]/projects/[projectSlug]/settings/model-providers/page.tsx`
