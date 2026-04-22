"""Tests for services/extract/providers.py — provider creation and configuration."""

from __future__ import annotations

from services.extract.providers import (
    AnthropicProvider,
    OllamaProvider,
    OpenAIProvider,
    create_provider,
)


class TestCreateProvider:
    def test_openai_prefix(self):
        p = create_provider("openai/gpt-4o-mini")
        assert isinstance(p, OpenAIProvider)
        assert p.model == "gpt-4o-mini"

    def test_openai_prefix_gpt4o(self):
        p = create_provider("openai/gpt-4o")
        assert isinstance(p, OpenAIProvider)
        assert p.model == "gpt-4o"

    def test_ollama_prefix(self):
        p = create_provider("ollama/llama3.2")
        assert isinstance(p, OllamaProvider)
        assert p.model == "llama3.2"

    def test_no_prefix_defaults_to_ollama(self):
        p = create_provider("llama3.2")
        assert isinstance(p, OllamaProvider)
        assert p.model == "llama3.2"

    def test_no_prefix_mistral(self):
        p = create_provider("mistral")
        assert isinstance(p, OllamaProvider)
        assert p.model == "mistral"

    def test_anthropic_prefix_uses_anthropic(self):
        p = create_provider("anthropic/claude-3-haiku")
        assert isinstance(p, AnthropicProvider)
        assert p.model == "claude-3-haiku"

    def test_unknown_prefix_uses_openai(self):
        p = create_provider("deepseek/deepseek-r1")
        assert isinstance(p, OpenAIProvider)
        assert p.model == "deepseek-r1"

    def test_model_with_multiple_slashes(self):
        # e.g. "openai/ft:gpt-4o-mini:custom" — split on first slash only
        p = create_provider("openai/ft:gpt-4o-mini:custom")
        assert isinstance(p, OpenAIProvider)
        assert p.model == "ft:gpt-4o-mini:custom"


class TestProviderDefaults:
    def test_ollama_default_url(self):
        p = OllamaProvider(model="llama3.2")
        # Default from env or hardcoded
        assert "11434" in p.base_url

    def test_ollama_custom_url(self):
        p = OllamaProvider(model="llama3.2", base_url="http://localhost:11434")
        assert p.base_url == "http://localhost:11434"

    def test_openai_default_url(self):
        p = OpenAIProvider(model="gpt-4o-mini")
        assert "openai.com" in p.base_url or "api.openai.com" in p.base_url

    def test_openai_custom_url(self):
        p = OpenAIProvider(model="gpt-4o-mini", base_url="http://localhost:8080/v1")
        assert p.base_url == "http://localhost:8080/v1"

    def test_openai_custom_api_key(self):
        p = OpenAIProvider(model="gpt-4o-mini", api_key="sk-test123")
        assert p.api_key == "sk-test123"


class TestProviderEnvOverrides:
    def test_ollama_url_env(self, monkeypatch):
        monkeypatch.setenv("KOJI_OLLAMA_URL", "http://custom-ollama:11434")
        p = OllamaProvider(model="llama3.2")
        assert p.base_url == "http://custom-ollama:11434"

    def test_openai_url_env(self, monkeypatch):
        monkeypatch.setenv("KOJI_OPENAI_URL", "http://custom-openai:8080/v1")
        p = OpenAIProvider(model="gpt-4o-mini")
        assert p.base_url == "http://custom-openai:8080/v1"

    def test_openai_api_key_env(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-env-key-123")
        p = OpenAIProvider(model="gpt-4o-mini")
        assert p.api_key == "sk-env-key-123"

    def test_explicit_overrides_env(self, monkeypatch):
        monkeypatch.setenv("KOJI_OPENAI_URL", "http://env-url")
        p = OpenAIProvider(model="gpt-4o-mini", base_url="http://explicit-url")
        assert p.base_url == "http://explicit-url"
