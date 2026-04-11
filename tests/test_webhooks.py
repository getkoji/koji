"""Tests for webhook delivery."""

from __future__ import annotations

import hashlib
import hmac
import json
from unittest.mock import AsyncMock, patch

import pytest

from server.config import KojiConfig, WebhookConfig
from server.webhooks import _build_payload, _sign_payload, fire_webhooks


class TestBuildPayload:
    def test_payload_structure(self):
        payload = _build_payload("job.completed", {"filename": "test.pdf"})
        assert payload["event"] == "job.completed"
        assert "timestamp" in payload
        assert payload["data"] == {"filename": "test.pdf"}

    def test_payload_has_iso_timestamp(self):
        payload = _build_payload("job.failed", {})
        # ISO format contains T separator
        assert "T" in payload["timestamp"]


class TestSignPayload:
    def test_hmac_sha256(self):
        body = b'{"event": "job.completed"}'
        secret = "my-secret"
        expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        assert _sign_payload(body, secret) == expected

    def test_different_secrets_produce_different_signatures(self):
        body = b'{"event": "job.completed"}'
        sig1 = _sign_payload(body, "secret-a")
        sig2 = _sign_payload(body, "secret-b")
        assert sig1 != sig2


class TestFireWebhooks:
    @pytest.fixture
    def config_with_webhooks(self):
        return KojiConfig(
            webhooks=[
                WebhookConfig(
                    url="https://example.com/hook1",
                    events=["job.completed"],
                    secret="test-secret",
                ),
                WebhookConfig(
                    url="https://example.com/hook2",
                    events=["job.failed"],
                ),
                WebhookConfig(
                    url="https://example.com/hook3",
                    events=["job.completed", "job.failed"],
                ),
            ]
        )

    async def test_event_filtering(self, config_with_webhooks):
        """Only webhooks subscribed to the event should be called."""
        with patch("server.webhooks._deliver", new_callable=AsyncMock) as mock_deliver:
            await fire_webhooks(config_with_webhooks, "job.completed", {"filename": "test.pdf"})
            # hook1 and hook3 subscribe to job.completed
            assert mock_deliver.call_count == 2
            urls = [call.args[0] for call in mock_deliver.call_args_list]
            assert "https://example.com/hook1" in urls
            assert "https://example.com/hook3" in urls
            assert "https://example.com/hook2" not in urls

    async def test_event_filtering_failed(self, config_with_webhooks):
        """Only webhooks subscribed to job.failed should fire."""
        with patch("server.webhooks._deliver", new_callable=AsyncMock) as mock_deliver:
            await fire_webhooks(config_with_webhooks, "job.failed", {"error": "boom"})
            assert mock_deliver.call_count == 2
            urls = [call.args[0] for call in mock_deliver.call_args_list]
            assert "https://example.com/hook2" in urls
            assert "https://example.com/hook3" in urls

    async def test_signature_header_included_when_secret_set(self, config_with_webhooks):
        """Webhook with secret should include X-Koji-Signature header."""
        with patch("server.webhooks._deliver", new_callable=AsyncMock) as mock_deliver:
            await fire_webhooks(config_with_webhooks, "job.completed", {"filename": "test.pdf"})
            # Find the call for hook1 (has secret)
            for call in mock_deliver.call_args_list:
                url, headers, body = call.args
                if url == "https://example.com/hook1":
                    assert "X-Koji-Signature" in headers
                    assert "X-Koji-Event" in headers
                    assert headers["X-Koji-Event"] == "job.completed"
                    # Verify signature is correct
                    expected_sig = hmac.new(b"test-secret", body, hashlib.sha256).hexdigest()
                    assert headers["X-Koji-Signature"] == expected_sig

    async def test_no_signature_header_when_no_secret(self, config_with_webhooks):
        """Webhook without secret should not include X-Koji-Signature header."""
        with patch("server.webhooks._deliver", new_callable=AsyncMock) as mock_deliver:
            await fire_webhooks(config_with_webhooks, "job.failed", {"error": "oops"})
            for call in mock_deliver.call_args_list:
                url, headers, body = call.args
                if url == "https://example.com/hook2":
                    assert "X-Koji-Signature" not in headers
                    assert headers["X-Koji-Event"] == "job.failed"

    async def test_no_webhooks_configured(self):
        """No error when config has no webhooks."""
        config = KojiConfig()
        # Should not raise
        await fire_webhooks(config, "job.completed", {"filename": "test.pdf"})

    async def test_delivery_failure_does_not_raise(self, config_with_webhooks):
        """Webhook delivery failures should be swallowed."""
        with patch(
            "server.webhooks._deliver",
            new_callable=AsyncMock,
            side_effect=Exception("network error"),
        ):
            # Should not raise
            await fire_webhooks(config_with_webhooks, "job.completed", {"filename": "test.pdf"})

    async def test_payload_body_is_json(self, config_with_webhooks):
        """The body passed to _deliver should be valid JSON."""
        with patch("server.webhooks._deliver", new_callable=AsyncMock) as mock_deliver:
            await fire_webhooks(config_with_webhooks, "job.completed", {"filename": "x.pdf"})
            for call in mock_deliver.call_args_list:
                body = call.args[2]
                parsed = json.loads(body)
                assert parsed["event"] == "job.completed"
                assert parsed["data"]["filename"] == "x.pdf"
