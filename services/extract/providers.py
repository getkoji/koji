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
- :class:`AzureOpenAIProvider` — Azure OpenAI with deployment routing
- :class:`AnthropicProvider` — native Anthropic Messages API
  (``/v1/messages`` with ``x-api-key`` + ``anthropic-version`` headers)
- :class:`BedrockProvider` — AWS Bedrock via the Converse API with
  SigV4-signed requests (model IDs are vendor-qualified, e.g.
  ``anthropic.claude-3-5-sonnet-20241022-v2:0`` or ``amazon.titan-*``).
"""

from __future__ import annotations

import json
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
    """Works with OpenAI and any OpenAI-compatible API (vLLM, TGI,
    self-hosted, LiteLLM-style proxies, etc.). For native Anthropic
    endpoints use :class:`AnthropicProvider`; routing claude-* models
    through this adapter against ``https://api.anthropic.com`` will
    404 because their API is not OpenAI-shaped."""

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
    """Azure OpenAI.

    The protocol differs from stock OpenAI in three ways:
    - URL is ``{base_url}/openai/deployments/{deployment}/chat/completions``
    - ``api-version`` query param is required
    - Auth is ``api-key`` header rather than ``Authorization: Bearer``

    Request/response body shapes are identical to OpenAI chat
    completions. The ``model`` field is effectively ignored by Azure
    (the deployment already pins a model) but we include it for
    parity with the OpenAI adapter.
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

    def _headers(self) -> dict:
        return {
            "api-key": self.api_key,
            "Content-Type": "application/json",
        }

    def _url(self) -> str:
        return (
            f"{self.base_url}/openai/deployments/{self.deployment_name}"
            f"/chat/completions?api-version={self.api_version}"
        )

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
                self._url(),
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
                self._url(),
                json=payload,
                headers=self._headers(),
            )
            resp.raise_for_status()
            choice = resp.json()["choices"][0]
            return choice["message"]


