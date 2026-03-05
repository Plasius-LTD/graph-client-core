# ADR-0001: Package Scope and Boundaries

## Status

- Accepted
- Date: 2026-03-05
- Version: 1.0

## Context

@plasius/graph-client-core is part of the cached graph platform and needs a single responsibility with minimal overlap versus sibling packages.

## Decision

- Keep @plasius/graph-client-core focused on its package-specific concern only.
- Depend on shared contracts and ports instead of site-specific modules.
- Avoid runtime coupling to unrelated graph packages.

## Consequences

- Improves reuse and testability.
- Requires explicit interface contracts between packages.
