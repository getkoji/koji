/**
 * HTTP-level integration test for POST /api/classify.
 *
 * Drives the real route through the real middleware chain (requires("job:run"))
 * and the real pdfjs text extraction — only auth grants and infra handles are
 * seeded directly, since the deterministic tiers need neither a DB nor a model
 * provider. Proves the endpoint works end-to-end at the HTTP boundary: multipart
 * parsing → config load → cascade → wire response.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";
import { classify } from "./classify";

async function makePdf(pages: string[][]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = pdf.addPage([612, 792]);
    let y = 720;
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 12, font });
      y -= 20;
    }
  }
  return Buffer.from(await pdf.save());
}

/** Real app with the route mounted; auth grants + infra handles pre-seeded. */
function testApp() {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("grants", new Set(["job:run"]) as any);
    c.set("tenantId", "t_test");
    c.set("principal", { userId: "u_test" } as any);
    c.set("db", {} as any);
    c.set("storage", {} as any);
    c.set("parseProvider", {} as any); // no pageImages → vision tier skipped
    await next();
  });
  app.route("/api/classify", classify);
  return app;
}

const CONFIG = `
classify:
  max_tier: 2
  on_unknown: return
classes:
  invoice:
    keywords: ["invoice", "amount due", "remit to"]
  policy:
    keywords: ["declarations", "insuring agreement"]
`;

async function post(app: Hono<Env>, buf: Buffer, config: string) {
  const form = new FormData();
  form.append("file", new File([buf], "packet.pdf", { type: "application/pdf" }));
  form.append("config", config);
  return app.request("/api/classify", { method: "POST", body: form });
}

describe("POST /api/classify (integration)", () => {
  it("classifies via the free deterministic path, ignoring a cover page", async () => {
    const buf = await makePdf([
      ["ROUTING SLIP", "please deliver"],
      ["INVOICE 42", "amount due 1200.00", "remit to Acme Supply"],
    ]);
    const res = await post(testApp(), buf, CONFIG);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.label).toBe("invoice");
    expect(body.method).toBe("keyword");
    expect(body.tier_used).toBe(2);
    expect(body.evidence_page).toBe(2);
  });

  it("returns 200 unknown when nothing matches and on_unknown is return", async () => {
    const buf = await makePdf([["totally unrelated content about zebras"]]);
    const res = await post(testApp(), buf, CONFIG);
    expect(res.status).toBe(200);
    expect((await res.json()).label).toBe("unknown");
  });

  it("returns 422 when nothing matches and on_unknown is reject", async () => {
    const buf = await makePdf([["totally unrelated content about zebras"]]);
    const res = await post(testApp(), buf, CONFIG.replace("on_unknown: return", "on_unknown: reject"));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("no class matched");
  });

  it("rejects an invalid config with 400", async () => {
    const buf = await makePdf([["invoice amount due"]]);
    const res = await post(testApp(), buf, "classes: {}");
    expect(res.status).toBe(400);
  });

  it("rejects a missing file with 400", async () => {
    const form = new FormData();
    form.append("config", CONFIG);
    const res = await testApp().request("/api/classify", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });
});