class BedrockProvider(ModelProvider):
    """AWS Bedrock via the Converse API.

    Uses SigV4-signed requests (via ``botocore``) against the regional
    runtime endpoint ``bedrock-runtime.<region>.amazonaws.com``. The
    Converse API (``POST /model/{modelId}/converse``) gives a uniform
    request/response shape across all Bedrock-hosted model families
    (Anthropic Claude, Amazon Titan, Meta Llama, Mistral, Cohere), so
    one adapter covers every vendor-qualified model ID.

    JSON mode is not a first-class feature of Converse — when requested
    we append a short suffix to the user prompt instructing the model
    to return a JSON object (matching the OpenAI stopgap behaviour).

    Tool-use on Bedrock has its own ``toolConfig`` shape (tool specs +
    tool result messages) and isn't wired here yet — a chat() call with
    ``tools`` will raise ``NotImplementedError`` pointing at the
    follow-up task.
    """

    # Appended to user prompts when json_mode=True. Converse has no
    # "response_format=json_object" equivalent, so we steer via prompt.
    _JSON_MODE_SUFFIX = "\n\nRespond with ONLY a JSON object."

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
        self._endpoint = f"https://bedrock-runtime.{region}.amazonaws.com"

    def _signed_headers(self, url: str, body: bytes) -> dict[str, str]:
        """Build SigV4-signed headers for a Bedrock Converse POST.

        botocore is the pragmatic choice here: hand-rolling SigV4
        against stdlib (``hmac``/``hashlib``) is ~50 lines of fiddly
        canonical-request assembly that breaks if headers are re-cased
        or the body is rehashed. ``SigV4Auth.add_auth`` handles both.
        """
        # Imported lazily so that providers.py stays importable in
        # environments where botocore isn't installed (e.g. unit tests
        # that never exercise the Bedrock path).
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        from botocore.credentials import Credentials

        creds = Credentials(
            access_key=self.access_key_id,
            secret_key=self.secret_access_key,
            token=self.session_token,  # may be None; botocore handles it
        )
        aws_req = AWSRequest(
            method="POST",
            url=url,
            data=body,
            headers={"Content-Type": "application/json"},
        )
        # Service name is "bedrock" for both control-plane and runtime.
        SigV4Auth(creds, "bedrock", self.region).add_auth(aws_req)
        return dict(aws_req.headers.items())

    def _messages_to_converse(
        self, messages: list[dict]
    ) -> tuple[list[dict], list[dict] | None]:
        """Convert OpenAI-shape messages to Bedrock Converse shape.

        Rules:
        - Leading ``role: system`` messages become the top-level
          ``system`` field (array of ``{text: ...}``).
        - Subsequent ``system`` messages are inlined as user text (rare
          but we don't want to silently drop them).
        - ``user`` / ``assistant`` messages become
          ``{"role": ..., "content": [{"text": ...}]}``.
        """
        system_parts: list[dict] = []
        converse_msgs: list[dict] = []
        seen_non_system = False

        for msg in messages:
            role = msg.get("role", "user")
            raw_content = msg.get("content", "")
            # OpenAI occasionally hands us a list of content parts; we
            # flatten to text because Converse's text blocks are all we
            # support here.
            if isinstance(raw_content, list):
                text = "".join(
                    part.get("text", "")
                    for part in raw_content
                    if isinstance(part, dict)
                )
            else:
                text = str(raw_content)

            if role == "system" and not seen_non_system:
                system_parts.append({"text": text})
                continue

            seen_non_system = True
            # Bedrock only understands user/assistant at this layer; coerce
            # trailing system messages into user turns so nothing is lost.
            if role not in ("user", "assistant"):
                role = "user"
            converse_msgs.append({"role": role, "content": [{"text": text}]})

        return converse_msgs, (system_parts or None)

    async def _converse(
        self,
        messages: list[dict],
        system: list[dict] | None = None,
    ) -> dict:
        """POST to /model/{modelId}/converse and return the parsed body."""
        url = f"{self._endpoint}/model/{self.model}/converse"
        payload: dict = {
            "messages": messages,
            "inferenceConfig": {"temperature": 0, "maxTokens": 4096},
        }
        if system:
            payload["system"] = system

        body = json.dumps(payload).encode("utf-8")
        headers = self._signed_headers(url, body)

        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(url, content=body, headers=headers)
            resp.raise_for_status()
            return resp.json()

    @staticmethod
    def _extract_text(converse_response: dict) -> str:
        """Pull the assistant text out of a Converse response envelope."""
        message = converse_response.get("output", {}).get("message", {})
        parts = message.get("content", []) or []
        return "".join(part.get("text", "") for part in parts if isinstance(part, dict))

    async def generate(self, prompt: str, json_mode: bool = True) -> str:
        effective_prompt = prompt + self._JSON_MODE_SUFFIX if json_mode else prompt
        messages = [{"role": "user", "content": [{"text": effective_prompt}]}]
        response = await self._converse(messages=messages)
        return self._extract_text(response)

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        if tools:
            # Bedrock Converse supports tool use via a separate
            # toolConfig (tool specs) + assistant/user toolUse/toolResult
            # content blocks. That's a larger surface — deferred to a
            # follow-up task; callers that need tool-use on Bedrock
            # today should route via OpenAIProvider against a
            # Bedrock-compatible proxy.
            raise NotImplementedError(
                "BedrockProvider does not yet support tool use — the "
                "Converse API's toolConfig shape is a separate work item. "
                "Pass tools=None or use a different provider until the "
                "tool-use adapter lands."
            )

        converse_msgs, system = self._messages_to_converse(messages)
        response = await self._converse(messages=converse_msgs, system=system)
        text = self._extract_text(response)
        # Mirror OpenAIProvider.chat()'s return shape so callers that
        # only read ``content`` (and sometimes ``role``) work unchanged.
        return {"role": "assistant", "content": text}


