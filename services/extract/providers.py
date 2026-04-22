"""Model provider adapters.

The service accepts an optional ``EndpointConfig`` on every request
(defined in ``main.py``). When present, :func:`create_provider` routes to
the matching adapter below and uses the endpoint's credentials +
base_url + provider-specific extras (Azure deployment, Bedrock region,
etc.) rather than the env-var defaults. See
``docs/deployments/`` for per-vendor deployment guides.

Current adapters:
- :class:`OllamaProvider` — local Ollama HTTP
- :class:`OpenAIProvider` — OpenAI + any OpenAI-compatible endpoint
  (vLLM, TGI, self-hosted). Also used as a stopgap for providers whose
  dedicated adapter hasn't shipped yet.

Planned (stubbed here; implemented in platform-77/78/79):
- :class:`AzureOpenAIProvider` — Azure OpenAI with deployment routing
- :class:`BedrockProvider` — AWS Bedrock with SigV4 signing
- :class:`AnthropicProvider` — native Anthropic messages API
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    # Forward-reference Pydantic type from main.py. Import guarded so
    # providers.py stays importable on its own for unit tests.
    from .main import EndpointConfig


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


class AzureOpenAIProvider(ModelProvider):
    """Azure OpenAI. Implemented in platform-77.

    The protocol differs from stock OpenAI in three ways:
    - URL is ``{base_url}/openai/deployments/{deployment}/chat/completions``
    - ``api-version`` query param is required
    - Auth is ``api-key`` header rather than ``Authorization: Bearer``
    """

    def __init__(
        self,
        model: str,
        api_key: str,
        base_url: str,
        deployment_name: str,
        api_version: str,
    ):
        self.model = model
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.deployment_name = deployment_name
        self.api_version = api_version

    async def generate(self, prompt: str, json_mode: bool = True) -> str:
        raise NotImplementedError(
            "AzureOpenAIProvider is stubbed — see platform-77 for the "
            "full implementation (deployment routing + api-version)."
        )

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        raise NotImplementedError("AzureOpenAIProvider — see platform-77")


class BedrockProvider(ModelProvider):
    """AWS Bedrock. Implemented in platform-78.

    Uses SigV4-signed requests against the regional endpoint
    (``bedrock-runtime.<region>.amazonaws.com``). Model IDs are
    vendor-qualified, e.g. ``anthropic.claude-3-5-sonnet-20241022-v2:0``.
    """

    def __init__(
        self,
        model: str,
        region: str,
        access_key_id: str,
        secret_access_key: str,
        session_token: str | None = None,
    ):
        self.model = model
        self.region = region
        self.access_key_id = access_key_id
        self.secret_access_key = secret_access_key
        self.session_token = session_token

    async def generate(self, prompt: str, json_mode: bool = True) -> str:
        raise NotImplementedError(
            "BedrockProvider is stubbed — see platform-78 for the full "
            "SigV4-signed implementation."
        )

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        raise NotImplementedError("BedrockProvider — see platform-78")


class AnthropicProvider(ModelProvider):
    """Native Anthropic Messages API. Implemented in platform-79.

    Previously requests using claude-* models were shoe-horned through
    :class:`OpenAIProvider`, which silently 404'd on Anthropic's
    endpoint because the request shape is different
    (``/v1/messages`` + ``x-api-key`` header + different body schema).
    """

    def __init__(self, model: str, api_key: str, base_url: str | None = None):
        self.model = model
        self.api_key = api_key
        self.base_url = base_url or "https://api.anthropic.com/v1"

    async def generate(self, prompt: str, json_mode: bool = True) -> str:
        raise NotImplementedError(
            "AnthropicProvider is stubbed — see platform-79 for the "
            "native Anthropic Messages API implementation."
        )

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        raise NotImplementedError("AnthropicProvider — see platform-79")


def create_provider(
    model_str: str,
    endpoint_cfg: "EndpointConfig | None" = None,
) -> ModelProvider:
    """Create a provider from either an explicit endpoint config or a
    legacy model string.

    - When ``endpoint_cfg`` is provided (the common path from the Node
      API), the endpoint's provider field picks the adapter and the
      endpoint's credentials + base_url + extras are used directly.
      ``model_str`` is ignored.
    - When ``endpoint_cfg`` is None (bench, CLI, early adopters), we
      fall back to the legacy ``provider/model`` string + env-var
      defaults.

    Supported endpoint providers: ``openai``, ``azure-openai``,
    ``anthropic``, ``bedrock``, ``ollama``. OpenAI-compatible self-hosts
    (vLLM, TGI, etc.) use ``provider=openai`` with a custom ``base_url``.
    """
    if endpoint_cfg is not None:
        provider = endpoint_cfg.provider.lower()
        model = endpoint_cfg.model

        if provider == "openai":
            if not endpoint_cfg.api_key:
                raise ValueError("openai endpoint requires api_key")
            return OpenAIProvider(
                model=model,
                api_key=endpoint_cfg.api_key,
                base_url=endpoint_cfg.base_url,
            )
        elif provider == "azure-openai":
            missing = [
                f
                for f in (
                    ("api_key", endpoint_cfg.api_key),
                    ("base_url", endpoint_cfg.base_url),
                    ("deployment_name", endpoint_cfg.deployment_name),
                    ("api_version", endpoint_cfg.api_version),
                )
                if not f[1]
            ]
            if missing:
                raise ValueError(
                    f"azure-openai endpoint missing required fields: "
                    f"{', '.join(n for n, _ in missing)}"
                )
            return AzureOpenAIProvider(
                model=model,
                api_key=endpoint_cfg.api_key,
                base_url=endpoint_cfg.base_url,
                deployment_name=endpoint_cfg.deployment_name,
                api_version=endpoint_cfg.api_version,
            )
        elif provider == "bedrock":
            missing = [
                f
                for f in (
                    ("aws_region", endpoint_cfg.aws_region),
                    ("aws_access_key_id", endpoint_cfg.aws_access_key_id),
                    ("aws_secret_access_key", endpoint_cfg.aws_secret_access_key),
                )
                if not f[1]
            ]
            if missing:
                raise ValueError(
                    f"bedrock endpoint missing required fields: "
                    f"{', '.join(n for n, _ in missing)}"
                )
            return BedrockProvider(
                model=model,
                region=endpoint_cfg.aws_region,
                access_key_id=endpoint_cfg.aws_access_key_id,
                secret_access_key=endpoint_cfg.aws_secret_access_key,
                session_token=endpoint_cfg.aws_session_token,
            )
        elif provider == "anthropic":
            if not endpoint_cfg.api_key:
                raise ValueError("anthropic endpoint requires api_key")
            return AnthropicProvider(
                model=model,
                api_key=endpoint_cfg.api_key,
                base_url=endpoint_cfg.base_url,
            )
        elif provider == "ollama":
            return OllamaProvider(model=model, base_url=endpoint_cfg.base_url)
        else:
            raise ValueError(f"unknown endpoint provider: {provider!r}")

    # ── Legacy path: env-var defaults + model-string routing ─────────────
    # Known OpenAI model prefixes (covers gpt-*, o1-*, o3-*, chatgpt-*)
    OPENAI_PREFIXES = ("gpt-", "o1-", "o3-", "chatgpt-")

    if "/" in model_str:
        provider, model = model_str.split("/", 1)
        provider = provider.lower()

        if provider == "openai":
            return OpenAIProvider(model=model)
        elif provider == "ollama":
            return OllamaProvider(model=model)
        else:
            return OpenAIProvider(model=model)
    else:
        # Auto-detect by model name
        if any(model_str.startswith(p) for p in OPENAI_PREFIXES):
            return OpenAIProvider(model=model_str)
        if model_str.startswith("claude"):
            # TODO: route to AnthropicProvider once platform-79 lands.
            return OpenAIProvider(model=model_str)
        return OllamaProvider(model=model_str)
