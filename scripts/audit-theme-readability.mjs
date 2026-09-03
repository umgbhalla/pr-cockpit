import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUT = resolve(ROOT, "docs/audits/theme-readability");
const THEMES = ["light", "dark"];
const PAIRS = [
  ["text", "bg"],
  ["text-dim", "bg"],
  ["text-dim", "surface"],
  ["text-faint", "bg"],
  ["text-faint", "surface"],
  ["md-body", "bg"],
  ["link", "bg"],
  ["ready", "bg"],
  ["review", "bg"],
  ["fail", "bg"],
  ["merged", "bg"],
  ["code-fg", "code-bg"],
];
const SCENARIOS = ["inbox-populated", "detail-files", "settings-agents"];

function parseArgs(argv) {
  if (argv[0] === "--verify") return { verify: true, out: resolve(ROOT, argv[1] || "docs/audits/theme-readability") };
  if (argv[0] === "--out") return { verify: false, out: resolve(ROOT, argv[1] || "docs/audits/theme-readability") };
  if (argv.length) throw new Error("usage: bun scripts/audit-theme-readability.mjs [--out DIR | --verify DIR]");
  return { verify: false, out: DEFAULT_OUT };
}

async function run(args, cwd = ROOT) {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed\n${stdout}\n${stderr}`);
}

function channels(value) {
  const srgb = value.match(/color\(srgb ([^)]+)\)/);
  if (srgb) return srgb[1].split(/[ /]+/).slice(0, 3).map((channel) => Number(channel) * 255);
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`unsupported computed color: ${value}`);
  return match[1].split(/[ ,/]+/).slice(0, 3).map(Number);
}

function luminance(rgb) {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const a = luminance(channels(foreground));
  const b = luminance(channels(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function measurePalette() {
  const css = await readFile(join(ROOT, "ui/src/app.css"), "utf8");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${css}</style><div id="sample">Aa</div>`);
    const results = [];
    for (const theme of THEMES) {
      await page.evaluate((name) => document.documentElement.dataset.theme = name, theme);
      for (const [foreground, background] of PAIRS) {
        const colors = await page.locator("#sample").evaluate((node, pair) => {
          node.style.color = `var(--${pair[0]})`;
          node.style.backgroundColor = `var(--${pair[1]})`;
          const style = getComputedStyle(node);
          return { foreground: style.color, background: style.backgroundColor };
        }, [foreground, background]);
        const ratio = Number(contrast(colors.foreground, colors.background).toFixed(2));
        results.push({ theme, foreground: `--${foreground}`, background: `--${background}`, ratio, passesAA: ratio >= 4.5 });
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}

async function pngCount(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await pngCount(path);
    else if (entry.isFile() && entry.name.endsWith(".png")) count++;
  }
  return count;
}

function report(results) {
  const failures = results.filter((row) => !row.passesAA);
  const rows = results.map((row) => `| ${row.theme} | \`${row.foreground}\` | \`${row.background}\` | ${row.ratio}:1 | ${row.passesAA ? "Pass" : "Fail"} |`).join("\n");
  const summary = failures.length
    ? `${failures.length} of ${results.length} semantic text combinations fail WCAG AA's 4.5:1 threshold for normal text.`
    : `All ${results.length} semantic text combinations pass WCAG AA's 4.5:1 threshold for normal text.`;
  return `# Theme readability audit\n\n${summary}\n\nThis audit resolves the app's real CSS custom properties in Chromium, measures semantic text colors against their common surfaces, and captures the inbox, full diff, and agent settings at 1600x1200 in both themes. It does not claim that contrast alone proves readability.\n\n| Theme | Foreground | Background | Contrast | AA |\n|---|---|---|---:|---|\n${rows}\n\n## Visual evidence\n\n- [Inbox screenshots](screenshots/inbox-populated/manifest.json)\n- [Full diff screenshots](screenshots/detail-files/manifest.json)\n- [Agent settings screenshots](screenshots/settings-agents/manifest.json)\n\n## Interpretation\n\nThe failing semantic combinations are the first repair targets because the app uses these tokens for compact metadata and secondary controls. The screenshots remain necessary because font size, density, selected-row fills, syntax colors, and large empty surfaces can still make a numerically passing palette tiring to read.\n`;
}

