---
title: On-prem / self-hosted
description: Point Koji at a self-hosted inference server over HTTP — vLLM, TGI, Ollama, or any OpenAI-compatible endpoint.
---

# On-prem / self-hosted

For air-gapped networks, sovereignty requirements, or high-volume workloads where SaaS token costs have become the dominant line item. Koji treats any server that exposes an **OpenAI-compatible** chat-completions API as a valid endpoint — no bespoke adapter needed.

> Before committing to self-hosting, it's worth asking whether [Azure](azure.md) or [Bedrock](bedrock.md) solve the same problem with less ops burden. Running production-grade GPU inference yourself means GPUs, drivers, model downloads, monitoring, and on-call. If the reason is data residency rather than cost, a regional Azure or Bedrock deployment is usually cheaper end-to-end than a self-hosted fleet.

## Supported patterns

Any server that exposes `POST /v1/chat/completions` in the OpenAI request/response shape will work. The three patterns Koji users commonly run:

| Server | Good for | Notes |
|--------|----------|-------|
| **vLLM** | Production | Best throughput at high concurrency. Built-in continuous batching. |
| **Text Generation Inference (TGI)** | Production | HuggingFace's server. Good ecosystem, solid performance. |
| **Ollama** | Dev / prototyping | Fast to stand up. Also has a native `ollama` provider type in Koji (below). |

Other OpenAI-compatible servers — LocalAI, llama.cpp's `llama-server`, KServe, any LiteLLM-style proxy — fit the same pattern.

## 1. Stand up the inference server

### vLLM

```bash
docker run --gpus all -p 8000:8000 \
  --ipc=host \
  vllm/vllm-openai:latest \
  --model meta-llama/Meta-Llama-3.1-70B-Instruct
```

vLLM's container image exposes an OpenAI-compatible server on port 8000. The endpoint you'll hand Koji is `http://<host>:8000/v1`. Verify:

```bash
curl http://<host>:8000/v1/models
```

Should return a JSON object listing the loaded model. If that doesn't work, Koji won't either — debug here first.

For production, put this behind a reverse proxy with TLS termination (nginx, traefik, Caddy). The bare vLLM port should not be internet-exposed.

### Text Generation Inference (TGI)

```bash
docker run --gpus all -p 8080:80 \
  -v $PWD/data:/data \
  ghcr.io/huggingface/text-generation-inference:latest \
  --model-id meta-llama/Meta-Llama-3.1-70B-Instruct
```

TGI's OpenAI-compatible route is also `/v1/chat/completions`. Endpoint: `http://<host>:8080/v1`.

### Ollama

```bash
ollama serve
ollama pull llama3.1:70b
```

Ollama exposes its native API on port 11434. For Koji's **OpenAI (compatible)** provider, point at `http://<host>:11434/v1`. Alternatively, Koji has a dedicated `ollama` provider type — use that if you want to keep the native Ollama pull-on-demand model loading, or use the OpenAI-compatible path if you want a custom URL and uniform behaviour across providers.

## 2. Enter the endpoint in Koji

**Settings → Model Providers → Add provider.**

| Field | Value |
|-------|-------|
| Name | e.g. `vllm-prod` |
| Provider | **`OpenAI`** (yes, really — it's the compatibility protocol, not the vendor) |
| Base URL | Your inference endpoint, e.g. `http://vllm.internal:8000/v1` |
| API key | See [auth](#auth) below. Leave blank if the endpoint is unauthenticated. |
| Default model | Whatever the server advertises at `/v1/models` |

For Ollama specifically, you can instead pick `Ollama` as the provider type and set base URL to `http://<host>:11434` (no `/v1` suffix) — Koji's Ollama adapter calls the native API. Functionally equivalent for most purposes; pick whichever matches how you want to reason about the deployment.

## Auth

For internal/VPC-only endpoints, API auth is often optional — Koji sends no `Authorization` header if the API key field is empty.

For anything more exposed (internet-facing, shared across teams, behind a shared WAN), **put the inference server behind a gateway** that validates a shared secret or mTLS, and configure Koji to send that secret as the API key. Koji transmits it as `Authorization: Bearer <value>`, which is what most gateways already understand.

Patterns that work well:

- **Shared-secret gateway.** nginx or Envoy in front of vLLM, checking `Authorization: Bearer <secret>` against a value in config. Set the same secret as Koji's API key.
- **mTLS.** Terminate client certs at the gateway; enforce that only Koji's service cert gets through. Koji still sends a bearer token (can be anything) because some gateways also log it.
- **Cloud ALB + OIDC.** AWS/GCP load balancers can front on-prem inference via VPN; use a static token for service-to-service auth.

Never expose raw vLLM / TGI / Ollama to the internet without a gateway — there is no auth by default.

## Model IDs

Koji's **Fetch models** button calls `GET /v1/models` on the endpoint and populates the dropdown. This works for vLLM, TGI, and Ollama — use whatever the server advertises.

If fetching fails (some self-hosted servers implement `/v1/chat/completions` but not `/v1/models`), you can type the model ID manually. It needs to match exactly what the server expects — typos produce unhelpful 400s or 404s.

## Sizing and throughput

A few ballparks for planning, assuming an NVIDIA H100 80GB:

- **Llama 3.1 70B on vLLM**: ~30–60 documents/minute at single-page invoice complexity
- **Llama 3.1 8B on vLLM**: ~200+ documents/minute, but noticeably lower schema accuracy
- **Mixtral 8x7B on vLLM**: ~80 documents/minute, competitive accuracy with 70B models on well-specified schemas

For GPU-less deployments (Ollama on CPU), expect single-digit documents per minute and plan accordingly — these are fine for prototyping but usually not for production volumes.

Benchmark your own corpus with `koji bench` rather than trusting general numbers — document complexity, schema shape, and prompt length all matter more than the raw model spec.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `Connection refused` in traces | Endpoint not reachable from the Koji containers. Check firewall, DNS, and that your base URL is reachable from the extract container (not from your laptop). |
| `404 Not Found` on `/chat/completions` | The server advertises a different path, or is running in completion-only mode. Koji requires chat-completions shape. |
| `400 Bad Request` with no body | Model ID mismatch. Check `/v1/models`. |
| `500 Internal Server Error` on every request | Usually GPU OOM. Reduce `--max-model-len` (vLLM) or move to a smaller model. |
| Extractions come back as garbled JSON | Quantised model with too-aggressive compression. Try a higher-precision quant (Q5_K_M or better for llama.cpp, AWQ rather than GPTQ-4bit for vLLM). |

## See also

- [OpenAI](openai.md) — managed alternative if self-hosting turns out to be more ops than you wanted
- [Azure OpenAI](azure.md) — often simpler than maintaining a vLLM fleet if the driver is data residency
- Provider adapter source: `services/extract/providers.py` (`OpenAIProvider`, `OllamaProvider`)
- Provider UI: `dashboard/src/app/(app)/t/[tenantSlug]/projects/[projectSlug]/settings/model-providers/page.tsx`
