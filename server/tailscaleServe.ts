export type TailscaleServeStatus = {
  enabled: boolean;
  origin: string | null;
  proxy: string | null;
  error: string | null;
};

export type TailscaleServiceStatus = {
  enabled: boolean;
  name: string | null;
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
const SERVICE_DISABLED: TailscaleServiceStatus = { enabled: false, name: null, origin: null, proxy: null, error: null };
const COMMAND_TIMEOUT_MS = 15_000;
const WHOIS_TIMEOUT_MS = 200;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SERVICE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

let lastStatus: TailscaleServeStatus = DISABLED;
let lastServiceStatus: TailscaleServiceStatus = SERVICE_DISABLED;
let lastSuffix: string | null = null;

export function tailscaleServeEnabled(value = Bun.env.COCKPIT_TAILSCALE_SERVE): boolean {
  return value === "1";
}

export function parseTailscaleServiceName(value = Bun.env.COCKPIT_TAILSCALE_SERVICE): { name: string } | { error: string } | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "0") return null;
  let name = trimmed.toLowerCase();
  if (name.startsWith("svc:")) name = name.slice(4);
  if (!SERVICE_NAME.test(name)) return { error: `COCKPIT_TAILSCALE_SERVICE is not a valid Service name: ${value}` };
  return { name };
}

export function tailscaleServeStatus(): TailscaleServeStatus {
  return lastStatus;
}

export function tailscaleServiceStatus(): TailscaleServiceStatus {
  return lastServiceStatus;
}

export function tailscaleMagicDnsSuffix(): string | null {
  return lastSuffix;
}

export function resetTailscaleServeStatus(): void {
  lastStatus = DISABLED;
  lastServiceStatus = SERVICE_DISABLED;
  lastSuffix = null;
}

function failed(proxy: string, error: string): TailscaleServeStatus {
  return { enabled: true, origin: null, proxy, error };
}

function failedService(name: string, proxy: string, error: string): TailscaleServiceStatus {
  return { enabled: true, name, origin: null, proxy, error };
}

function selfDnsName(status: unknown): string {
  if (!status || typeof status !== "object" || !("Self" in status) || !status.Self || typeof status.Self !== "object") {
    return "";
  }
  const dnsName = "DNSName" in status.Self ? status.Self.DNSName : "";
  return typeof dnsName === "string" ? dnsName : "";
}

function readMagicDnsSuffix(status: unknown): string {
  if (!status || typeof status !== "object") return "";
  const direct = "MagicDNSSuffix" in status && typeof status.MagicDNSSuffix === "string" ? status.MagicDNSSuffix : "";
  if (direct.trim()) return direct;
  if ("CurrentTailnet" in status && status.CurrentTailnet && typeof status.CurrentTailnet === "object" && "MagicDNSSuffix" in status.CurrentTailnet) {
    const nested = status.CurrentTailnet.MagicDNSSuffix;
    if (typeof nested === "string") return nested;
  }
  return "";
}

export function normalizeMagicDnsHost(value: string): string {
  return value.trim().replace(/\.+$/, "").toLowerCase();
}

export function magicDnsSuffixFromStatus(statusJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    throw new Error("tailscale status --json was not valid JSON");
  }
  const fromField = normalizeMagicDnsHost(readMagicDnsSuffix(parsed));
  if (fromField && HOSTNAME.test(`host.${fromField}`)) return fromField;
  const dnsName = normalizeMagicDnsHost(selfDnsName(parsed));
  const dot = dnsName.indexOf(".");
  if (dot > 0) {
    const suffix = dnsName.slice(dot + 1);
    if (HOSTNAME.test(`host.${suffix}`)) return suffix;
  }
  throw new Error("Tailscale did not report a MagicDNS suffix");
}

