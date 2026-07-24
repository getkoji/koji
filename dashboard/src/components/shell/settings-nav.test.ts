/**
 * Guard: the workspace API Keys link must render even when a host sets
 * `hideDefaultNav`.
 *
 * `hideDefaultNav` means "this host replaces General/Members" — on the hosted
 * console those are Clerk's OrganizationProfile, so koji's own versions are
 * suppressed. API keys are a Koji resource with no Clerk equivalent. When the
 * link was first added it went inside that block, which hid it on the console
 * while looking correct in OSS: the page existed, the platform re-export
 * existed, and the only way to reach it was typing the URL (oss-483).
 *
 * A source-level check because there is no jsdom/react-testing-library here
 * (see vitest.config.ts) — and because the failure is precisely "renders in
 * one build, not the other", which no OSS-only render test would catch.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SIDEBAR = path.resolve(__dirname, "./Sidebar.tsx");

/**
 * Extract the JSX guarded by `!settingsExtensions.hideDefaultNav && (`, by
 * scanning forward to the matching close paren.
 */
function hideDefaultNavBlock(src: string): string {
  const marker = "{!settingsExtensions.hideDefaultNav && (";
  const start = src.indexOf(marker);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start + marker.length - 1; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
  }
  return src.slice(start);
}

describe("workspace settings nav", () => {
  const src = readFileSync(SIDEBAR, "utf8");

  it("links to the workspace API Keys page", () => {
    expect(src).toContain("/settings/api-keys");
  });

  it("does not hide the API Keys link behind hideDefaultNav", () => {
    const guarded = hideDefaultNavBlock(src);
    // Sanity: we actually located the block (so the test can fail for the
    // right reason rather than trivially passing on an empty string).
    expect(guarded).toContain("/settings/members");
    expect(guarded).not.toContain("/settings/api-keys");
  });
});
