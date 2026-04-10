# Contributing to Koji

Thanks for your interest in contributing to Koji. This guide will help you get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/getkoji/koji.git
cd koji

# Install dependencies
pip install -e ".[dev]"

# Start a local cluster
koji start

# Run tests
koji test
```

## How to Contribute

### Reporting Bugs

Open a [GitHub Issue](https://github.com/getkoji/koji/issues/new) with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your `koji.yaml` config (redact secrets)
- Output of `koji version`

### Suggesting Features

Open a [GitHub Discussion](https://github.com/getkoji/koji/discussions) first. We'd rather discuss before you build — it saves everyone time.

### Submitting Code

1. Fork the repo
2. Create a branch from `dev` (`git checkout -b feature/my-feature dev`)
3. Make your changes
4. Write tests
5. Ensure all tests pass (`koji test`)
6. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add OCR fallback to parse service`
   - `fix: handle empty PDF pages in split`
   - `docs: update quickstart guide`
7. Open a PR targeting `dev`

### PR Requirements

- [ ] Tests pass
- [ ] New functionality has tests
- [ ] Commit messages follow Conventional Commits
- [ ] Breaking changes are documented
- [ ] PR description explains what and why

## Architecture

```
koji/
├── cli/          # CLI (koji command)
├── server/       # API server + workflow engine
├── services/     # Pipeline services (parse, extract, etc.)
├── docker/       # Dockerfiles and compose configs
├── schemas/      # Example extraction schemas
├── tests/        # Test suite
└── docs/         # Public documentation
```

Each service runs in its own container. The CLI talks to the server, the server orchestrates the pipeline.

## Contributor License Agreement

By submitting a PR, you agree that your contributions are licensed under the Apache 2.0 license. We use a CLA bot — you'll be asked to sign on your first PR.

## Code of Conduct

Be helpful. Assume good intent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
