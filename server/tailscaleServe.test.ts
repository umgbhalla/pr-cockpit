import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRendererOrigins, startCockpitServer } from "./cockpitServer.ts";
import {
  magicDnsHttpsOrigin,
  resetTailscaleServeStatus,
  startTailscaleServe,
  tailscaleServeArgs,
  tailscaleServeEnabled,
  tailscaleServeStatus,
  type TailscaleCommandResult,
} from "./tailscaleServe.ts";
import { setRendererInvalidationPublisher } from "./rendererInvalidation.ts";

afterEach(() => {
  resetTailscaleServeStatus();
});

function fakeTailscale(commands: string[][]): (args: readonly string[]) => Promise<TailscaleCommandResult> {
  return async (args) => {
    commands.push([...args]);
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
  expect(tailscaleServeArgs(4820).join(" ")).not.toContain("funnel");
});

test("MagicDNS origin strips the trailing FQDN dot", () => {
  expect(magicDnsHttpsOrigin(JSON.stringify({ Self: { DNSName: "hyperion.tail2e89b4.ts.net." } }))).toBe(
    "https://hyperion.tail2e89b4.ts.net",
  );
  expect(() => magicDnsHttpsOrigin("{}")).toThrow("Tailscale did not report a MagicDNS name");
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
    error: null,
  });
  expect(tailscaleServeStatus()).toEqual(status);
  expect(commands[0]).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4820"]);
  expect(commands.some((args) => args.includes("funnel"))).toBe(false);
});

test("missing tailscale or a failed serve leaves the origin unset", async () => {
  expect(await startTailscaleServe(4820, { enabled: true, which: () => null })).toEqual({
    enabled: true,
    origin: null,
    proxy: "http://127.0.0.1:4820",
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
    error: "failed to connect to local tailscaled",
  });
  expect(await startTailscaleServe(4820, { enabled: false, which: () => "/usr/bin/tailscale" })).toEqual({
    enabled: false,
    origin: null,
    proxy: null,
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
            tailscaleServe?: { origin: string; proxy: string; error: string | null };
          };
          expect(body.tailscaleServe).toEqual({
            enabled: true,
            origin: "https://hyperion.tail2e89b4.ts.net",
            proxy: `http://127.0.0.1:${port}`,
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
