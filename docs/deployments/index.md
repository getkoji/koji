---
title: Deployment Guides
description: Runbook-style guides for pointing Koji at the model endpoint of your choice — OpenAI, Azure, Bedrock, Anthropic, or on-prem.
---

# Deployment Guides

Koji doesn't ship its own model. It extracts against whatever endpoint you configure in the **Model Providers** screen of the dashboard (*Settings → Model Providers*). Five paths are supported today. Pick the one that matches how your organisation buys and runs inference.

| Guide | For | One-line positioning |
|-------|-----|----------------------|
| [OpenAI](openai.md) | Teams that just want it to work | The fastest path. A key, a model, done. |
| [Azure OpenAI](azure.md) | Regulated buyers | Same models as OpenAI, inside your Azure tenancy and DPA. |
| [AWS Bedrock](bedrock.md) | AWS-native shops | Claude, Titan, Llama through your existing AWS account. |
| [Anthropic (direct)](anthropic.md) | Claude-first users | Direct access to the latest Claude snapshots without a cloud middleman. |
| [On-prem / self-hosted](on-prem.md) | Air-gapped or cost-sensitive | Point Koji at vLLM, TGI, or Ollama over HTTP. |

All five use the same stored-endpoint flow: credentials are entered once in the UI, encrypted at rest, and referenced by pipeline steps via an endpoint ID. Per-pipeline model overrides still work — see [Configuration](../configuration.md).

## Which one should I pick?

- **Just starting out?** Use [OpenAI](openai.md) with `gpt-4o-mini`. Cheapest, fastest to set up, good-enough accuracy for most schemas.
- **Compliance / data residency matters?** Use [Azure OpenAI](azure.md) — the data processing agreement covers extraction calls under the same terms as the rest of your Azure workload.
- **Already committed to AWS?** Use [Bedrock](bedrock.md). You avoid onboarding a new vendor and stay inside one bill.
- **Want the latest Claude first?** Use [Anthropic direct](anthropic.md). New model snapshots land there before they cycle through Bedrock or Azure.
- **Air-gapped network or volume-driven cost problem?** Use [on-prem](on-prem.md). Any OpenAI-compatible inference server (vLLM is the most production-ready) will work.

Mixing providers is fine and common — you can pin the map step to a cheap OpenAI model and run the final extract step against Bedrock Claude, for example.