export function magicDnsHttpsOrigin(statusJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    throw new Error("tailscale status --json was not valid JSON");
  }
  const dnsName = selfDnsName(parsed);
  const host = normalizeMagicDnsHost(dnsName);
  if (!HOSTNAME.test(host)) {
    throw new Error(host ? `Tailscale MagicDNS name is not a valid hostname: ${dnsName}` : "Tailscale did not report a MagicDNS name");
  }
  rememberSuffixFromHost(host, parsed);
  return `https://${host}`;
}

function rememberSuffixFromHost(host: string, status: unknown): void {
  try {
    lastSuffix = normalizeMagicDnsHost(readMagicDnsSuffix(status)) || host.slice(host.indexOf(".") + 1);
  } catch {
    lastSuffix = host.includes(".") ? host.slice(host.indexOf(".") + 1) : lastSuffix;
  }
  if (lastSuffix === "") lastSuffix = null;
}

export function tailscaleServiceOrigin(name: string, suffix: string): string {
  return `https://${name}.${normalizeMagicDnsHost(suffix)}`;
}

export function tailscaleServeArgs(port: number): string[] {
  // HTTPS on this tailnet node only. Funnel would publish past the tailnet and must never be used.
  return ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`];
}

export function tailscaleServiceArgs(port: number, name: string): string[] {
  // Distinct Service VIP, still HTTPS into loopback. --service implies background mode.
  return ["serve", `--service=svc:${name}`, "--https=443", `http://127.0.0.1:${port}`];
}

export function untaggedServiceHostError(raw: string, name: string): string {
  const text = raw.trim() || `tailscale serve --service=svc:${name} failed`;
  if (/tagged|tag-based identity|user-auth|user account/i.test(text)) {
    return `Tailscale Service svc:${name} requires a tagged host (tag:server); user-auth nodes cannot advertise a Service: ${text}`;
  }
  return text;
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
    try {
      lastSuffix = magicDnsSuffixFromStatus(status.stdout);
    } catch {
      lastSuffix = lastSuffix ?? new URL(origin).hostname.split(".").slice(1).join(".");
    }
    lastStatus = { enabled: true, origin, proxy, error: null };
    return lastStatus;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastStatus = failed(proxy, message);
    return lastStatus;
  }
}

export async function startTailscaleService(
  port: number,
  deps: { name?: string | { error: string } | null; which?: () => string | null; run?: TailscaleCommandRunner } = {},
): Promise<TailscaleServiceStatus> {
  const parsed = deps.name === undefined ? parseTailscaleServiceName() : typeof deps.name === "string" ? { name: deps.name } : deps.name;
  if (parsed === null) {
    lastServiceStatus = SERVICE_DISABLED;
    return lastServiceStatus;
  }
  const proxy = `http://127.0.0.1:${port}`;
  if ("error" in parsed) {
    lastServiceStatus = failedService("", proxy, parsed.error);
    return lastServiceStatus;
  }
  const { name } = parsed;
  const bin = (deps.which ?? (() => Bun.which("tailscale")))();
  if (!bin) {
    lastServiceStatus = failedService(name, proxy, "`tailscale` is not on PATH");
    return lastServiceStatus;
  }
  const run = deps.run ?? ((args) => runTailscale(bin, args));
  try {
    const advertised = await run(tailscaleServiceArgs(port, name));
    if (advertised.exitCode !== 0) {
      lastServiceStatus = failedService(name, proxy, untaggedServiceHostError((advertised.stderr || advertised.stdout), name));
      return lastServiceStatus;
    }
    let suffix = lastSuffix;
    if (!suffix) {
      const status = await run(["status", "--json"]);
      if (status.exitCode !== 0) {
        lastServiceStatus = failedService(name, proxy, (status.stderr || status.stdout).trim() || `tailscale status exited ${status.exitCode}`);
        return lastServiceStatus;
      }
      suffix = magicDnsSuffixFromStatus(status.stdout);
      lastSuffix = suffix;
    }
    lastServiceStatus = { enabled: true, name, origin: tailscaleServiceOrigin(name, suffix), proxy, error: null };
    return lastServiceStatus;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastServiceStatus = failedService(name, proxy, untaggedServiceHostError(message, name));
    return lastServiceStatus;
  }
}

