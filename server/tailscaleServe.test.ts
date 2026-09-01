import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRendererOrigins, startCockpitServer } from "./cockpitServer.ts";
import {
  conflictingServeRoute,
  isTrustedCliHost,
  magicDnsHttpsOrigin,
  magicDnsSuffixFromStatus,
  parseTailscaleServiceName,
  resetTailscaleServeStatus,
  servePeerAllowsOrigin,
  startTailscaleServe,
  startTailscaleService,
  tailscaleServeArgs,
  tailscaleServeEnabled,
  tailscaleServeStatus,
  tailscaleHttpsPort,
  tailscaleServiceArgs,
  tailscaleServiceOrigin,
  tailscaleServiceStatus,
  untaggedServiceHostError,
  type TailscaleCommandResult,
} from "./tailscaleServe.ts";
import { setRendererInvalidationPublisher } from "./rendererInvalidation.ts";

afterEach(() => {
  resetTailscaleServeStatus();
});

function fakeTailscale(commands: string[][]): (args: readonly string[]) => Promise<TailscaleCommandResult> {
  return async (args) => {
    commands.push([...args]);
    if (args[0] === "serve" && args[1] === "status" && args[2] === "--json") {
      return { exitCode: 0, stdout: JSON.stringify({ Web: {} }), stderr: "" };
    }
    if (args[0] === "serve" && typeof args[1] === "string" && args[1].startsWith("--service=")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "serve" && args[1] === "--bg") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "status" && args[1] === "--json") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ Self: { DNSName: "hyperion.tail2e89b4.ts.net." }, MagicDNSSuffix: "tail2e89b4.ts.net." }),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected tailscale ${args.join(" ")}` };
  };
}

test("Tailscale Serve is off unless COCKPIT_TAILSCALE_SERVE=1", () => {
  expect(tailscaleServeEnabled(undefined)).toBe(false);
  expect(tailscaleServeEnabled("")).toBe(false);
  expect(tailscaleServeEnabled("0")).toBe(false);
  expect(tailscaleServeEnabled("true")).toBe(false);
  expect(tailscaleServeEnabled("1")).toBe(true);
});

test("Serve command publishes HTTPS 443 to loopback and never uses Funnel", () => {
  expect(tailscaleServeArgs(4820)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4820"]);
  expect(tailscaleServeArgs(4820, 8443)).toEqual(["serve", "--bg", "--https=8443", "http://127.0.0.1:4820"]);
  expect(tailscaleServeArgs(4820).join(" ")).not.toContain("funnel");
  expect(tailscaleHttpsPort(undefined)).toBe(443);
  expect(tailscaleHttpsPort("8443")).toBe(8443);
  expect(() => tailscaleHttpsPort("0")).toThrow("not a valid port");
});

test("MagicDNS origin strips the trailing FQDN dot", () => {
  expect(magicDnsHttpsOrigin(JSON.stringify({ Self: { DNSName: "hyperion.tail2e89b4.ts.net." } }))).toBe(
    "https://hyperion.tail2e89b4.ts.net",
  );
  expect(magicDnsHttpsOrigin(JSON.stringify({ Self: { DNSName: "hyperion.tail2e89b4.ts.net." } }), 8443)).toBe(
    "https://hyperion.tail2e89b4.ts.net:8443",
  );
  expect(() => magicDnsHttpsOrigin("{}")).toThrow("Tailscale did not report a MagicDNS name");
});

test("Serve refuses to replace another root route", async () => {
  const commands: string[][] = [];
  const proxy = "http://127.0.0.1:4820";
  const config = JSON.stringify({
    Web: { "hyperion.tail2e89b4.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
  });
  expect(conflictingServeRoute(config, "https://hyperion.tail2e89b4.ts.net:8443", 8443, proxy)).toContain("already routes /");
  const status = await startTailscaleServe(4820, {
    enabled: true,
    httpsPort: 8443,
    which: () => "/usr/bin/tailscale",
    run: async (args) => {
      commands.push([...args]);
      if (args[0] === "status") return { exitCode: 0, stdout: JSON.stringify({ Self: { DNSName: "hyperion.tail2e89b4.ts.net." } }), stderr: "" };
      if (args[0] === "serve" && args[1] === "status") return { exitCode: 0, stdout: config, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  expect(status.error).toContain("already routes /");
  expect(commands).toEqual([["status", "--json"], ["serve", "status", "--json"]]);
});

test("startTailscaleServe records the MagicDNS origin after a successful serve", async () => {
  const commands: string[][] = [];
  const status = await startTailscaleServe(4820, {
    enabled: true,
    which: () => "/usr/bin/tailscale",
    run: fakeTailscale(commands),
  });
  expect(status).toEqual({
    enabled: true,
    origin: "https://hyperion.tail2e89b4.ts.net",
    proxy: "http://127.0.0.1:4820",
    httpsPort: 443,
    error: null,
  });
  expect(tailscaleServeStatus()).toEqual(status);
  expect(commands.at(-1)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4820"]);
  expect(commands.some((args) => args.includes("funnel"))).toBe(false);
});

test("missing tailscale or a failed serve leaves the origin unset", async () => {
  expect(await startTailscaleServe(4820, { enabled: true, which: () => null })).toEqual({
    enabled: true,
    origin: null,
    proxy: "http://127.0.0.1:4820",
    httpsPort: 443,
    error: "`tailscale` is not on PATH",
  });
  expect(await startTailscaleServe(4820, {
    enabled: true,
    which: () => "/usr/bin/tailscale",
    run: async () => ({ exitCode: 1, stdout: "", stderr: "failed to connect to local tailscaled\n" }),
  })).toEqual({
    enabled: true,
    origin: null,
    proxy: "http://127.0.0.1:4820",
    httpsPort: 443,
    error: "failed to connect to local tailscaled",
  });
  expect(await startTailscaleServe(4820, { enabled: false, which: () => "/usr/bin/tailscale" })).toEqual({
    enabled: false,
    origin: null,
    proxy: null,
    httpsPort: null,
    error: null,
  });
});

test("mergeRendererOrigins keeps configured origins and adds MagicDNS exactly once", () => {
  expect(mergeRendererOrigins("https://cockpit.example.net", "https://hyperion.tail2e89b4.ts.net")).toBe(
    "https://cockpit.example.net,https://hyperion.tail2e89b4.ts.net",
  );
  expect(mergeRendererOrigins("https://hyperion.tail2e89b4.ts.net", "https://hyperion.tail2e89b4.ts.net")).toBe(
    "https://hyperion.tail2e89b4.ts.net",
  );
  expect(mergeRendererOrigins(undefined, null, "")).toBeUndefined();
});

test("a mock server with Serve enabled still binds loopback and allows the MagicDNS origin", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-tailscale-serve-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const port = (() => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const value = server.port;
    server.stop(true);
    return value!;
  })();
  writeFileSync(join(bin, "tailscale"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(join(root, "tailscale-calls"))}
if [[ "$1" == "serve" && "$2" == "status" && "$3" == "--json" ]]; then
  printf '%s\\n' '{"Web":{}}'
  exit 0
fi
if [[ "$1" == "serve" && "$2" == "--bg" ]]; then
  [[ "$*" != *funnel* ]]
  [[ "$*" == *"--https=443 http://127.0.0.1:${port}"* ]]
  exit 0
fi
if [[ "$1" == "status" && "$2" == "--json" ]]; then
  printf '%s\\n' '{"Self":{"DNSName":"hyperion.tail2e89b4.ts.net."}}'
  exit 0
fi
echo "unexpected tailscale $*" >&2
exit 1
`);
  chmodSync(join(bin, "tailscale"), 0o755);

  const process = Bun.spawn([Bun.which("bun") ?? "bun", "server/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...Bun.env,
      PATH: `${bin}:${Bun.env.PATH}`,
      COCKPIT_PORT: String(port),
      COCKPIT_DATA_DIR: join(root, "data"),
      COCKPIT_MOCK: "1",
      COCKPIT_TAILSCALE_SERVE: "1",
      COCKPIT_TAILSCALE_SERVICE: "",
      COCKPIT_REPLICA_SSH_HOST: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let lastError = "server did not start";
    for (let attempt = 0; attempt < 100; attempt++) {
      if (process.exitCode !== null) {
        lastError = `${await new Response(process.stderr).text()}\n${await new Response(process.stdout).text()}`;
        break;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          const body = await response.json() as {
            tailscaleServe?: { origin: string; proxy: string; httpsPort: number; error: string | null };
          };
          expect(body.tailscaleServe).toEqual({
            enabled: true,
            origin: "https://hyperion.tail2e89b4.ts.net",
            proxy: `http://127.0.0.1:${port}`,
            httpsPort: 443,
            error: null,
          });
          expect((await fetch(`http://127.0.0.1:${port}/mutate`, {
            method: "POST",
            headers: { origin: "https://hyperion.tail2e89b4.ts.net" },
          })).status).not.toBe(403);
          expect((await fetch(`http://127.0.0.1:${port}/mutate`, {
            method: "POST",
            headers: { origin: "https://evil.example" },
          })).status).toBe(403);
          const calls = await Bun.file(join(root, "tailscale-calls")).text();
          expect(calls).toContain(`serve --bg --https=443 http://127.0.0.1:${port}`);
          expect(calls).not.toContain("funnel");
          return;
        }
      } catch (error) {
        lastError = String(error);
      }
      await Bun.sleep(50);
    }
    throw new Error(lastError);
  } finally {
    process.kill();
    await process.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cockpit server listens only on loopback", () => {
  const server = startCockpitServer(0, () => new Response("ok"));
  try {
    expect(server.hostname).toBe("127.0.0.1");
  } finally {
    server.stop(true);
    setRendererInvalidationPublisher(() => {});
  }
});

