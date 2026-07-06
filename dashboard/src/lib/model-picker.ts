/**
 * Shared shape + helper for capability-filtered model pickers.
 *
 * The dashboard has two "choose a model" dropdowns (pipeline create,
 * schema build toolbar). Both read from /api/credentials and flatten
 * the nested `models` array into a picker-friendly list scoped to a
 * capability tag. The `id` returned is a tenant_models.id — the same
 * value pipelines.model_provider_id and the schema build `model` param
 * already accept.
 */

import type { ModelCapability } from "./model-capabilities";

export interface CredentialResponse {
  id: string;
  displayName: string;
  provider: string;
  status: string;
  models: {
    id: string;
    model: string;
    capability: ModelCapability;
    displayName: string | null;
    status: string;
  }[];
}

export interface ModelPickerOption {
  /** tenant_models.id — post this back to the API */
  id: string;
  /** Credential's display name — "OpenAI primary" */
  credentialName: string;
  provider: string;
  /** The raw model id — "gpt-4o-mini" */
  model: string;
  capability: ModelCapability;
  /** Preformatted label for a <option> — "OpenAI primary — gpt-4o-mini" */
  label: string;
}

/**
 * Flatten a credentials response into a filtered picker list. Skips
 * credentials that are soft-disabled or models that aren't active or
 * don't match the requested capability.
 */
export function toPickerOptions(
  credentials: CredentialResponse[] | null | undefined,
  capability: ModelCapability = "chat",
): ModelPickerOption[] {
  const out: ModelPickerOption[] = [];
  for (const cred of credentials ?? []) {
    if (cred.status !== "active") continue;
    for (const m of cred.models) {
      if (m.status !== "active") continue;
      if (m.capability !== capability) continue;
      out.push({
        id: m.id,
        credentialName: cred.displayName,
        provider: cred.provider,
        model: m.model,
        capability: m.capability,
        label: `${cred.displayName} — ${m.model}`,
      });
    }
  }
  return out;
}