const LOCALAPI_SOCKETS = [
  "/var/run/tailscale/tailscaled.sock",
  "/var/run/tailscaled.socket",
];

export async function tailscaleWhois(addr: string, deps: { sockets?: string[]; fetchWhois?: (addr: string) => Promise<unknown> } = {}): Promise<boolean> {
  const host = addr.trim();
  if (host === "") return false;
  if (deps.fetchWhois) {
    try {
      const body = await deps.fetchWhois(host);
      return whoisIdentifiesPeer(body);
    } catch {
      return false;
    }
  }
  const home = Bun.env.HOME;
  const sockets = deps.sockets ?? [
    ...LOCALAPI_SOCKETS,
    ...(home ? [`${home}/Library/Application Support/Tailscale/tailscaled.sock`] : []),
  ];
  for (const socket of sockets) {
    try {
      const response = await fetch(`http://local-tailscaled.sock/localapi/v0/whois?addr=${encodeURIComponent(host)}`, {
        unix: socket,
        signal: AbortSignal.timeout(WHOIS_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      if (whoisIdentifiesPeer(await response.json())) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function whoisIdentifiesPeer(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const node = "Node" in body ? body.Node : "node" in body ? body.node : null;
  return Boolean(node && typeof node === "object");
}

export function originFromForwardedHost(hostHeader: string | null): string | null {
  if (hostHeader === null) return null;
  const host = hostHeader.split(",")[0]!.trim().toLowerCase();
  if (host === "") return null;
  try {
    return new URL(host.includes("://") ? host : `https://${host}`).origin;
  } catch {
    return null;
  }
}

function hostnameFromHostHeader(host: string): string | null {
  try {
    return new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
}

function publishedServeHostnames(): Set<string> {
  const hosts = new Set<string>();
  for (const origin of [lastStatus.origin, lastServiceStatus.origin]) {
    if (!origin) continue;
    try {
      hosts.add(new URL(origin).hostname);
    } catch {
      // origin was already validated when Serve/Service recorded it
    }
  }
  return hosts;
}

export function isLoopbackCliHost(host: string): boolean {
  return /^(?:127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host.trim().toLowerCase());
}

export function isTrustedCliHost(request: Request, fallbackHost: string): boolean {
  if (request.headers.get("tailscale-funnel-request")) return false;
  const host = (request.headers.get("host") ?? fallbackHost).split(",")[0]!.trim();
  if (isLoopbackCliHost(host)) return true;
  const published = publishedServeHostnames();
  if (published.size === 0) return false;
  for (const candidate of [host, request.headers.get("x-forwarded-host")]) {
    if (!candidate) continue;
    const hostname = hostnameFromHostHeader(candidate.split(",")[0]!.trim());
    if (hostname && published.has(hostname)) return true;
  }
  return false;
}

export function requestHasServeIdentity(request: Request): boolean {
  if (request.headers.get("tailscale-funnel-request")) return false;
  const info = request.headers.get("tailscale-headers-info");
  const login = request.headers.get("tailscale-user-login");
  return Boolean(info && login);
}

export async function servePeerAllowsOrigin(
  request: Request,
  origin: string,
  options: { magicDnsSuffix?: string | null; whois?: (addr: string) => Promise<boolean> } = {},
): Promise<boolean> {
  if (request.headers.get("tailscale-funnel-request")) return false;
  let identified = requestHasServeIdentity(request);
  if (!identified) {
    const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    if (forwardedFor && options.whois) {
      try {
        identified = await options.whois(forwardedFor);
      } catch {
        identified = false;
      }
    }
  }
  if (!identified) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const forwardedOrigin = originFromForwardedHost(request.headers.get("x-forwarded-host"));
  if (forwardedOrigin) return forwardedOrigin === url.origin;
  const suffix = options.magicDnsSuffix ? normalizeMagicDnsHost(options.magicDnsSuffix) : null;
  return Boolean(suffix && (url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)));
}