test("Tailscale Service is off unless COCKPIT_TAILSCALE_SERVICE is a name", () => {
  expect(parseTailscaleServiceName(undefined)).toBeNull();
  expect(parseTailscaleServiceName("")).toBeNull();
  expect(parseTailscaleServiceName("0")).toBeNull();
  expect(parseTailscaleServiceName("pr-cockpit")).toEqual({ name: "pr-cockpit" });
  expect(parseTailscaleServiceName("svc:pr-cockpit")).toEqual({ name: "pr-cockpit" });
  expect(parseTailscaleServiceName("PR-Cockpit")).toEqual({ name: "pr-cockpit" });
  expect(parseTailscaleServiceName("not_a_service")).toEqual({
    error: "COCKPIT_TAILSCALE_SERVICE is not a valid Service name: not_a_service",
  });
});

test("Service command publishes HTTPS 443 to loopback and never uses Funnel", () => {
  expect(tailscaleServiceArgs(4820, "pr-cockpit")).toEqual([
    "serve",
    "--service=svc:pr-cockpit",
    "--https=443",
    "http://127.0.0.1:4820",
  ]);
  expect(tailscaleServiceArgs(4820, "pr-cockpit").join(" ")).not.toContain("funnel");
  expect(tailscaleServiceArgs(4820, "pr-cockpit").join(" ")).not.toContain("--bg");
});

