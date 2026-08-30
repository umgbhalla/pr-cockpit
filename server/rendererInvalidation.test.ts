import { expect, test } from "bun:test";
import { mergeRendererOrigins, startCockpitServer } from "./cockpitServer.ts";
import {
  invalidateInbox,
  invalidatePr,
  publishPollCompleted,
  setRendererInvalidationPublisher,
} from "./rendererInvalidation.ts";

function openSocket(url: string): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => resolve(socket), { once: true });
  socket.addEventListener("error", () => reject(new Error("renderer event socket failed")), { once: true });
  return promise;
}

test("renderer origin policy accepts a configured MagicDNS origin and rejects others", async () => {
  const magicOrigin = "https://hyperion.tail2e89b4.ts.net";
  const server = startCockpitServer(0, () => new Response("ok"), mergeRendererOrigins("https://cockpit.example.net", magicOrigin));
  try {
    expect(server.hostname).toBe("127.0.0.1");
    const baseUrl = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: magicOrigin },
    })).ok).toBe(true);
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: "https://cockpit.example.net" },
    })).ok).toBe(true);
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/events`, {
      headers: { origin: "https://random.ts.net" },
    })).status).toBe(403);
  } finally {
    server.stop(true);
    setRendererInvalidationPublisher(() => {});
  }
});

test("Serve identity is an extra origin path and never trusts Funnel or a mismatched Origin", async () => {
  const suffix = "tail2e89b4.ts.net";
  const serviceOrigin = "https://pr-cockpit.tail2e89b4.ts.net";
  const identity = {
    "tailscale-headers-info": "v1",
    "tailscale-user-login": "ada@example.com",
    "x-forwarded-host": "pr-cockpit.tail2e89b4.ts.net",
  };
  const server = startCockpitServer(0, () => new Response("ok"), undefined, {
    trustServeIdentity: true,
    magicDnsSuffix: suffix,
    whois: async (addr) => addr === "100.64.1.2",
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: serviceOrigin, ...identity },
    })).ok).toBe(true);
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: "https://evil.example", ...identity },
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: serviceOrigin, ...identity, "tailscale-funnel-request": "1" },
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: serviceOrigin, "x-forwarded-for": "100.64.1.2", "x-forwarded-host": "pr-cockpit.tail2e89b4.ts.net" },
    })).ok).toBe(true);
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: serviceOrigin, "x-forwarded-for": "100.64.9.9", "x-forwarded-host": "pr-cockpit.tail2e89b4.ts.net" },
    })).status).toBe(403);
  } finally {
    server.stop(true);
    setRendererInvalidationPublisher(() => {});
  }
});

test("renderer origins must be exact HTTP or HTTPS origins", () => {
  expect(() => startCockpitServer(0, () => new Response("Not found", { status: 404 }), "https://cockpit.example.net/path")).toThrow(
    "COCKPIT_ALLOWED_ORIGINS entry must be an exact origin",
  );
  expect(() => startCockpitServer(0, () => new Response("Not found", { status: 404 }), "wss://cockpit.example.net")).toThrow(
    "COCKPIT_ALLOWED_ORIGINS entry must be an HTTP(S) origin",
  );
});

test("renderer event socket publishes poll, PR, and inbox invalidations after backend changes", async () => {
  const externalOrigin = "https://cockpit.example.net";
  let mutateCalls = 0;
  const server = startCockpitServer(0, (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/mutate") {
      mutateCalls += 1;
      publishPollCompleted("2026-08-21T14:02:37.671Z");
      invalidatePr("microsoft/vscode", 331792);
      invalidateInbox();
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }, externalOrigin);

  let socket: WebSocket | undefined;
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${baseUrl}/api/events`)).status).toBe(426);
    expect((await fetch(`${baseUrl}/api/events`, {
      headers: { origin: externalOrigin },
    })).status).toBe(426);
    expect((await fetch(`${baseUrl}/api/events`, {
      headers: { origin: "https://example.com" },
    })).status).toBe(403);

    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: "https://example.com" },
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    })).status).toBe(403);
    expect(mutateCalls).toBe(0);

    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: baseUrl },
    })).ok).toBe(true);
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: externalOrigin },
    })).ok).toBe(true);
    expect(mutateCalls).toBe(2);

    socket = await openSocket(`ws://127.0.0.1:${server.port}/api/events`);
    const { promise: eventsPromise, resolve: resolveEvents } = Promise.withResolvers<unknown[]>();
    const events: unknown[] = [];
    socket.addEventListener("message", (message) => {
      events.push(JSON.parse(String(message.data)));
      if (events.length === 3) resolveEvents(events);
    });

    expect((await fetch(`${baseUrl}/mutate`, { method: "POST" })).ok).toBe(true);
    expect(await eventsPromise).toEqual([
      { type: "poll-complete", lastPollAt: "2026-08-21T14:02:37.671Z" },
      { type: "pr", repo: "microsoft/vscode", number: 331792 },
      { type: "inbox" },
    ]);
  } finally {
    socket?.close();
    server.stop(true);
    setRendererInvalidationPublisher(() => {});
  }
});
