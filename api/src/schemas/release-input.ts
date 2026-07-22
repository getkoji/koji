/**
 * What a `POST /release` request body actually asked to release.
 *
 * The release routes used to do `body.yaml ?? storedDraft` over a body parsed
 * with `.catch(() => ({}))`. Three different situations collapsed into "use the
 * draft":
 *
 *   - no body at all — the intended "release my stored draft" flow,
 *   - a body whose YAML arrived under a key the route doesn't read (the schema
 *     route takes `yaml`, its classifier sibling takes `yaml_source`, so
 *     cross-wiring the two is easy),
 *   - a body that wasn't valid JSON at all.
 *
 * The last two silently released *stored draft content the caller never sent*.
 * Observed in production: a 52 KB payload posted under the wrong key released a
 * 3.8 KB draft, and the rollback guard then reported a content match against
 * that draft — advice that, if followed, would have activated the stub.
 *
 * So the fallback is now narrow: only a genuinely absent body means "the
 * draft". Anything else the caller sent that we cannot interpret is an error,
 * because for a `schema:deploy` endpoint, guessing is how you ship the wrong
 * schema.
 */

/** Keys a release body may carry. Anything else is a typo or a wrong-sibling call. */
const KNOWN_KEYS = new Set(["yaml", "yaml_source", "allow_reactivate"]);

export type ReleaseInput =
  /** Release this exact YAML. */
  | { kind: "yaml"; yaml: string; allowReactivate: boolean }
  /** No body — release whatever draft is stored. */
  | { kind: "draft"; allowReactivate: boolean }
  /** Reject: `message` is caller-facing. */
  | { kind: "invalid"; message: string };

/**
 * Interpret a raw request body.
 *
 * @param rawBody the request body as text; empty/whitespace means no body.
 */
export function parseReleaseInput(rawBody: string): ReleaseInput {
  if (rawBody.trim() === "") return { kind: "draft", allowReactivate: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Previously swallowed into `{}` — i.e. a corrupted payload released the
    // draft. A body that cannot be read is never an instruction.
    return { kind: "invalid", message: "Invalid JSON body." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", message: "Request body must be a JSON object." };
  }

  const body = parsed as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    return {
      kind: "invalid",
      message:
        `Unrecognized field(s): ${unknown.join(", ")}. ` +
        `Send the YAML as \`yaml\` (\`yaml_source\` is accepted), or omit the body entirely to release the stored draft.`,
    };
  }

  const allowReactivate = body.allow_reactivate === true;

  // Key PRESENCE, not value — `{"yaml": null}` is a caller talking about
  // content and getting it wrong, which must fail loudly. Testing the value
  // with `??` would treat it as "said nothing" and fall through to the draft,
  // reintroducing the exact substitution this module exists to prevent.
  const hasYamlKey = "yaml" in body || "yaml_source" in body;
  if (!hasYamlKey) {
    // A body with only control fields still means "release the draft" — the
    // caller said nothing about content, so nothing was substituted for them.
    return { kind: "draft", allowReactivate };
  }
  const supplied = body.yaml ?? body.yaml_source;
  if (typeof supplied !== "string" || supplied.trim() === "") {
    return { kind: "invalid", message: "`yaml` must be a non-empty string." };
  }
  return { kind: "yaml", yaml: supplied, allowReactivate };
}