test("Service origin is the stable MagicDNS name, not the node hostname", () => {
  expect(magicDnsSuffixFromStatus(JSON.stringify({
    Self: { DNSName: "hyperion.tail2e89b4.ts.net." },
    MagicDNSSuffix: "tail2e89b4.ts.net.",
  }))).toBe("tail2e89b4.ts.net");
  expect(tailscaleServiceOrigin("pr-cockpit", "tail2e89b4.ts.net.")).toBe("https://pr-cockpit.tail2e89b4.ts.net");
});

test("startTailscaleService records the Service origin after a successful advertise", async () => {
  const commands: string[][] = [];
  const status = await startTailscaleService(4820, {
    name: "pr-cockpit",
    which: () => "/usr/bin/tailscale",
    run: fakeTailscale(commands),
  });
  expect(status).toEqual({
    enabled: true,
    name: "pr-cockpit",
    origin: "https://pr-cockpit.tail2e89b4.ts.net",
    proxy: "http://127.0.0.1:4820",
    error: null,
  });
  expect(tailscaleServiceStatus()).toEqual(status);
  expect(commands[0]).toEqual(["serve", "--service=svc:pr-cockpit", "--https=443", "http://127.0.0.1:4820"]);
  expect(commands.some((args) => args.includes("funnel"))).toBe(false);
});

test("startTailscaleService does not call tailscale when unset", async () => {
  const commands: string[][] = [];
  expect(await startTailscaleService(4820, {
    name: null,
    which: () => "/usr/bin/tailscale",
    run: fakeTailscale(commands),
  })).toEqual({
    enabled: false,
    name: null,
    origin: null,
    proxy: null,
    error: null,
  });
  expect(commands).toEqual([]);
});

