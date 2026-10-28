# ADR-0006: Refresh Ownership Boundaries

- Status: Accepted
- Date: 2026-10-28
- Project: graph-client-core#40; site Story#2289 / Feature#1479

## Context

A delayed transport completion could undo `invalidateTags`, replace a primed
envelope with obsolete data, and grant that response a fresh TTL. Simply deleting
the in-flight map entry also lets an obsolete finally handler delete a newer
request. This violates the consistency boundary required by site ADR-0021 and
NFR reliability, testability and memory-lifecycle requirements.

## Decision

Use the active refresh promise's identity as its ownership token. Record the
promise and advertised request tags before invoking the injected transport on a
microtask. This also covers synchronous throws and transport reentrancy. Only the
promise currently registered for a key can write that cache entry or remove the
active in-flight record. All completions retain existing telemetry semantics.

Invalidation removes cache entries and detaches work identified by the existing
cache tag index or advertised pending request tags. It returns the number of
cached entries removed, preserving the API even when it also fences pending-only
work. Tags first discovered in an uncached response cannot retrospectively match
an earlier tag invalidation; clients requiring that boundary must advertise tags
on their resolver request. Priming detaches previous work for the exact envelope
key and installs the explicit state. Versions are opaque and are never ordered.

Pre-boundary callers may finish with the original result/error. Detached work is
not cancelled and cannot change shared cache state or delete newer ownership.
Post-invalidation callers start independent current work, sharing it with other
current callers. Post-prime callers use normal cache/TTL rules; `forceRefresh`
starts current work. No public signature, key format, TTL, response/error contract
or infrastructure dependency changes.

Metadata is proportional to active refreshes and their advertised tags. There is
no generation/tombstone map retaining every historical key. This is not a global
cache capacity guarantee or cancellation/backpressure mechanism. Existing tag
membership replacement (#22), background refresh rejection (#39), key identity
(#45) and freshness evaluation (#46) retain their separate acceptance criteria.

## Alternatives and consequences

- A permanent generation counter per key was rejected because invalidated keys
  would retain unbounded lifecycle history.
- Deleting an in-flight entry without an identity check was rejected because old
  completion and finally handlers could still overwrite/delete current work.
- Globally fencing all pending requests was rejected because unrelated tags
  should keep their deduplication and cache results.
- Cancelling/retrying original callers would change transport and response
  contracts. The chosen policy fences shared writes while preserving callers.

Invalidation scans active request tag sets in addition to indexed cached keys;
normal cache hits and same-generation deduplication keep their current paths.

## Validation, rollout and release

Deterministic deferred transports and fake clocks test stale completion after
invalidation, opaque-version priming, immediate post-boundary callers, both
completion orders, obsolete failure/finally cleanup, overlapping/repeated and
pending-only tag invalidation, unrelated work, reentrancy and retained collection
sizes after detached requests settle. Preserve the existing stale/fresh/error
controls, >=80% coverage and changed-source LCOV inclusion.

Update README and Unreleased CHANGELOG; publish only through approved main CI
and production `cd.yml` with verified npm bytes/provenance. The parent remote flag
`cachedGraphReliabilityHardening` governs consuming-service adoption/rollback,
not package correctness. Host integration and enabled/disabled/rollback tests,
capabilities and release remain site Task#2290. No live setting is changed here.
Rollback pins the last qualified consumer package/path under that remote flag;
it must not imply that this old invalidation behavior is correct.
