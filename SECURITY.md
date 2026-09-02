# Security Policy

## Supported versions

Only the latest release is supported. Security fixes are not backported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository
(Security tab -> Report a vulnerability) rather than opening a public issue.
We'll acknowledge reports within 7 days.

## Why this project is sensitive

BunnyLol holds `declarativeNetRequest` plus host permissions on three search
engines (Google, Bing, DuckDuckGo), so a routing bug here is a browsing-data
bug — it can redirect searches somewhere the user did not intend. Surfaces
that matter most for a security review:

- DNR rule generation and the `redirect (1) < escape (2) < allow (3)` rule
  priority in `src/lib/dnr.ts`.
- The passthrough/escape path (`FORCE_SEARCH_PREFIXES` in `src/lib/types.ts`)
  that lets a user force a plain search.
- URL construction in `src/lib/handlers.ts`.
- The JSON import parser in `src/lib/storage.ts`.
- Anything that could put untrusted text into the DOM as markup rather than
  as text.

## Out of scope

A shortcut whose destination stopped working because a third-party service
changed its URL shape is a bug report, not a security issue.
