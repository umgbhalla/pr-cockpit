# Theme readability audit

4 of 24 semantic text combinations fail WCAG AA's 4.5:1 threshold for normal text.

This audit resolves the app's real CSS custom properties in Chromium, measures semantic text colors against their common surfaces, and captures the inbox, full diff, and agent settings at 1600x1200 in both themes. It does not claim that contrast alone proves readability.

| Theme | Foreground | Background | Contrast | AA |
|---|---|---|---:|---|
| light | `--text` | `--bg` | 15.76:1 | Pass |
| light | `--text-dim` | `--bg` | 4.88:1 | Pass |
| light | `--text-dim` | `--surface` | 4.52:1 | Pass |
| light | `--text-faint` | `--bg` | 3.36:1 | Fail |
| light | `--text-faint` | `--surface` | 3.11:1 | Fail |
| light | `--md-body` | `--bg` | 9.89:1 | Pass |
| light | `--link` | `--bg` | 4.02:1 | Fail |
| light | `--ready` | `--bg` | 5.42:1 | Pass |
| light | `--review` | `--bg` | 5.57:1 | Pass |
| light | `--fail` | `--bg` | 5.93:1 | Pass |
| light | `--merged` | `--bg` | 6.63:1 | Pass |
| light | `--code-fg` | `--code-bg` | 14.58:1 | Pass |
| dark | `--text` | `--bg` | 16.01:1 | Pass |
| dark | `--text-dim` | `--bg` | 8.08:1 | Pass |
| dark | `--text-dim` | `--surface` | 6.29:1 | Pass |
| dark | `--text-faint` | `--bg` | 5.54:1 | Pass |
| dark | `--text-faint` | `--surface` | 4.32:1 | Fail |
| dark | `--md-body` | `--bg` | 13.28:1 | Pass |
| dark | `--link` | `--bg` | 4.92:1 | Pass |
| dark | `--ready` | `--bg` | 9.24:1 | Pass |
| dark | `--review` | `--bg` | 8.74:1 | Pass |
| dark | `--fail` | `--bg` | 5.78:1 | Pass |
| dark | `--merged` | `--bg` | 5.2:1 | Pass |
| dark | `--code-fg` | `--code-bg` | 13.87:1 | Pass |

## Visual evidence

- [Inbox screenshots](screenshots/inbox-populated/manifest.json)
- [Full diff screenshots](screenshots/detail-files/manifest.json)
- [Agent settings screenshots](screenshots/settings-agents/manifest.json)

## Interpretation

The failing semantic combinations are the first repair targets because the app uses these tokens for compact metadata and secondary controls. The screenshots remain necessary because font size, density, selected-row fills, syntax colors, and large empty surfaces can still make a numerically passing palette tiring to read.
