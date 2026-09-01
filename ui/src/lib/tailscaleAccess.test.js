import { expect, test } from "bun:test";
import { tailscaleAccess } from "./tailscaleAccess.js";

test("prefers a stable Service, falls back to node Serve, and surfaces failures", () => {
  expect(tailscaleAccess({
    tailscaleService: { origin: "https://pr-cockpit.tail.ts.net" },
    tailscaleServe: { origin: "https://host.tail.ts.net:8443" },
  })).toEqual({ state: "live", origin: "https://pr-cockpit.tail.ts.net", kind: "Tailscale Service", error: null });
  expect(tailscaleAccess({ tailscaleServe: { origin: "https://host.tail.ts.net:8443" } }).origin).toBe("https://host.tail.ts.net:8443");
  expect(tailscaleAccess({ tailscaleServe: { error: "port occupied" } }).error).toBe("port occupied");
  expect(tailscaleAccess({}).state).toBe("local");
});
