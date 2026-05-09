import { describe, it, expect, vi } from "vitest";
import { splitStep } from "../steps/split";
import type { StepContext } from "../steps/types";

function makeCtx(overrides: Partial<StepContext> = {}): StepContext {
  return {
    tenantId: "t-1",
    documentId: "doc-1",
    jobId: "job-1",
    document: {
      filename: "submission.pdf",
      storageKey: "uploads/submission.pdf",
      mimeType: "application/pdf",
      pageCount: 10,
      contentHash: "abc123",
    },
    stepOutputs: {},
    db: null,
    storage: null,
    endpoints: null,
    queue: null,
    ...overrides,
  };
}

function withPageHeaders(
  ctx: StepContext,
  headers: Array<{ page: number; header_text: string }>,
): StepContext {
  return {
    ...ctx,
    stepOutputs: {
      ...ctx.stepOutputs,
      __page_headers: {
        stepId: "__page_headers",
        stepType: "split",
        output: { headers },
        durationMs: 0,
        costUsd: 0,
      },
    },
  };
}

describe("split step — fixed method", () => {
  it("returns page groups from config", async () => {
    const result = await splitStep.run(makeCtx(), {
      method: "fixed",
      page_ranges: [
        { start: 1, end: 3, type: "coi" },
        { start: 4, end: 8, type: "policy" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.output.count).toBe(2);
    const groups = result.output.groups as any[];
    expect(groups[0]).toMatchObject({ startPage: 1, endPage: 3, type: "coi" });
    expect(groups[1]).toMatchObject({ startPage: 4, endPage: 8, type: "policy" });
  });

  it("fails when no page_ranges configured", async () => {
    const result = await splitStep.run(makeCtx(), { method: "fixed" });
    expect(result.ok).toBe(false);
  });
});

describe("split step — keyword method", () => {
  const headers = [
    { page: 1, header_text: "ACORD 25 CERTIFICATE OF LIABILITY INSURANCE" },
    { page: 2, header_text: "COMMERCIAL GENERAL LIABILITY COVERAGE FORM" },
    { page: 3, header_text: "ACORD 25 CERTIFICATE OF LIABILITY INSURANCE" },
    { page: 4, header_text: "WORKERS COMPENSATION AND EMPLOYERS LIABILITY" },
    { page: 5, header_text: "CONTINUATION OF SCHEDULE" },
  ];

  it("groups pages by keyword matches", async () => {
    const ctx = withPageHeaders(makeCtx(), headers);
    const result = await splitStep.run(ctx, {
      method: "keyword",
      labels: [
        { id: "coi", keywords: ["CERTIFICATE OF LIABILITY", "ACORD 25"] },
        { id: "wc", keywords: ["WORKERS COMPENSATION"] },
      ],
    });
    expect(result.ok).toBe(true);
    const groups = result.output.groups as any[];
    expect(groups.length).toBe(3);
    expect(groups[0]).toMatchObject({ startPage: 1, endPage: 2, type: "coi" });
    expect(groups[1]).toMatchObject({ startPage: 3, endPage: 3, type: "coi" });
    expect(groups[2]).toMatchObject({ startPage: 4, endPage: 5, type: "wc" });
  });

  it("fails with no labels", async () => {
    const ctx = withPageHeaders(makeCtx(), headers);
    const result = await splitStep.run(ctx, { method: "keyword", labels: [] });
    expect(result.ok).toBe(false);
  });
});

describe("split step — llm method", () => {
  it("returns groups from LLM response", async () => {
    const mockProvider = {
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          { start_page: 1, end_page: 2, type: "coi" },
          { start_page: 3, end_page: 5, type: "policy_dec" },
        ]),
      ),
    };

    const headers = [
      { page: 1, header_text: "CERTIFICATE OF LIABILITY INSURANCE" },
      { page: 2, header_text: "SCHEDULE OF FORMS" },
      { page: 3, header_text: "POLICY DECLARATIONS" },
      { page: 4, header_text: "COVERAGE DETAILS" },
      { page: 5, header_text: "ENDORSEMENTS" },
    ];

    const ctx = withPageHeaders(makeCtx(), headers) as any;
    ctx.__llm_provider = mockProvider;

    const result = await splitStep.run(ctx, { method: "llm" });
    expect(result.ok).toBe(true);
    const groups = result.output.groups as any[];
    expect(groups.length).toBe(2);
    expect(groups[0]).toMatchObject({ startPage: 1, endPage: 2, type: "coi" });
    expect(groups[1]).toMatchObject({ startPage: 3, endPage: 5, type: "policy_dec" });
    expect(mockProvider.generate).toHaveBeenCalledOnce();
  });

  it("fails gracefully when LLM returns invalid JSON", async () => {
    const mockProvider = {
      generate: vi.fn().mockResolvedValue("I don't understand the question"),
    };
    const headers = [{ page: 1, header_text: "some text" }];
    const ctx = withPageHeaders(makeCtx(), headers) as any;
    ctx.__llm_provider = mockProvider;

    const result = await splitStep.run(ctx, { method: "llm" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed");
  });

  it("fails when no LLM provider available", async () => {
    const headers = [{ page: 1, header_text: "some text" }];
    const ctx = withPageHeaders(makeCtx(), headers);
    const result = await splitStep.run(ctx, { method: "llm" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No LLM provider");
  });
});

describe("split step — missing page headers", () => {
  it("fails when no page headers available", async () => {
    const result = await splitStep.run(makeCtx(), { method: "llm" });
    expect(result.ok).toBe(false);
    expect(result.output.error).toContain("No page headers");
  });

  it("fails for keyword method too", async () => {
    const result = await splitStep.run(makeCtx(), {
      method: "keyword",
      labels: [{ id: "coi", keywords: ["certificate"] }],
    });
    expect(result.ok).toBe(false);
  });
});
