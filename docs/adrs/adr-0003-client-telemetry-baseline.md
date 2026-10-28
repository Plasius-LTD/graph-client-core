# ADR-0003: Client Telemetry Baseline

## Status

- Accepted
- Date: 2026-03-06
- Version: 1.0

## Context

The framework-agnostic graph client is a critical entry point for cache behavior and transport outcomes. Without standardized telemetry, stale serving, cache misses, and fetch failures are hard to diagnose early.

## Decision

- Add optional `TelemetrySink` to `GraphClientOptions`.
- Emit client metrics for cache outcomes, query latency, refresh latency, inflight dedupe, and fetch errors.
- Emit structured errors for fetch/refresh failures.

## Consequences

- Host applications can observe client cache and transport health consistently.
- No runtime coupling to infrastructure SDKs; telemetry remains dependency-injected.

## Failure ownership clarification (2026-10-28)

Project Task #39 / site Story #2289 reproduced an unhandled rejection when a
stale query launched a refresh whose transport failed. Telemetry recorded the
failure, but did not consume the launched promise. This can terminate a Node
process under its strict rejection policy.

The stale-query launch site attaches a terminal rejection consumer. The shared
refresh retains its rejection and emits `CLIENT_REFRESH_FAILED` once per
transport failure, independent of the number of stale readers. Awaited
foreground callers, including ones joining that refresh, retain controlled
partial results and `CLIENT_FETCH_FAILED`. A background failure leaves the
existing snapshot available only under its normal TTL eligibility. Existing
refresh cleanup clears current ownership, and a later query may try again;
there are no automatic retries or process-global rejection listeners.

Swallowing errors inside shared refresh would falsely turn foreground failure
into success. A global rejection handler would hide unrelated application
failures. Both alternatives are rejected. Optional telemetry remains diagnostic;
the rejection consumer is present with or without a sink. No new dependency,
public API, cache policy, identity, capacity or tag-index contract is introduced.

Deterministic regressions cover concurrent stale readers, retained stale data,
once-per-operation telemetry, recovery and cold/forced/non-stale/expired
foreground errors. Isolated Node children use strict unhandled-rejection mode
without a global listener to prove continued operation. Existing refresh
invalidation/prime fencing tests remain mandatory. Validate LCOV, lint, types,
build, ESM/CJS packaging and the published consumer artifact.

Release through existing exact-main CI and main/production `cd.yml` OIDC
publication. Feature #1479's `cachedGraphReliabilityHardening` controls downstream
adoption/rollback; package correctness is unconditional. Actual adapter and
enabled/disabled/rollback checks remain on site Task #2290. This decision does
not enable a live flag or complete the host integration.
