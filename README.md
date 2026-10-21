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
  requests: [{ resolver: "user.profile", key: "user:1" }],
});

console.log(result.results["user:1"]?.data);
```

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
