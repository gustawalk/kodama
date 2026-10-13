# LESSONS - auto-maintained by scripts/lessons.py

> Machine-owned. Do NOT hand-edit. Changes are overwritten on the next `lessons.py` write.
> Canonical state lives in `.specs/lessons.json`. Edit lessons only via the script.
> promote_threshold=2 distinct features · window_days=45 · quarantine_threshold=2
> per-signal promotion overrides: gate_fail=1, surviving_mutant=1 (machine-observed signals promote on first sighting)

## Confirmed (load these at Specify/Design)

Corroborated across multiple features. Safe to apply as guidance.

### L-001 - When a broadcast must reach every subscriber, test with at least two subscribers and assert delivery to each.
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `examples/chat.test.js` · harmful: 0
- features: socket-chat
- evidence: examples/chat.test.js:36 (examples/chat.test.js)
- last seen: 2026-10-13T00:07:12Z

## Candidates (under observation - do NOT load as guidance yet)

Seen once or not yet corroborated. Tracked, not trusted.

_none_

## Quarantined (failed when applied - ignore)

A confirmed lesson that recurred alongside failure. Kept for the maintainer to review.

_none_
