# Koji

Documents in. Structured data out.

Koji is a self-hosted document processing platform. Parse, classify, and extract structured data from any document — PDFs, Word, images, scans — using local models or any API provider.

## Quick Start

```bash
# Install the CLI
pip install koji-cli

# Check your environment
koji doctor

# Initialize a project
koji init myproject
cd myproject

# Set your OpenAI API key (or use ollama for fully local)
export OPENAI_API_KEY=sk-...

# Start the cluster
koji start
```

Dashboard is now running at [http://127.0.0.1:9400](http://127.0.0.1:9400).

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

## Intelligent Extraction

Koji doesn't dump your entire document into an LLM. It uses a phased pipeline:

1. **Map** — classify every section, detect content signals (tables, dates, dollar amounts)
2. **Route** — schema `hints` direct each field to specific chunks
3. **Extract** — fields sharing chunks are extracted together, minimizing LLM calls
4. **Validate** — type checking, format normalization, enum matching
5. **Reconcile** — merge results, deduplicate, confidence scoring

Result: a 232-page insurance policy → 2 LLM calls, 2.7 seconds via gpt-4o-mini.

## Schema Hints

Hints tell the router where to look — no hardcoded domain knowledge:

```yaml
fields:
  policy_number:
    type: string
    required: true
    hints:
      look_in: [declarations]
      patterns: ["policy.*number"]
      signals: [has_policy_numbers]
```

## Configuration

All behavior is driven by `koji.yaml`:

```yaml
project: my-pipeline

cluster:
  base_port: 9400

# Optional: disable services you don't need
services:
  ollama: false  # Using OpenAI only

output:
  structured: ./output/
```

### Multiple Clusters

Run multiple clusters simultaneously — each gets its own port range:

```bash
# Terminal 1 — base_port: 9400
cd ~/project-a && koji start

# Terminal 2 — base_port: 9500
cd ~/project-b && koji start
```

No port conflicts. Each cluster is fully isolated.

## Model Providers

Koji is model-agnostic. BYO model — local or API:

| Provider | Model string | Notes |
|----------|-------------|-------|
| OpenAI | `openai/gpt-4o-mini` | Set `OPENAI_API_KEY` env var |
| Ollama | `llama3.2` | Local, runs in the cluster |
| Any OpenAI-compatible | `custom/model-name` | Set `KOJI_OPENAI_URL` env var |

```bash
koji extract ./output/doc.md --schema ./schema.yaml --model openai/gpt-4o-mini
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `koji init [dir]` | Scaffold a new project (`--template invoice` and friends; `--list-templates`) |
| `koji start` | Start the processing cluster |
| `koji stop` | Stop the cluster |
| `koji status` | Show service health |
| `koji process <path>` | Parse a document (add `--schema` for full pipeline) |
| `koji extract <md>` | Extract from already-parsed markdown |
| `koji logs [service]` | Stream service logs (`-f` to follow) |
| `koji doctor` | Check environment health |
| `koji version` | Show version |

## Documentation

- [Getting Started](docs/getting-started.md)
- [Schema Examples](schemas/examples/)

## License

Apache 2.0 — see [LICENSE](LICENSE).
