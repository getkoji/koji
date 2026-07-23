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

Three things worth knowing before you set one up:

- **Every credential has a scope.** When you add one, *Available to* decides whether it belongs to the current project only (the default) or to **all projects in this workspace**. A shared credential is usable from every project, including ones created later — so a new project isn't a blank slate. A credential added to a single project **overrides** the shared one for that project and nothing else, which is how you point one project at a different model or OCR vendor without disturbing the rest. Only a member who can reach every project may create, change, or delete a shared credential. You can change a credential's scope later with **share with all** / **unshare** on its card — the stored key is untouched, so you never have to re-enter a secret you can't read back.
- **A hosted provider needs its key up front.** OpenAI, Anthropic, and Azure OpenAI credentials are rejected without an `api_key`, so a credential can't sit in the list looking configured and then fail with a 401 on the first document. (`custom` and `ollama` may legitimately have no key.)
- **Deleting a credential takes it out of service immediately**, including for pipelines still pinned to it — those fall back to the default (or fail with "no model provider configured") rather than quietly continuing on a deleted key.

## Which one should I pick?

- **Just starting out?** Use [OpenAI](openai.md) with `gpt-4o-mini`. Cheapest, fastest to set up, good-enough accuracy for most schemas.
- **Compliance / data residency matters?** Use [Azure OpenAI](azure.md) — the data processing agreement covers extraction calls under the same terms as the rest of your Azure workload.
- **Already committed to AWS?** Use [Bedrock](bedrock.md). You avoid onboarding a new vendor and stay inside one bill.
- **Want the latest Claude first?** Use [Anthropic direct](anthropic.md). New model snapshots land there before they cycle through Bedrock or Azure.
- **Air-gapped network or volume-driven cost problem?** Use [on-prem](on-prem.md). Any OpenAI-compatible inference server (vLLM is the most production-ready) will work.

Mixing providers is fine and common — you can pin the map step to a cheap OpenAI model and run the final extract step against Bedrock Claude, for example.

## Parse / OCR is BYO too

Models handle extraction; **parse / OCR** handles turning scanned PDFs and images
into text. That cost is yours to own as well. Configure an OCR vendor key in
*Project settings → Parse Endpoints* and the per-page parse cost stays on your
bill — Mistral OCR, Azure Document Intelligence, Google Document AI, or AWS
Textract. See [Parse / OCR Providers](parse.md). Digital PDFs parse for free
in-process; with no parse endpoint configured the built-in default engine is used.
