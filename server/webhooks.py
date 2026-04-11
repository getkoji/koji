"""Webhook delivery for Koji events."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
from datetime import UTC, datetime

import httpx

from server.config import KojiConfig

logger = logging.getLogger(__name__)


def _build_payload(event: str, data: dict) -> dict:
    """Build the webhook payload envelope."""
    return {
        "event": event,
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _sign_payload(body: bytes, secret: str) -> str:
    """Compute HMAC-SHA256 signature of the body."""
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def _deliver(url: str, headers: dict, body: bytes) -> None:
    """POST the webhook payload to a single URL."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, content=body, headers=headers)
            if resp.status_code >= 400:
                logger.warning("Webhook delivery to %s returned %d", url, resp.status_code)
    except Exception as exc:
        logger.warning("Webhook delivery to %s failed: %s", url, exc)


async def fire_webhooks(config: KojiConfig, event: str, data: dict) -> None:
    """Fire webhooks for a given event. Non-blocking — meant to be wrapped in create_task."""
    payload = _build_payload(event, data)
    body = json.dumps(payload).encode()

    tasks: list[asyncio.Task] = []
    for wh in config.webhooks:
        if event not in wh.events:
            continue
        headers = {
            "Content-Type": "application/json",
            "X-Koji-Event": event,
        }
        if wh.secret:
            headers["X-Koji-Signature"] = _sign_payload(body, wh.secret)
        tasks.append(asyncio.create_task(_deliver(wh.url, headers, body)))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
