import { createHmac } from 'node:crypto';
import type { StepImplementation } from './types';

interface WebhookConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  payload?: 'result' | 'document' | 'metadata' | 'custom';
  custom_payload?: Record<string, unknown>;
  signing_secret?: string;
  retry?: {
    max_attempts?: number;
    backoff?: 'exponential' | 'linear';
  };
  timeout_seconds?: number;
}

/**
 * Webhook step — sends pipeline data to an external HTTP endpoint.
 *
 * Supports multiple payload modes, HMAC-SHA256 signing, and configurable retry.
 */
export const webhookStep: StepImplementation = {
  type: 'webhook',
  async run(ctx, config) {
    const cfg = config as WebhookConfig;

    if (!cfg.url) {
      return { ok: false, output: {}, costUsd: 0, error: 'Webhook URL is required' };
    }

    // Build payload from upstream step outputs
    const payload = buildPayload(cfg, ctx);
    const body = JSON.stringify(payload);
    const method = (cfg.method || 'POST').toUpperCase();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'koji-webhook/1.0',
      ...(cfg.headers || {}),
    };

    // HMAC-SHA256 signing
    if (cfg.signing_secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signaturePayload = `${timestamp}.${body}`;
      const signature = createHmac('sha256', cfg.signing_secret)
        .update(signaturePayload)
        .digest('hex');
      headers['X-Koji-Signature'] = `t=${timestamp},v1=${signature}`;
    }

    // Retry logic
    const maxAttempts = cfg.retry?.max_attempts ?? 3;
    const timeoutMs = (cfg.timeout_seconds ?? 30) * 1000;
    let lastError: string | undefined;
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(cfg.url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timer);
        lastStatus = response.status;

        if (response.ok) {
          let responseBody: string | undefined;
          try {
            responseBody = await response.text();
          } catch {
            // response body isn't critical
          }

          return {
            ok: true,
            output: {
              status_code: response.status,
              response_body: responseBody?.substring(0, 1000),
              attempts: attempt,
            },
            costUsd: 0,
          };
        }

        // Non-2xx: fail immediately on 4xx (non-retryable), retry on 5xx
        if (response.status < 500) {
          return {
            ok: false,
            output: { status_code: response.status, attempts: attempt },
            costUsd: 0,
            error: `Webhook returned ${response.status}`,
          };
        }

        lastError = `HTTP ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      // Backoff before retry
      if (attempt < maxAttempts) {
        const delayMs =
          cfg.retry?.backoff === 'linear'
            ? attempt * 1000
            : Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return {
      ok: false,
      output: { status_code: lastStatus, attempts: maxAttempts },
      costUsd: 0,
      error: `Webhook failed after ${maxAttempts} attempts: ${lastError}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPayload(
  cfg: WebhookConfig,
  ctx: import('./types').StepContext,
): Record<string, unknown> {
  switch (cfg.payload || 'result') {
    case 'result': {
      // Find the most recent extract step's output
      const extractOutput = Object.values(ctx.stepOutputs)
        .reverse()
        .find((o) => o.output?.fields || o.output?._delegate === 'extraction_pipeline');
      return {
        document_id: ctx.documentId,
        job_id: ctx.jobId,
        tenant_id: ctx.tenantId,
        extraction: extractOutput?.output || {},
        document: {
          filename: ctx.document.filename,
          mime_type: ctx.document.mimeType,
          page_count: ctx.document.pageCount,
        },
      };
    }
    case 'document':
      return {
        document_id: ctx.documentId,
        filename: ctx.document.filename,
        storage_key: ctx.document.storageKey,
        mime_type: ctx.document.mimeType,
        page_count: ctx.document.pageCount,
        content_hash: ctx.document.contentHash,
      };
    case 'metadata':
      return {
        document_id: ctx.documentId,
        job_id: ctx.jobId,
        tenant_id: ctx.tenantId,
        step_outputs: Object.fromEntries(
          Object.entries(ctx.stepOutputs).map(([id, o]) => [id, o.output]),
        ),
      };
    case 'custom':
      return cfg.custom_payload || {};
    default:
      return { document_id: ctx.documentId };
  }
}
