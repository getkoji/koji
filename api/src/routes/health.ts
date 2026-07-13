import { Hono } from "hono";

export const health = new Hono();

health.get("/", (c) => {
  return c.json({ ok: true, version: "0.80.1" });
});

health.get("/ready", (c) => {
  return c.json({ ok: true, version: "0.80.1" });
});
