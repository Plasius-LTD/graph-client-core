# @plasius/graph-client-core

[![npm version](https://img.shields.io/npm/v/@plasius/graph-client-core.svg)](https://www.npmjs.com/package/@plasius/graph-client-core)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Plasius-LTD/graph-client-core/ci.yml?branch=main&label=build&style=flat)](https://github.com/Plasius-LTD/graph-client-core/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/codecov/c/github/Plasius-LTD/graph-client-core)](https://codecov.io/gh/Plasius-LTD/graph-client-core)
[![License](https://img.shields.io/github/license/Plasius-LTD/graph-client-core)](./LICENSE)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-yes-blue.svg)](./CODE_OF_CONDUCT.md)
[![Security Policy](https://img.shields.io/badge/security%20policy-yes-orange.svg)](./SECURITY.md)
[![Changelog](https://img.shields.io/badge/changelog-md-blue.svg)](./CHANGELOG.md)

Framework-agnostic graph client runtime with normalized cache and stale policy controls.

Apache-2.0. ESM + CJS builds. TypeScript types included.

---

## Requirements

- Node.js 24+ (matches `.nvmrc` and CI/CD)
- `@plasius/graph-contracts`

---

## Installation

```bash
npm install @plasius/graph-client-core
```

---

## Exports

```ts
import {
  GraphClient,
  type GraphTransport,
  type GraphTransportResponse,
  type GraphClientOptions,
  type GraphQueryOptions,
} from "@plasius/graph-client-core";
```

---

## Quick Start

```ts
import { GraphClient } from "@plasius/graph-client-core";

const client = new GraphClient({
  transport: {
    async fetch(request) {
      return {
        data: { id: request.key },
        version: 1,
        tags: ["user"],
        source: request.resolver,
      };
    },
  },
  telemetry,
});

const result = await client.query({
  requests: [{ resolver: "user.profile", key: "user:1", tags: ["user"] }],
});

console.log(result.results["user:1"]?.data);
```

---

## Invalidation and priming during refresh

`invalidateTags(tags)` removes matching cached entries and detaches their pending
refreshes. It also detaches initial pending requests whose advertised
`ResolverRequest.tags` intersect the invalidation, even before an entry exists.
Its return value counts removed cache entries, so invalidating only pending work
returns zero. Advertise tags on requests when invalidation must cover initial
fetches; response-only tags cannot be known until a response is cached.

`prime(envelope)` makes that envelope authoritative for its exact cache key and
detaches any earlier refresh for the key. Versions remain opaque: priming is an
explicit ownership boundary, not a numeric or lexical version comparison.

Detached work is not cancelled. Callers that already awaited it can receive its
original result or error, but its completion cannot populate the cache, overwrite
a prime/newer refresh, or remove newer pending work. Callers after invalidation
start a current fetch; callers after priming use that envelope under normal TTL
rules, or start a current fetch with `forceRefresh`. Concurrent current callers
still share one fetch. Ownership is recorded before transport invocation, including
synchronous transport failure or reentrant invalidation.

Ownership metadata exists only for active refreshes; no per-key generation history
is retained. This does not impose a cache capacity limit, change existing key/TTL
contracts, or resolve the separately tracked tag-index replacement work in #22.
See [ADR-0006](docs/adrs/adr-0006-refresh-ownership-boundaries.md).

The consuming-service flag `cachedGraphReliabilityHardening` controls adoption and
rollback of the published fix (site Story #2289 / Task #2290). Package correctness
is unconditional. Host capabilities, enabled/disabled/rollback tests and approved
site deployment remain the consumer's responsibility; no live flag is changed here.

---

## Development

```bash
npm run clean
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

---

## Telemetry

`GraphClientOptions` accepts a `telemetry` sink (`TelemetrySink` from `@plasius/graph-contracts`).

When a query returns an eligible stale snapshot, it owns the background refresh's
rejection. A failed refresh preserves that snapshot until its hard TTL and does
not cause an unhandled promise rejection, even without telemetry. Concurrent
readers still share one fetch; failure clears pending work so a later query can
attempt another refresh. The client does not automatically retry.

`CLIENT_REFRESH_FAILED` is emitted once per failing transport operation when a
sink is supplied. Stale callers keep their successful stale result; they do not
emit `CLIENT_FETCH_FAILED`. Foreground misses, `allowStale: false`, `forceRefresh`
and hard-expired reads still return controlled partial results with
`CLIENT_FETCH_FAILED`, including callers that join a background refresh. No
process-global rejection handler is installed. See
[ADR-0003](docs/adrs/adr-0003-client-telemetry-baseline.md).

Emitted metrics/errors include:

- `graph.client.cache.outcome` (`fresh_hit` / `stale_hit` / `miss`)
- `graph.client.query.latency`
- `graph.client.refresh.latency`
- `graph.client.fetch.error`
- `graph.client.inflight.deduped`

The client fails fast on invalid query payload shapes using `isGraphQuery`.

---

## Architecture

- Package ADRs: [`docs/adrs`](./docs/adrs)
- Cross-package ADRs: `plasius-ltd-site/docs/adrs/adr-0020` to `adr-0024`

---

## License

Licensed under the [Apache-2.0 License](./LICENSE).

<!-- BEGIN PLASIUS RELEASE INTEGRITY -->
## Release integrity

CI keeps the administrative contributor registry outside Git and npm package
artifacts using exact, case-normalised path checks. CI runs on approved
self-hosted Linux/X64 runners in `Public CI - Quarantined`, using trusted
repository pushes only. Pull-request events never execute repository code on
these runners. The group admits only selected repositories and workflow refs;
`main` is admitted, and reviewed delivery branches require a temporary explicit
admission removed after verification. Checkout credentials and package-manager
cache finalization are disabled; installs use the committed lockfile with `npm ci`.
All lint, type, audit, build, package, artifact and >=80% line-coverage gates remain
mandatory, with bounded 15-minute validation and 10-minute artifact jobs.
Publication uses the GitHub-hosted `production` job with Node 24 and a pinned
npm 11.6.2 client. It is token-free and proceeds only while the prepared SHA
is the exact `main` head after successful push-triggered CI. Do not dispatch CD
until the npm trusted-publisher binding is verified.

The parent rollout flag `platform.public-artifact-integrity.enabled` stages public
restoration; enabled or disabled, mandatory source/package admission is enforced.
Rollback disables CI/CD or removes the affected workflow admission from the runner
group. Never restore the administrative registry, add hosted CI fallback, or use a
long-lived npm write token. See [ADR-0005](docs/adrs/adr-0005-quarantined-push-ci.md).
<!-- END PLASIUS RELEASE INTEGRITY -->
