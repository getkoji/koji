/**
 * HTTP-level integration test for POST /api/classify **by classifier slug**.
 *
 * Companion to ./classify.integration.test.ts, which covers the inline-config
 * form. This file needs `withRLS` mocked so `resolveClassifierConfig` reads
 * queued rows instead of a live DB — hence a separate file, so the inline tests
 * keep running against the unmocked module.
 *
 * Everything below the resolution step is real: the queued `yamlSource` is
 * compiled by the real loader and run through the real cascade over a real PDF.
 * So this proves the resolved config actually classifies, not merely that a
 * lookup returned a row.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";

vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, withRLS: (db: any, _scope: any, fn: (tx: any) => Promise<any>) => fn(db) };
});

const { classify } = await import("./classify");

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

const VERSION_ID = "00000000-0000-0000-0000-0000000000a1";

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

/** Chainable/awaitable select stub; each call shifts the next queued result. */
function dbForSlug(rows: unknown[][]) {
  const queue = [...rows];
  const chain = (): any => {
    const result = queue.shift() ?? [];
    const c: any = {
      from: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => Promise.resolve(result),
      then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    };
    return c;
  };
  return { select: () => chain() } as any;
}

function appWithDb(db: any) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("grants", new Set(["job:run"]) as any);
    c.set("tenantId", "t_test");
    c.set("principal", { userId: "u_test" } as any);
    c.set("db", db);
    c.set("storage", {} as any);
    c.set("parseProvider", {} as any); // no pageImages → vision tier skipped
    await next();
  });
  app.route("/api/classify", classify);
  return app;
}

function postNamed(app: Hono<Env>, buf: Buffer, fields: Record<string, string>) {
  const form = new FormData();
  form.append("file", new File([buf], "packet.pdf", { type: "application/pdf" }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return app.request("/api/classify", { method: "POST", body: form });
}

describe("POST /api/classify — by classifier slug", () => {
  it("resolves the released version by slug and classifies with it", async () => {
    const buf = await makePdf([["INVOICE 42", "amount due 1200.00", "remit to Acme Supply"]]);
    // resolveClassifierConfig with no pin: classifier row, then the version row.
    const db = dbForSlug([
      [{ id: "clf-1", currentVersionId: VERSION_ID }],
      [{ yamlSource: CONFIG, major: 0, minor: 0, patch: 3, prerelease: null }],
    ]);
    const res = await postNamed(appWithDb(db), buf, { classifier: "document_type" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.label).toBe("invoice");
    expect(body.method).toBe("keyword");
    // Echoed so a consumer can see which version ran after a re-tune.
    expect(body.classifier).toBe("document_type");
    expect(body.classifier_version).toBe("v0.0.3");
  });

  it("404s for an unknown slug instead of classifying against nothing", async () => {
    const buf = await makePdf([["invoice amount due"]]);
    const res = await postNamed(appWithDb(dbForSlug([[]])), buf, { classifier: "nope" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toContain("not found");
  });

  it("404s on an unresolvable pin rather than silently running the live release", async () => {
    const buf = await makePdf([["invoice amount due"]]);
    // With a pin, resolveClassifierConfig lists all versions and requires
    // exactly one match; none of these is v9.9.9.
    const db = dbForSlug([
      [{ id: "clf-1", currentVersionId: VERSION_ID }],
      [{ id: VERSION_ID, major: 0, minor: 0, patch: 3, prerelease: null }],
    ]);
    const res = await postNamed(appWithDb(db), buf, {
      classifier: "document_type",
      classifier_version: "v9.9.9",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toContain("v9.9.9");
  });

  it("runs an explicitly pinned version", async () => {
    const buf = await makePdf([["INVOICE 42", "amount due 1200.00", "remit to Acme Supply"]]);
    const db = dbForSlug([
      [{ id: "clf-1", currentVersionId: VERSION_ID }],
      [{ id: VERSION_ID, major: 0, minor: 0, patch: 3, prerelease: null }],
      [{ yamlSource: CONFIG, major: 0, minor: 0, patch: 3, prerelease: null }],
    ]);
    const res = await postNamed(appWithDb(db), buf, {
      classifier: "document_type",
      classifier_version: "v0.0.3",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.label).toBe("invoice");
    expect(body.classifier_version).toBe("v0.0.3");
  });

  it("400s when both an inline config and a slug are supplied", async () => {
    const buf = await makePdf([["invoice amount due"]]);
    const res = await postNamed(appWithDb(dbForSlug([])), buf, {
      classifier: "document_type",
      config: CONFIG,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("not both");
  });

  it("400s when neither a config nor a slug is supplied", async () => {
    const buf = await makePdf([["invoice amount due"]]);
    const res = await postNamed(appWithDb(dbForSlug([])), buf, {});
    expect(res.status).toBe(400);
  });
});
