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
