# ADR-0002: Dual ESM and CJS Distribution

## Status

- Accepted
- Date: 2026-03-05
- Version: 1.0

## Context

Consumers across Plasius repos run in mixed ESM and CJS environments.

## Decision

Publish both ESM and CJS entry points using `tsup` with declaration files.

## Consequences

- Broader compatibility for backend and tooling runtimes.
- Slightly larger distribution output.