class AnthropicProvider(ModelProvider):
    """Native Anthropic Messages API.

    Previously requests using claude-* models were shoe-horned through
    :class:`OpenAIProvider`, which silently 404'd on Anthropic's
    endpoint because the request shape is different:
    ``{base_url}/messages`` with ``x-api-key`` +
    ``anthropic-version`` headers and a body that treats ``system`` as
    a top-level field (not a message) and requires ``max_tokens``.

    JSON mode is emulated by appending an explicit JSON-only instruction
    to the prompt, since Anthropic has no ``response_format`` field.
    """

    # Pinned Messages API version. Bump deliberately — each version has
    # subtle response-shape implications.
    ANTHROPIC_VERSION = "2023-06-01"

    JSON_SUFFIX = "\n\nRespond with ONLY a JSON object."

    def __init__(self, model: str, api_key: str, base_url: str | None = None):
        self.model = model
        self.api_key = api_key
        self.base_url = (base_url or "https://api.anthropic.com/v1").rstrip("/")

    def _headers(self) -> dict:
        return {
            "x-api-key": self.api_key,
            "anthropic-version": self.ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }

    @staticmethod
    def _extract_text(response_json: dict) -> str:
        """Pull the first text block from an Anthropic Messages response.

        Anthropic returns ``content`` as a list of blocks. For plain
        text generation there is a single ``{"type": "text", ...}``
        block; tool-use responses interleave ``tool_use`` blocks (not
        supported yet — see ``chat()``).
        """
        blocks = response_json.get("content") or []
        for block in blocks:
            if block.get("type") == "text":
                return block.get("text", "")
        return ""

    async def generate(self, prompt: str, json_mode: bool = True) -> str:
        effective_prompt = prompt + self.JSON_SUFFIX if json_mode else prompt
        payload: dict = {
            "model": self.model,
            "max_tokens": 4096,
            "temperature": 0,
            "messages": [{"role": "user", "content": effective_prompt}],
        }
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                f"{self.base_url}/messages",
                json=payload,
                headers=self._headers(),
            )
            resp.raise_for_status()
            return self._extract_text(resp.json())

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        if tools:
            # Anthropic tool use uses a distinct ``tool_use`` /
            # ``tool_result`` block shape rather than OpenAI's
            # ``tool_calls`` array. Translating that is a separate
            # piece of work — file a follow-up task before wiring
            # tools to AnthropicProvider.
            raise NotImplementedError(
                "AnthropicProvider.chat(tools=...) not yet supported. "
                "Anthropic tool use requires translating OpenAI-shape "
                "tool definitions into Anthropic tool_use blocks; "
                "file a follow-up task for that before using tools "
                "against an anthropic endpoint."
            )

        # Extract system prompts (Anthropic puts them in a top-level
        # ``system`` field, not a ``role: system`` message). Multiple
        # system messages concatenate with a blank-line separator so
        # callers composing layered system prompts don't lose any.
        system_parts: list[str] = []
        converted: list[dict] = []
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", "")
            if role == "system":
                if content:
                    system_parts.append(content)
            else:
                converted.append({"role": role, "content": content})

        payload: dict = {
            "model": self.model,
            "max_tokens": 4096,
            "temperature": 0,
            "messages": converted,
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)

        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                f"{self.base_url}/messages",
                json=payload,
                headers=self._headers(),
            )
            resp.raise_for_status()
            text = self._extract_text(resp.json())
            # Match the OpenAI-provider contract the caller expects
            # (see OpenAIProvider.chat returning ``choice["message"]``).
            return {"role": "assistant", "content": text}


def build_provider(
    model_str: str,
    endpoint_cfg: EndpointConfig | None = None,
) -> ModelProvider:
    """Create a provider from either an explicit endpoint config or a
    legacy model string.

    - When ``endpoint_cfg`` is provided (the common path from the Node
      API), the endpoint's provider field picks the adapter and the
      endpoint's credentials + base_url + extras are used directly.
      ``model_str`` is ignored.
    - When ``endpoint_cfg`` is None (bench, CLI, early adopters), this
      delegates to :func:`create_provider` — the legacy
      ``provider/model`` string + env-var path. We keep ``create_provider``
      as a separate function (rather than collapsing into one) because
      the pipeline test suite monkeypatches it with a bare
      ``lambda model: mock`` — adding an ``endpoint_cfg`` kwarg to its
      signature would break every mock. ``build_provider`` is the wrapper
      that production callers use; tests continue to stub
      ``create_provider`` directly.

    Supported endpoint providers: ``openai``, ``azure-openai``,
    ``anthropic``, ``bedrock``, ``ollama``. OpenAI-compatible self-hosts
    (vLLM, TGI, etc.) use ``provider=openai`` with a custom ``base_url``.
    """
    if endpoint_cfg is None:
        return create_provider(model_str)

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


def create_provider(model_str: str) -> ModelProvider:
    """Legacy provider factory — env-var defaults + model-string routing.

    Kept at this exact signature (single positional argument, no
    kwargs) because ``tests/test_pipeline.py`` monkeypatches it with a
    bare ``lambda model: provider`` in many places. Adding params here
    breaks every one of those patches.

    Production callers go through :func:`build_provider` instead, which
    either delegates here when no endpoint config is supplied or
    constructs the provider directly from an explicit ``EndpointConfig``.
    """
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
        elif provider == "anthropic":
            return AnthropicProvider(
                model=model,
                api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            )
        else:
            return OpenAIProvider(model=model)
    else:
        # Auto-detect by model name
        if any(model_str.startswith(p) for p in OPENAI_PREFIXES):
            return OpenAIProvider(model=model_str)
        if model_str.startswith("claude"):
            return AnthropicProvider(
                model=model_str,
                api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            )
        return OllamaProvider(model=model_str)
