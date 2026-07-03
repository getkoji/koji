import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { extractFields } from "./src/extract/pipeline";
import { createProvider } from "./src/extract/providers";

const markdown = readFileSync("/private/tmp/claude-501/-Users-trankly-dev-koji-playbook/7e88c297-49c4-4157-aa7b-1528d5efbfd5/scratchpad/diag/tailored.md", "utf8");
const schemaDef = parseYaml(readFileSync("/Users/trankly/dev/superkey/superkey/.worktrees/koji-family-routing-poc/koji/rnd/schemas/rnd_policy_auto_owners.yaml", "utf8"));
const provider = createProvider("openai/gpt-4o-mini");
const r = await extractFields(markdown, schemaDef, provider, "openai/gpt-4o-mini");
const covs = (r.extracted.coverages ?? []) as Array<Record<string, unknown>>;
console.log("LOCAL coverages rows:", covs.length, covs.map(c => c.coverage_code));
console.log("warnings:", r.normalization?.warnings?.slice(0, 6));
