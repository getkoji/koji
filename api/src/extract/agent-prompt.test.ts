import { describe, it, expect } from "vitest";
import { buildTunePrompt, parseAgentResponse, extractProposedYaml, type TuneFieldReport } from "./agent-prompt";

describe("extractProposedYaml — tolerate the formats models actually emit", () => {
  const schema = "name: invoice\nfields:\n  currency:\n    type: string";

  it("reads a <yaml> tag block", () => {
    expect(extractProposedYaml(`<yaml>\n${schema}\n</yaml>\n<explanation>x</explanation>`)).toBe(schema);
  });

  it("reads a ```yaml fenced block (what gpt-4o-mini returns on the tune prompt)", () => {
    // Regression: the tune endpoint always returned proposedYaml=null because
    // the model fences its YAML instead of using the <yaml> tag (found live).
    expect(extractProposedYaml("```yaml\n" + schema + "\n```\n<explanation>x</explanation>")).toBe(schema);
  });

  it("reads a ```yml fence too", () => {
    expect(extractProposedYaml("```yml\n" + schema + "\n```")).toBe(schema);
  });

  it("reads a bare ``` fence only when it looks like a schema", () => {
    expect(extractProposedYaml("```\n" + schema + "\n```")).toBe(schema);
    expect(extractProposedYaml("```\nsome shell command\n```")).toBeNull();
  });

  it("prefers the <yaml> tag over a fence when both appear", () => {
    const tagged = "name: tagged\nfields: {}";
    expect(extractProposedYaml(`<yaml>\n${tagged}\n</yaml>\n\`\`\`yaml\nname: fenced\n\`\`\``)).toBe(tagged);
  });

  it("parseAgentResponse now surfaces fenced yaml (was null)", () => {
    const r = parseAgentResponse("```yaml\n" + schema + "\n```\n<explanation>added hint</explanation>");
    expect(r.yaml).toBe(schema);
    expect(r.explanation).toBe("added hint");
  });
});

describe("buildTunePrompt — the diagnosis→prompt bridge", () => {
  const failing: TuneFieldReport[] = [
    {
      name: "policy_number",
      expected: "PN-12345",
      got: "(nothing)",
      routingHint: "model never saw the answer — routing miss (fix look_in / add hints)",
    },
    {
      name: "premium",
      expected: "1200",
      got: "12000",
      routingHint: "model saw the text but chose the wrong value (fix the field description/hint)",
    },
  ];

  it("embeds the measured report: accuracy, each failing field's expected/got, and routing hint", () => {
    const p = buildTunePrompt("name: policy\nfields: {}", {
      accuracy: 60,
      failing,
      markdown_head: "POLICY DECLARATIONS ... premium $1,200",
    });
    expect(p).toContain("Accuracy on this document: 60.0%");
    expect(p).toContain("policy_number");
    expect(p).toContain("expected: PN-12345");
    expect(p).toContain("extracted: (nothing)");
    expect(p).toContain("premium");
    expect(p).toContain("expected: 1200");
    expect(p).toContain("extracted: 12000");
    // Both routing diagnoses surface so the model knows routing-fix vs desc-fix.
    expect(p).toContain("routing miss");
    expect(p).toContain("chose the wrong value");
  });

  it("includes the current schema and the document excerpt", () => {
    const p = buildTunePrompt("name: policy\nfields:\n  premium:\n    type: number", {
      accuracy: 50,
      failing,
      markdown_head: "SOME DOC TEXT HERE",
    });
    expect(p).toContain("<current_schema>");
    expect(p).toContain("type: number");
    expect(p).toContain("<document_excerpt>");
    expect(p).toContain("SOME DOC TEXT HERE");
    // Response-format contract the parser depends on.
    expect(p).toContain("<yaml>");
    expect(p).toContain("<explanation>");
  });

  it("handles an empty schema and no-excerpt gracefully", () => {
    const p = buildTunePrompt("", { accuracy: 0, failing: [], markdown_head: "" });
    expect(p).toContain("(empty)");
    expect(p).toContain("(unavailable)");
    expect(p).toContain("(no failing fields)");
  });
});
