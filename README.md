# Koji

Documents in. Structured data out.

Koji is a self-hosted document processing platform. Parse, split, classify, and extract structured data from any document — PDFs, Word, images, scans — using local models or any API provider.

## Quick Start

```bash
# Install the CLI
pip install koji-cli

# Start a cluster
koji start

# Open the dashboard
open http://127.0.0.1:9400
```

That's it. Your cluster is running. The dashboard shows service health, and you're ready to process documents.

## Process Your First Document

Create a schema that describes what you want to extract:

```yaml
# schemas/invoice.yaml
name: invoice
fields:
  invoice_number:
    type: string
    required: true
  date:
    type: date
  vendor:
    type: string
  total_amount:
    type: number
    required: true
```

Process a document:

```bash
koji process ./invoice.pdf --schema ./schemas/invoice.yaml
```

Output:

```json
{
  "invoice_number": "INV-2026-0042",
  "date": "2026-03-15",
  "vendor": "Acme Corp",
  "total_amount": 4250.00
}
```

## Configuration

All behavior is driven by `koji.yaml`:

```yaml
project: my-pipeline

pipeline:
  - step: parse
    engine: docling

  - step: extract
    model: local/llama3-8b
    schemas:
      - ./schemas/invoice.yaml

models:
  providers:
    local:
      backend: ollama

output:
  structured: ./output/
```

### Multiple Clusters

Run multiple clusters simultaneously — each gets its own port range:

```yaml
# koji.yaml
cluster:
  name: my-project
  port: 9400  # dashboard
  # Services auto-assign ports from this base
```

```bash
# Terminal 1
cd ~/project-a && koji start  # dashboard at :9400

# Terminal 2
cd ~/project-b && koji start  # dashboard at :9500
```

No port conflicts. Each cluster is fully isolated.

## Pipeline Steps

| Step | What it does |
|------|-------------|
| **parse** | Any document format → clean markdown |
| **split** | Markdown → intelligent chunks |
| **classify** | Document/chunk → category labels |
| **extract** | Document/chunk → structured JSON via schema |
| **embed** | Text → vector embeddings |

Use the full pipeline or any step independently.

## Model Providers

Koji is model-agnostic. BYO model — local or API:

```yaml
models:
  providers:
    local:
      backend: ollama
    openai:
      api_key: ${OPENAI_API_KEY}
    anthropic:
      api_key: ${ANTHROPIC_API_KEY}
    custom:
      endpoint: https://your-inference.internal/v1
```

Mix and match per pipeline step. Use local for cheap operations, API for complex extraction. One config change, zero code changes.

## Deploy Anywhere

```bash
koji start              # Local development (docker-compose)
koji start --k8s        # Generate Kubernetes manifests
```

What runs locally is what runs in production. Same containers, same versions, same behavior.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Configuration Reference](docs/configuration.md)
- [Schema Reference](docs/schemas.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

## Community

- [GitHub Issues](https://github.com/getkoji/koji/issues) — bugs and feature requests
- [GitHub Discussions](https://github.com/getkoji/koji/discussions) — questions and ideas
- [Discord](https://discord.gg/koji) — chat with the community

## License

Apache 2.0 — see [LICENSE](LICENSE).
