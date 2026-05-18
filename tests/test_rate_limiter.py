"""Tests for AdaptiveRateLimiter and per-provider rate limiting."""

import httpx
import pytest

from services.extract.providers import (
    AdaptiveRateLimiter,
    AnthropicProvider,
    AzureOpenAIProvider,
    OpenAIProvider,
)

# ---------------------------------------------------------------------------
# AdaptiveRateLimiter unit tests
# ---------------------------------------------------------------------------


class TestAdaptiveRateLimiter:
    """Unit tests for the adaptive concurrency limiter."""

    def setup_method(self):
        # Clear shared instances between tests
        AdaptiveRateLimiter._instances.clear()

    async def test_successful_requests_pass_through(self):
        limiter = AdaptiveRateLimiter(initial=4)
        mock_resp = _mock_response(200)

        result = await limiter.execute(lambda: _async_return(mock_resp))
        assert result.status_code == 200

    async def test_429_triggers_retry_and_backoff(self):
        limiter = AdaptiveRateLimiter(initial=4)
        call_count = 0

        async def flaky_request():
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                return _mock_response(429)
            return _mock_response(200)

        result = await limiter.execute(flaky_request, max_retries=3)
        assert result.status_code == 200
        assert call_count == 3  # 2 failures + 1 success

    async def test_exhausted_retries_raises(self):
        limiter = AdaptiveRateLimiter(initial=4)

        with pytest.raises(httpx.HTTPStatusError):
            await limiter.execute(
                lambda: _async_return(_mock_response(429)),
                max_retries=2,
            )

    async def test_concurrency_tightens_on_429(self):
        limiter = AdaptiveRateLimiter(initial=4)
        assert limiter._max == 4

        # Trigger a 429 then succeed
        call_count = 0

        async def fail_then_succeed():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _mock_response(429)
            return _mock_response(200)

        await limiter.execute(fail_then_succeed, max_retries=2)
        # Concurrency should have tightened from 4 → 2
        assert limiter._max == 2

    async def test_concurrency_recovers_after_success(self):
        limiter = AdaptiveRateLimiter(initial=4)
        # Force tighten
        limiter._max = 2
        limiter._ceiling = 4
        limiter._successes_since_backoff = 0

        mock_resp = _mock_response(200)
        # 10 successful requests should trigger recovery
        for _ in range(10):
            await limiter.execute(lambda: _async_return(mock_resp))

        assert limiter._max == 3  # recovered by 1

    async def test_concurrency_floor_respected(self):
        limiter = AdaptiveRateLimiter(initial=2)
        assert limiter._floor == 1

        # Multiple 429s shouldn't go below floor
        call_count = 0

        async def mostly_fail():
            nonlocal call_count
            call_count += 1
            if call_count <= 3:
                return _mock_response(429)
            return _mock_response(200)

        await limiter.execute(mostly_fail, max_retries=3)
        assert limiter._max >= 1

    async def test_502_503_529_also_trigger_retry(self):
        for status in [502, 503, 529]:
            limiter = AdaptiveRateLimiter(initial=4)
            call_count = 0

            async def fail_then_ok():
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    return _mock_response(status)
                return _mock_response(200)

            result = await limiter.execute(fail_then_ok, max_retries=2)
            assert result.status_code == 200

    async def test_non_retryable_errors_raise_immediately(self):
        limiter = AdaptiveRateLimiter(initial=4)

        async def auth_fail():
            resp = _mock_response(401)
            raise httpx.HTTPStatusError("401", request=_MOCK_REQUEST, response=resp)

        with pytest.raises(httpx.HTTPStatusError):
            await limiter.execute(auth_fail, max_retries=3)

    async def test_shared_instance_per_key(self):
        a1 = AdaptiveRateLimiter.for_key("key-abc")
        a2 = AdaptiveRateLimiter.for_key("key-abc")
        b = AdaptiveRateLimiter.for_key("key-xyz")

        assert a1 is a2  # same key → same instance
        assert a1 is not b  # different key → different instance


# ---------------------------------------------------------------------------
# Provider integration tests — verify each provider uses the limiter
# ---------------------------------------------------------------------------


class TestProviderLimiterIntegration:
    """Verify each cloud provider has a limiter attached."""

    def setup_method(self):
        AdaptiveRateLimiter._instances.clear()

    def test_openai_provider_has_limiter(self):
        p = OpenAIProvider(model="gpt-4o-mini", api_key="sk-test")
        assert isinstance(p._limiter, AdaptiveRateLimiter)

    def test_openai_providers_share_limiter_by_key(self):
        p1 = OpenAIProvider(model="gpt-4o-mini", api_key="sk-test")
        p2 = OpenAIProvider(model="gpt-4o", api_key="sk-test")
        assert p1._limiter is p2._limiter

    def test_openai_providers_different_keys_different_limiters(self):
        p1 = OpenAIProvider(model="gpt-4o-mini", api_key="sk-key-a")
        p2 = OpenAIProvider(model="gpt-4o-mini", api_key="sk-key-b")
        assert p1._limiter is not p2._limiter

    def test_azure_provider_has_limiter(self):
        p = AzureOpenAIProvider(
            model="gpt-4o",
            api_key="az-test",
            base_url="https://myendpoint.openai.azure.com",
            deployment_name="gpt4",
            api_version="2024-02-01",
        )
        assert isinstance(p._limiter, AdaptiveRateLimiter)

    def test_anthropic_provider_has_limiter(self):
        p = AnthropicProvider(model="claude-3-5-sonnet", api_key="sk-ant-test")
        assert isinstance(p._limiter, AdaptiveRateLimiter)

    def test_anthropic_providers_share_limiter_by_key(self):
        p1 = AnthropicProvider(model="claude-3-5-sonnet", api_key="sk-ant-test")
        p2 = AnthropicProvider(model="claude-3-haiku", api_key="sk-ant-test")
        assert p1._limiter is p2._limiter


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_MOCK_REQUEST = httpx.Request("POST", "http://test")


def _mock_response(status: int) -> httpx.Response:
    """Create an httpx.Response with a request attached (required for HTTPStatusError)."""
    resp = httpx.Response(status, request=_MOCK_REQUEST)
    return resp


async def _async_return(value):
    """Wrap a value in a coroutine."""
    return value
