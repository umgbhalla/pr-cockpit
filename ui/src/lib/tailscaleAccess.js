export function tailscaleAccess(health) {
  const service = health?.tailscaleService;
  const serve = health?.tailscaleServe;
  if (service?.origin) return { state: "live", origin: service.origin, kind: "Tailscale Service", error: null };
  if (serve?.origin) return { state: "live", origin: serve.origin, kind: "Tailscale Serve", error: null };
  const error = service?.error || serve?.error || null;
  return error
    ? { state: "error", origin: null, kind: null, error }
    : { state: "local", origin: null, kind: null, error: null };
}