test("an untagged Service advertise keeps classic Serve and loopback working", async () => {
  const commands: string[][] = [];
  const run: (args: readonly string[]) => Promise<TailscaleCommandResult> = async (args) => {
    commands.push([...args]);
    if (args[0] === "serve" && args[1] === "status") return { exitCode: 0, stdout: JSON.stringify({ Web: {} }), stderr: "" };
    if (args[0] === "serve" && args[1] === "--bg") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "serve" && typeof args[1] === "string" && args[1].startsWith("--service=")) {
      return { exitCode: 1, stdout: "", stderr: "backend error: service hosts must be tagged nodes\n" };
    }
    if (args[0] === "status" && args[1] === "--json") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ Self: { DNSName: "hyperion.tail2e89b4.ts.net." }, MagicDNSSuffix: "tail2e89b4.ts.net." }),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected tailscale ${args.join(" ")}` };
  };
  const serve = await startTailscaleServe(4820, { enabled: true, which: () => "/usr/bin/tailscale", run });
  const service = await startTailscaleService(4820, { name: "pr-cockpit", which: () => "/usr/bin/tailscale", run });
  expect(serve).toEqual({
    enabled: true,
    origin: "https://hyperion.tail2e89b4.ts.net",
    proxy: "http://127.0.0.1:4820",
    httpsPort: 443,
    error: null,
  });
  expect(tailscaleServeStatus()).toEqual(serve);
  expect(service.enabled).toBe(true);
  expect(service.origin).toBeNull();
  expect(service.error).toBe(
    "Tailscale Service svc:pr-cockpit requires a tagged host (tag:server); user-auth nodes cannot advertise a Service: backend error: service hosts must be tagged nodes",
  );
  expect(untaggedServiceHostError("failed to connect", "pr-cockpit")).toBe("failed to connect");
  expect(commands.some((args) => args.includes("funnel"))).toBe(false);

  const server = startCockpitServer(0, () => new Response("ok"), mergeRendererOrigins(undefined, serve.origin, service.origin));
  try {
    expect(server.hostname).toBe("127.0.0.1");
    const baseUrl = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${baseUrl}/mutate`, { method: "POST" })).ok).toBe(true);
    expect((await fetch(`${baseUrl}/mutate`, {
      method: "POST",
      headers: { origin: "https://hyperion.tail2e89b4.ts.net" },
    })).ok).toBe(true);
  } finally {
    server.stop(true);
    setRendererInvalidationPublisher(() => {});
  }
});

test("CLI host trust accepts published Serve/Service names and rejects Funnel", async () => {
  await startTailscaleServe(4820, { enabled: true, which: () => "/usr/bin/tailscale", run: fakeTailscale([]) });
  await startTailscaleService(4820, { name: "pr-cockpit", which: () => "/usr/bin/tailscale", run: fakeTailscale([]) });
  const loopback = new Request("http://127.0.0.1:4820/api/agent/pr/acme/app/1/mutations", {
    headers: { host: "127.0.0.1:4820" },
  });
  expect(isTrustedCliHost(loopback, "127.0.0.1:4820")).toBe(true);
  expect(isTrustedCliHost(new Request("http://127.0.0.1:4820/", {
    headers: { host: "pr-cockpit.tail2e89b4.ts.net" },
  }), "127.0.0.1:4820")).toBe(true);
  expect(isTrustedCliHost(new Request("http://127.0.0.1:4820/", {
    headers: { host: "hyperion.tail2e89b4.ts.net" },
  }), "127.0.0.1:4820")).toBe(true);
  expect(isTrustedCliHost(new Request("http://127.0.0.1:4820/", {
    headers: { host: "evil.example" },
  }), "127.0.0.1:4820")).toBe(false);
  expect(isTrustedCliHost(new Request("http://127.0.0.1:4820/", {
    headers: { host: "pr-cockpit.tail2e89b4.ts.net", "tailscale-funnel-request": "1" },
  }), "127.0.0.1:4820")).toBe(false);
});

test("Serve identity allows the forwarded MagicDNS origin and never Funnel", async () => {
  const identity = {
    "tailscale-headers-info": "v1",
    "tailscale-user-login": "ada@example.com",
    "x-forwarded-host": "pr-cockpit.tail2e89b4.ts.net",
  };
  expect(await servePeerAllowsOrigin(
    new Request("http://127.0.0.1:4820/mutate", { headers: { origin: "https://pr-cockpit.tail2e89b4.ts.net", ...identity } }),
    "https://pr-cockpit.tail2e89b4.ts.net",
    { magicDnsSuffix: "tail2e89b4.ts.net" },
  )).toBe(true);
  expect(await servePeerAllowsOrigin(
    new Request("http://127.0.0.1:4820/mutate", { headers: { origin: "https://evil.example", ...identity } }),
    "https://evil.example",
    { magicDnsSuffix: "tail2e89b4.ts.net" },
  )).toBe(false);
  expect(await servePeerAllowsOrigin(
    new Request("http://127.0.0.1:4820/mutate", {
      headers: { origin: "https://pr-cockpit.tail2e89b4.ts.net", ...identity, "tailscale-funnel-request": "1" },
    }),
    "https://pr-cockpit.tail2e89b4.ts.net",
    { magicDnsSuffix: "tail2e89b4.ts.net" },
  )).toBe(false);
  expect(await servePeerAllowsOrigin(
    new Request("http://127.0.0.1:4820/mutate", {
      headers: { origin: "https://pr-cockpit.tail2e89b4.ts.net", "x-forwarded-for": "100.64.1.2" },
    }),
    "https://pr-cockpit.tail2e89b4.ts.net",
    { magicDnsSuffix: "tail2e89b4.ts.net", whois: async (addr) => addr === "100.64.1.2" },
  )).toBe(true);
  expect(await servePeerAllowsOrigin(
    new Request("http://127.0.0.1:4820/mutate", {
      headers: { origin: "https://pr-cockpit.tail2e89b4.ts.net", "x-forwarded-for": "100.64.1.2" },
    }),
    "https://pr-cockpit.tail2e89b4.ts.net",
    { magicDnsSuffix: "tail2e89b4.ts.net", whois: async () => {
      throw new Error("EACCES");
    } },
  )).toBe(false);
});

