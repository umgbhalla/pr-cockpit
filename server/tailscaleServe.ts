export type TailscaleServeStatus = {
  enabled: boolean;
  origin: string | null;
  proxy: string | null;
  error: string | null;
};

export type TailscaleCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type TailscaleCommandRunner = (args: readonly string[]) => Promise<TailscaleCommandResult>;

const DISABLED: TailscaleServeStatus = { enabled: false, origin: null, proxy: null, error: null };
const COMMAND_TIMEOUT_MS = 15_000;

let lastStatus: TailscaleServeStatus = DISABLED;

export function tailscaleServeEnabled(value = Bun.env.COCKPIT_TAILSCALE_SERVE): boolean {
  return value === "1";
}

export function tailscaleServeStatus(): TailscaleServeStatus {
  return lastStatus;
}

export function resetTailscaleServeStatus(): void {
  lastStatus = DISABLED;
}

function failed(proxy: string, error: string): TailscaleServeStatus {
  return { enabled: true, origin: null, proxy, error };
}

function selfDnsName(status: unknown): string {
  if (!status || typeof status !== "object" || !("Self" in status) || !status.Self || typeof status.Self !== "object") {
    return "";
  }
  const dnsName = "DNSName" in status.Self ? status.Self.DNSName : "";
  return typeof dnsName === "string" ? dnsName : "";
}

export function magicDnsHttpsOrigin(statusJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    throw new Error("tailscale status --json was not valid JSON");
  }
  const dnsName = selfDnsName(parsed);
  const host = dnsName.trim().replace(/\.+$/, "").toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new Error(host ? `Tailscale MagicDNS name is not a valid hostname: ${dnsName}` : "Tailscale did not report a MagicDNS name");
  }
  return `https://${host}`;
}

export function tailscaleServeArgs(port: number): string[] {
  // HTTPS on this tailnet node only. Funnel would publish past the tailnet and must never be used.
  return ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`];
}

async function runTailscale(bin: string, args: readonly string[]): Promise<TailscaleCommandResult> {
  const process = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function startTailscaleServe(
  port: number,
  deps: { enabled?: boolean; which?: () => string | null; run?: TailscaleCommandRunner } = {},
): Promise<TailscaleServeStatus> {
  if (!(deps.enabled ?? tailscaleServeEnabled())) {
    lastStatus = DISABLED;
    return lastStatus;
  }
  const proxy = `http://127.0.0.1:${port}`;
  const bin = (deps.which ?? (() => Bun.which("tailscale")))();
  if (!bin) {
    lastStatus = failed(proxy, "`tailscale` is not on PATH");
    return lastStatus;
  }
  const run = deps.run ?? ((args) => runTailscale(bin, args));
  const serveArgs = tailscaleServeArgs(port);
  try {
    const served = await run(serveArgs);
    if (served.exitCode !== 0) {
      lastStatus = failed(proxy, (served.stderr || served.stdout).trim() || `tailscale serve exited ${served.exitCode}`);
      return lastStatus;
    }
    const status = await run(["status", "--json"]);
    if (status.exitCode !== 0) {
      lastStatus = failed(proxy, (status.stderr || status.stdout).trim() || `tailscale status exited ${status.exitCode}`);
      return lastStatus;
    }
    const origin = magicDnsHttpsOrigin(status.stdout);
    lastStatus = { enabled: true, origin, proxy, error: null };
    return lastStatus;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastStatus = failed(proxy, message);
    return lastStatus;
  }
}
