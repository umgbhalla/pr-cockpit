# Ranked readability findings

## 1. Light secondary text fails on both common surfaces

`--text-faint` measures 3.36:1 on `--bg` and 3.11:1 on `--surface`. The inbox timestamps, repository label, section counts, shortcut footer, settings hints, and diff metadata therefore lose hierarchy by becoming difficult to read. Raise the light token to at least 4.5:1 on `--surface` before tuning individual views.

## 2. Light links fail normal-text contrast

`--link` measures 4.02:1 on the page background. Links such as reset and navigation actions are small text, so the native accent needs a darker text variant while controls can retain the brighter accent fill.

## 3. Dark secondary text fails on raised surfaces

`--text-faint` passes against the dark page but drops to 4.32:1 inside cards and controls. This is visible in agent descriptions, prompt hints, timestamps, and diff controls. Lighten the dark faint token or introduce one semantic muted-text token that is guaranteed to pass on both page and surface backgrounds.

## 4. Density magnifies every marginal contrast result

The screenshots use the project-standard 1600x1200 viewport and still contain many 10–12px metadata labels. Passing 4.5:1 is the minimum repair, not the final readability target; after token repair, test 125% general scale and 125% diff scale before changing per-view typography.

## Recommended repair order

1. Fix `--text-faint` for light and dark surfaces.
2. Split text-link color from the native control accent in light mode.
3. Re-run this audit and require zero semantic contrast failures.
4. Review density at 100% and 125% scale before touching individual components.