test("a mock server keeps loopback and classic Serve when Service advertise is untagged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-tailscale-service-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const port = (() => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const value = server.port;
    server.stop(true);
    return value!;
  })();
  writeFileSync(join(bin, "tailscale"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(join(root, "tailscale-calls"))}
if [[ "$1" == "serve" && "$2" == "status" && "$3" == "--json" ]]; then
  printf '%s\\n' '{"Web":{}}'
  exit 0
fi
if [[ "$1" == "serve" && "$2" == "--bg" ]]; then
  [[ "$*" != *funnel* ]]
  [[ "$*" == *"--https=443 http://127.0.0.1:${port}"* ]]
  exit 0
fi
if [[ "$1" == "serve" && "$2" == --service=* ]]; then
  [[ "$*" != *funnel* ]]
  echo "backend error: service hosts must be tagged nodes" >&2
  exit 1
fi
if [[ "$1" == "status" && "$2" == "--json" ]]; then
  printf '%s\\n' '{"Self":{"DNSName":"hyperion.tail2e89b4.ts.net."},"MagicDNSSuffix":"tail2e89b4.ts.net."}'
  exit 0
fi
echo "unexpected tailscale $*" >&2
exit 1
`);
  chmodSync(join(bin, "tailscale"), 0o755);

  const process = Bun.spawn([Bun.which("bun") ?? "bun", "server/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...Bun.env,
      PATH: `${bin}:${Bun.env.PATH}`,
      COCKPIT_PORT: String(port),
      COCKPIT_DATA_DIR: join(root, "data"),
      COCKPIT_MOCK: "1",
      COCKPIT_TAILSCALE_SERVE: "1",
      COCKPIT_TAILSCALE_SERVICE: "pr-cockpit",
      COCKPIT_REPLICA_SSH_HOST: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let lastError = "server did not start";
    for (let attempt = 0; attempt < 100; attempt++) {
      if (process.exitCode !== null) {
        lastError = `${await new Response(process.stderr).text()}\n${await new Response(process.stdout).text()}`;
        break;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          const body = await response.json() as {
            tailscaleServe?: { origin: string; proxy: string; httpsPort: number; error: string | null };
            tailscaleService?: { name: string; origin: string | null; error: string | null };
          };
          expect(body.tailscaleServe).toEqual({
            enabled: true,
            origin: "https://hyperion.tail2e89b4.ts.net",
            proxy: `http://127.0.0.1:${port}`,
            httpsPort: 443,
            error: null,
          });
          expect(body.tailscaleService?.name).toBe("pr-cockpit");
          expect(body.tailscaleService?.origin).toBeNull();
          expect(body.tailscaleService?.error).toContain("requires a tagged host (tag:server)");
          expect((await fetch(`http://127.0.0.1:${port}/mutate`, { method: "POST" })).status).not.toBe(403);
          expect((await fetch(`http://127.0.0.1:${port}/mutate`, {
            method: "POST",
            headers: { origin: "https://hyperion.tail2e89b4.ts.net" },
          })).status).not.toBe(403);
          const calls = await Bun.file(join(root, "tailscale-calls")).text();
          expect(calls).toContain(`serve --bg --https=443 http://127.0.0.1:${port}`);
          expect(calls).toContain(`serve --service=svc:pr-cockpit --https=443 http://127.0.0.1:${port}`);
          expect(calls).not.toContain("funnel");
          return;
        }
      } catch (error) {
        lastError = String(error);
      }
      await Bun.sleep(50);
    }
    throw new Error(lastError);
  } finally {
    process.kill();
    await process.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