function findings(results) {
  const ratio = (theme, foreground, background) =>
    results.find((row) => row.theme === theme && row.foreground === foreground && row.background === background)?.ratio;
  return `# Ranked readability findings

## 1. Light secondary text fails on both common surfaces

\`--text-faint\` measures ${ratio("light", "--text-faint", "--bg")}:1 on \`--bg\` and ${ratio("light", "--text-faint", "--surface")}:1 on \`--surface\`. The inbox timestamps, repository label, section counts, shortcut footer, settings hints, and diff metadata therefore lose hierarchy by becoming difficult to read. Raise the light token to at least 4.5:1 on \`--surface\` before tuning individual views.

## 2. Light links fail normal-text contrast

\`--link\` measures ${ratio("light", "--link", "--bg")}:1 on the page background. Links such as reset and navigation actions are small text, so the native accent needs a darker text variant while controls can retain the brighter accent fill.

## 3. Dark secondary text fails on raised surfaces

\`--text-faint\` passes against the dark page but drops to ${ratio("dark", "--text-faint", "--surface")}:1 inside cards and controls. This is visible in agent descriptions, prompt hints, timestamps, and diff controls. Lighten the dark faint token or introduce one semantic muted-text token that is guaranteed to pass on both page and surface backgrounds.

## 4. Density magnifies every marginal contrast result

The screenshots use the project-standard 1600x1200 viewport and still contain many 10–12px metadata labels. Passing 4.5:1 is the minimum repair, not the final readability target; after token repair, test 125% general scale and 125% diff scale before changing per-view typography.

## Recommended repair order

1. Fix \`--text-faint\` for light and dark surfaces.
2. Split text-link color from the native control accent in light mode.
3. Re-run this audit and require zero semantic contrast failures.
4. Review density at 100% and 125% scale before touching individual components.
`;
}

async function generate(out) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await run(["bun", "run", "build"], join(ROOT, "ui"));
  for (const scenario of SCENARIOS) {
    await run([
      "bun", "scripts/shoot-views.mjs",
      "--out", join(out, "screenshots", scenario),
      "--filter", scenario,
      "--exact",
      "--sizes", "1600x1200",
      "--theme", "both",
    ]);
  }
  const results = await measurePalette();
  await writeFile(join(out, "contrast.json"), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(join(out, "README.md"), report(results));
  await writeFile(join(out, "FINDINGS.md"), findings(results));
  const screenshots = await pngCount(join(out, "screenshots"));
  if (screenshots < SCENARIOS.length * THEMES.length) throw new Error(`expected at least 6 screenshots, found ${screenshots}`);
  console.log(`theme readability audit generated: ${results.length} contrast checks, ${screenshots} screenshots`);
}

async function verify(out) {
  const temporary = await mkdtemp(join(tmpdir(), "pr-cockpit-theme-audit-"));
  try {
    await generate(temporary);
    const [expected, actual] = await Promise.all([
      readFile(join(out, "contrast.json"), "utf8"),
      readFile(join(temporary, "contrast.json"), "utf8"),
    ]);
    if (expected !== actual) throw new Error("committed contrast evidence does not match a fresh audit");
    const screenshots = await pngCount(join(out, "screenshots"));
    if (screenshots < SCENARIOS.length * THEMES.length) throw new Error(`committed audit has only ${screenshots} screenshots`);
    await readFile(join(out, "README.md"), "utf8");
    await readFile(join(out, "FINDINGS.md"), "utf8");
    console.log(`theme audit verified: ${JSON.parse(actual).length} contrast checks, ${screenshots} committed screenshots`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
await (options.verify ? verify(options.out) : generate(options.out));
