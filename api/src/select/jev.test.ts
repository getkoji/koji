/**
 * Unit tests for the hosted adapter's own behaviour: what it puts on the wire,
 * and the two things it refuses to do (send an oversized state, carry a
 * missing credential into a call).
 *
 * The contract itself is covered by the parity suite.
 */

import { describe, expect, it, vi } from "vitest";
import {
  JEV_API_URL,
  JEV_DEFAULT_MODEL,
  JEV_STATE_TOKEN_BUDGET,
  JevAdjudicateProvider,
  JevHttpError,
  JevSelectProvider,
  typesafeKeyFromEnv,
} from "./jev";
import { disableAdjudication, enableAdjudication } from "./adjudicate";
import {
  ABSTAIN,
  SelectRequestError,
  SelectUnavailableError,
  type SelectCandidate,
} from "./types";
import { QUESTION_KEY } from "./system-one";

const OPTIONS: SelectCandidate[] = [
  { value: "2026-01-04", raw: "January 4, 2026", offset: 0 },
  { value: "2026-02-03", offset: 10 },
];

function okFetch(answer: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: "jev-1.13.0",
      answers: { [QUESTION_KEY]: answer },
      usage: { input_tokens: 99 },
    }),
    text: async () => "",
  })) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

function errFetch(status: number, body: string) {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  })) as unknown as typeof fetch;
}

