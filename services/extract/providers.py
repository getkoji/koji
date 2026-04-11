"""Model provider adapters — ollama, OpenAI-compatible, Anthropic."""

from __future__ import annotations

import json
import os

import httpx


class ModelProvider:
    """Base interface for model providers."""

    async def generate(self, prompt: str, json_mode: bool = True) -> str:
        raise NotImplementedError

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        raise NotImplementedError


class OllamaProvider(ModelProvider):
    def __init__(self, model: str, base_url: str | None = None):
        self.model = model
        self.base_url = base_url or os.environ.get("KOJI_OLLAMA_URL", "http://ollama:11434")

    async def generate(self, prompt: str, json_mode: bool = True) -> str:
        async with httpx.AsyncClient(timeout=1800) as client:
            payload: dict = {
                "model": self.model,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0, "num_predict": 4096},
            }
            if json_mode:
                payload["format"] = "json"

            resp = await client.post(f"{self.base_url}/api/generate", json=payload)
            resp.raise_for_status()
            return resp.json().get("response", "")

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        async with httpx.AsyncClient(timeout=1800) as client:
            payload: dict = {
                "model": self.model,
                "messages": messages,
                "stream": False,
                "options": {"temperature": 0, "num_predict": 4096},
            }
            if tools:
                payload["tools"] = tools

            resp = await client.post(f"{self.base_url}/api/chat", json=payload)
            resp.raise_for_status()
            return resp.json().get("message", {})


class OpenAIProvider(ModelProvider):
    """Works with OpenAI, Anthropic (via proxy), and any OpenAI-compatible API."""

    def __init__(self, model: str, api_key: str | None = None, base_url: str | None = None):
        self.model = model
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self.base_url = base_url or os.environ.get("KOJI_OPENAI_URL", "https://api.openai.com/v1")

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def generate(self, prompt: str, json_mode: bool = True) -> str:
        messages = [{"role": "user", "content": prompt}]
        async with httpx.AsyncClient(timeout=300) as client:
            payload: dict = {
                "model": self.model,
                "messages": messages,
                "temperature": 0,
                "max_tokens": 4096,
            }
            if json_mode:
                payload["response_format"] = {"type": "json_object"}

            resp = await client.post(
                f"{self.base_url}/chat/completions",
                json=payload,
                headers=self._headers(),
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        async with httpx.AsyncClient(timeout=300) as client:
            payload: dict = {
                "model": self.model,
                "messages": messages,
                "temperature": 0,
                "max_tokens": 4096,
            }
            if tools:
                payload["tools"] = tools

            resp = await client.post(
                f"{self.base_url}/chat/completions",
                json=payload,
                headers=self._headers(),
            )
            resp.raise_for_status()
            choice = resp.json()["choices"][0]
            return choice["message"]


def create_provider(model_str: str) -> ModelProvider:
    """Create a provider from a model string like 'openai/gpt-4o-mini' or 'llama3.2'.

    Format: provider/model or just model (defaults to ollama).

    Supported prefixes:
    - openai/ — OpenAI API (also works with any OpenAI-compatible endpoint)
    - ollama/ — local ollama (explicit)
    - (no prefix) — defaults to ollama
    """
    if "/" in model_str:
        provider, model = model_str.split("/", 1)
        provider = provider.lower()

        if provider == "openai":
            return OpenAIProvider(model=model)
        elif provider == "ollama":
            return OllamaProvider(model=model)
        else:
            # Assume OpenAI-compatible with a custom base URL
            # User should set KOJI_OPENAI_URL env var
            return OpenAIProvider(model=model)
    else:
        # No prefix — default to ollama
        return OllamaProvider(model=model_str)
