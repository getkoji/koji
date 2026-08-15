/**
 * When an external identity directory is wired, membership and invitation
 * changes have to reach it — a Koji-only write leaves the two sides disagreeing
 * about who belongs to the tenant, and the directory is the side that decides
 * whether someone can sign in.
 *
 * These mount the real routers over a fake DB so the assertions are about the
 * handlers' actual behaviour, not a restatement of them.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { members } from "./members";
import { invites } from "./invites";
import type { Env } from "../env";
import type { DirectoryAdapter } from "../auth/directory";
import { resolvePermissions } from "../auth/roles";

const TENANT = "t1";
const MEMBERSHIP_ID = "m1";
const TARGET_USER = "u2";

interface Calls {
  inviteMember: Array<{ tenantId: string; email: string; invitedByUserId: string; roles: string[] }>;
  revokeInvite: Array<{ tenantId: string; email: string }>;
  removeMember: Array<{ tenantId: string; userId: string }>;
  deletes: number;
  inserts: unknown[];
  emails: string[];
}

function createDirectory(calls: Calls): DirectoryAdapter {
  return {
    async inviteMember(input) {
      calls.inviteMember.push(input);
    },
    async revokeInvite(input) {
      calls.revokeInvite.push(input);
    },
    async removeMember(input) {
      calls.removeMember.push(input);
    },
  };
}

/**
 * Mount a router with a fake DB. `rows` is the result handed to every SELECT —
 * both handlers under test do a single lookup before the write.
 */
function createApp(opts: {
  router: Hono<Env>;
  rows: unknown[];
  directory: DirectoryAdapter | null;
  calls: Calls;
}) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const chain: any = {
      from: () => chain,
      innerJoin: () => chain,
      orderBy: () => chain,
      where: () => chain,
      limit: () => opts.rows,
      then: (onF: (v: unknown) => unknown) => Promise.resolve(opts.rows).then(onF),
    };

    c.set("db", {
      select: () => chain,
      insert: () => ({
        values: (v: unknown) => {
          opts.calls.inserts.push(v);
          return Promise.resolve();
        },
      }),
      delete: () => ({
        where: () => {
          opts.calls.deletes++;
          return Promise.resolve();
        },
      }),
    } as any);

    c.set("principal", { userId: "u1", email: "admin@koji.dev", name: "Admin" } as any);
    c.set("tenantId", TENANT);
    c.set("roles", ["owner"]);
    c.set("grants", resolvePermissions(["owner"]));
    c.set("directory", opts.directory);
    c.set("appUrl", "https://console.example.test");
    c.set("emailSender", {
      async send(msg: any) {
        opts.calls.emails.push(msg.to);
        return true;
      },
    } as any);
    await next();
  });

  app.route("/", opts.router);
  return app;
}

function emptyCalls(): Calls {
  return {
    inviteMember: [],
    revokeInvite: [],
    removeMember: [],
    deletes: 0,
    inserts: [],
    emails: [],
  };
}

describe("member removal with a directory", () => {
  let calls: Calls;
  const membershipRow = [
    { id: MEMBERSHIP_ID, userId: TARGET_USER, roles: ["viewer"], isShadow: false },
  ];

  beforeEach(() => {
    calls = emptyCalls();
  });

  it("removes the member from the directory as well as Koji", async () => {
    const app = createApp({
      router: members,
      rows: membershipRow,
      directory: createDirectory(calls),
      calls,
    });

    const res = await app.request(`/${MEMBERSHIP_ID}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    // Without this the user stays in the upstream org and the auth middleware
    // just-in-time provisions them straight back on their next request.
    expect(calls.removeMember).toEqual([{ tenantId: TENANT, userId: TARGET_USER }]);
    expect(calls.deletes).toBe(1);
  });

  it("still deletes the Koji membership when no directory is wired", async () => {
    const app = createApp({ router: members, rows: membershipRow, directory: null, calls });

    const res = await app.request(`/${MEMBERSHIP_ID}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(calls.deletes).toBe(1);
    expect(calls.removeMember).toEqual([]);
  });
});

describe("invites with a directory", () => {
  let calls: Calls;

  beforeEach(() => {
    calls = emptyCalls();
  });

  it("delegates delivery to the directory instead of sending its own email", async () => {
    const app = createApp({
      router: invites,
      rows: [{ displayName: "Acme" }],
      directory: createDirectory(calls),
      calls,
    });

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@acme.test", roles: ["viewer"] }),
    });

    expect(res.status).toBe(201);
    expect(calls.inviteMember).toEqual([
      { tenantId: TENANT, email: "new@acme.test", invitedByUserId: "u1", roles: ["viewer"] },
    ]);
    // A second, Koji-minted accept link would create a membership the
    // directory has never heard of.
    expect(calls.emails).toEqual([]);
    // The row is still written — it is where the intended roles live until the
    // membership webhook applies them.
    expect(calls.inserts).toHaveLength(1);
    expect((calls.inserts[0] as any).roles).toEqual(["viewer"]);
  });

  it("sends its own invite email when no directory is wired", async () => {
    const app = createApp({
      router: invites,
      rows: [{ displayName: "Acme" }],
      directory: null,
      calls,
    });

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@acme.test", roles: ["viewer"] }),
    });

    expect(res.status).toBe(201);
    expect(calls.emails).toEqual(["new@acme.test"]);
    expect(calls.inviteMember).toEqual([]);
  });

  it("withdraws the directory invitation when revoking", async () => {
    const app = createApp({
      router: invites,
      rows: [{ id: "i1", email: "new@acme.test", acceptedAt: null }],
      directory: createDirectory(calls),
      calls,
    });

    const res = await app.request("/i1", { method: "DELETE" });

    expect(res.status).toBe(200);
    // Otherwise the invitation email still works and lands them in the org.
    expect(calls.revokeInvite).toEqual([{ tenantId: TENANT, email: "new@acme.test" }]);
    expect(calls.deletes).toBe(1);
  });

  it("refuses to revoke an accepted invite before touching the directory", async () => {
    const app = createApp({
      router: invites,
      rows: [{ id: "i1", email: "new@acme.test", acceptedAt: new Date() }],
      directory: createDirectory(calls),
      calls,
    });

    const res = await app.request("/i1", { method: "DELETE" });

    expect(res.status).toBe(400);
    expect(calls.revokeInvite).toEqual([]);
    expect(calls.deletes).toBe(0);
  });
});