describe("the request it puts on the wire", () => {
  it("posts one Choice question to the System-1 endpoint with Bearer auth", async () => {
    const fetchImpl = okFetch({
      choice: "2026-02-03",
      probabilities: { "2026-02-03": 0.9, "2026-01-04": 0.1 },
      confidence: 0.7,
    });
    await new JevSelectProvider({ apiKey: "k-123", fetchImpl }).select(
      "a document",
      OPTIONS,
      "which is the due date?",
    );

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe(JEV_API_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k-123");
    const body = JSON.parse(String(init.body));
    expect(body.state).toBe("a document");
    expect(body.model).toBe(JEV_DEFAULT_MODEL);
    expect(body.questions[QUESTION_KEY].type).toBe("choice");
    expect(Object.keys(body.questions[QUESTION_KEY].criteria)).toEqual([
      "2026-01-04",
      "2026-02-03",
      ABSTAIN,
    ]);
  });

  it("reports the service's own distribution and confidence, marked calibrated", async () => {
    const fetchImpl = okFetch({
      choice: "2026-02-03",
      probabilities: { "2026-02-03": 0.9, "2026-01-04": 0.1 },
      confidence: 0.71,
    });
    const result = await new JevSelectProvider({ apiKey: "k", fetchImpl }).select(
      "doc",
      OPTIONS,
      "x",
    );
    expect(result.calibrated).toBe(true);
    expect(result.confidence).toBeCloseTo(0.71, 6);
    expect(result.probabilities["2026-02-03"]).toBeCloseTo(0.9, 6);
    expect(result.usage).toEqual({ inputTokens: 99 });
  });

  it("honours a model override", async () => {
    const fetchImpl = okFetch({ choice: "2026-01-04" });
    await new JevSelectProvider({ apiKey: "k", model: "jev-1.13.0", fetchImpl }).select(
      "doc",
      OPTIONS,
      "x",
    );
    const body = JSON.parse(
      String(
        (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]
          .body,
      ),
    );
    expect(body.model).toBe("jev-1.13.0");
  });
});

describe("what it refuses", () => {
  it("refuses to construct without a credential", () => {
    expect(() => new JevSelectProvider({ apiKey: "" })).toThrow(SelectUnavailableError);
    expect(() => new JevSelectProvider({ apiKey: "   " })).toThrow(/no TypeSafe credential/);
  });

  it("refuses an oversized state locally, before the round trip", async () => {
    const fetchImpl = okFetch({ choice: "2026-01-04" });
    const huge = "x".repeat(JEV_STATE_TOKEN_BUDGET * 6);
    await expect(
      new JevSelectProvider({ apiKey: "k", fetchImpl }).select(huge, OPTIONS, "x"),
    ).rejects.toThrow(SelectRequestError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces an HTTP failure with its status", async () => {
    await expect(
      new JevSelectProvider({ apiKey: "k", fetchImpl: errFetch(429, "slow down") }).select(
        "doc",
        OPTIONS,
        "x",
      ),
    ).rejects.toThrow(JevHttpError);
    await expect(
      new JevSelectProvider({ apiKey: "k", fetchImpl: errFetch(401, "bad key") }).select(
        "doc",
        OPTIONS,
        "x",
      ),
    ).rejects.toThrow(/Jev 401/);
  });
});

describe("JevAdjudicateProvider", () => {
  it("posts a Noul question and reads P(true) as the verdict", async () => {
    enableAdjudication("unit test");
    try {
      const fetchImpl = okFetch({ type: "noul", noul: 0.93, answer_confidence: 0.93 });
      const result = await new JevAdjudicateProvider({ apiKey: "k", fetchImpl }).adjudicate(
        "Delaware",
        "State of Delaware",
        { name: "state" },
      );
      expect(result).toMatchObject({ equivalent: true, calibrated: true });
      expect(result.confidence).toBeCloseTo(0.93, 6);
      const body = JSON.parse(
        String(
          (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]
            .body,
        ),
      );
      expect(body.questions[QUESTION_KEY].type).toBe("noul");
    } finally {
      disableAdjudication();
    }
  });

  it("reads a low P(true) as a confident 'not equivalent'", async () => {
    enableAdjudication("unit test");
    try {
      const fetchImpl = okFetch({ type: "noul", noul: 0.04 });
      const result = await new JevAdjudicateProvider({ apiKey: "k", fetchImpl }).adjudicate(
        "Delaware",
        "Nevada",
        { name: "state" },
      );
      expect(result.equivalent).toBe(false);
      // Confidence is in the reported answer, not in "true".
      expect(result.confidence).toBeCloseTo(0.96, 6);
    } finally {
      disableAdjudication();
    }
  });

  it("throws when no probability came back, instead of inventing a verdict", async () => {
    enableAdjudication("unit test");
    try {
      const fetchImpl = okFetch({ type: "noul" });
      await expect(
        new JevAdjudicateProvider({ apiKey: "k", fetchImpl }).adjudicate("a", "b", { name: "f" }),
      ).rejects.toThrow(/carried no probability/);
    } finally {
      disableAdjudication();
    }
  });

  it("is blocked by the offline guard when not armed", async () => {
    disableAdjudication();
    delete process.env.KOJI_ADJUDICATE;
    const fetchImpl = okFetch({ type: "noul", noul: 1 });
    await expect(
      new JevAdjudicateProvider({ apiKey: "k", fetchImpl }).adjudicate("a", "b", { name: "f" }),
    ).rejects.toThrow(/offline-only/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("typesafeKeyFromEnv", () => {
  const saved = process.env.TYPESAFE_API_KEY;
  const savedAlt = process.env.KOJI_TYPESAFE_API_KEY;

  it("reads either spelling and trims, else null", () => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.KOJI_TYPESAFE_API_KEY;
    try {
      expect(typesafeKeyFromEnv()).toBeNull();
      process.env.TYPESAFE_API_KEY = "  abc  ";
      expect(typesafeKeyFromEnv()).toBe("abc");
      delete process.env.TYPESAFE_API_KEY;
      process.env.KOJI_TYPESAFE_API_KEY = "def";
      expect(typesafeKeyFromEnv()).toBe("def");
      process.env.KOJI_TYPESAFE_API_KEY = "   ";
      expect(typesafeKeyFromEnv()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved;
      if (savedAlt === undefined) delete process.env.KOJI_TYPESAFE_API_KEY;
      else process.env.KOJI_TYPESAFE_API_KEY = savedAlt;
    }
  });
});
