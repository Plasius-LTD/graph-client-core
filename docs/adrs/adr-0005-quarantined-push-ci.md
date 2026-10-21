# ADR-0005: Quarantined Trusted-Push CI

- Status: Accepted
- Date: 2026-10-21
- Project: graph-client-core#23; plasius-ltd-site#1626 / Feature#1597
- Supersedes: only the CI runner choice in ADR-0004

## Context

The authoritative Project Task and parent Story require approved self-hosted
Linux/X64 CI with no hosted fallback. The hosted CI change documented in ADR-0004
and its test contradicted that requirement. Existing successful npm publications
do not establish runner-policy acceptance. This decision follows the unchanged
Project criteria; it does not amend them.

## Decision

Both `ci.yml` jobs use the literal `Public CI - Quarantined` group and
`[self-hosted, Linux, X64]` labels. Only repository push events trigger CI, and
both jobs also require the exact trusted repository and push event. Forks, pull
requests, `pull_request_target`, callable workflows, dispatch inputs and dynamic
runner selectors cannot admit PR-head code. The group independently restricts
selected repositories and workflow refs. Trusted maintainer branches can run
before merge only with a reviewed temporary explicit workflow admission; remove
that admission after delivery and verify the original allowlist is restored.

Checkout does not persist credentials, npm cache finalization stays disabled,
and `npm ci` uses the committed lockfile without legacy peer-resolution bypass.
Baseline clean install proves the bypass unnecessary. Retain lint, type checking,
runtime audit, build, coverage >=80%, path-only artifact integrity and final
package-manifest checks. Validation has a 15-minute timeout; artifact admission
has a 10-minute timeout. Dependencies and public runtime contracts are unchanged.

Package publication remains isolated on literal `ubuntu-latest` through
`cd.yml` on `main` and `production`, using exact-SHA successful push CI,
immutable bundles, current-main mutation fences and npm OIDC provenance. No
new package, token fallback, branch/environment protection setting or capability
is introduced. Existing environment policy is observed, not redefined here.

## Alternatives and consequences

Hosted CI would preserve the implementation mismatch. Admitting PR events or
all workflows to self-hosted capacity would broaden the approved trust boundary.
An unqualified Default runner group would bypass quarantine. These alternatives
are rejected. Missing approved capacity/admission blocks CI and release rather
than selecting another runner class. Trusted branch push CI replaces PR-event
CI, so required checks must be assessed on the exact PR head commit.

## Rollout and rollback

The existing stored `platform.public-artifact-integrity.enabled` flag controls
staged public restoration, not mandatory integrity enforcement. Enabled,
disabled and rollback states all retain admission checks. No live flag is changed.
Rollback disables the workflow/channel or removes the affected workflow admission;
it never restores the prohibited administrative path or changes runner class.

## Verification and release

Workflow regressions first fail against hosted/PR CI, then require the trigger,
repository, group/labels, timeouts, credential/cache and quality boundaries for
every job. Run coverage, lint, types, build, artifact/pack checks and actionlint;
record actual runner identity and exact commit for branch/main CI. Merge through
a PR and use the existing two-phase CD with a fresh version. Verify registry
bytes/provenance and the GitHub release before the Task is Done. UI accessibility,
SEO and backend Container App secretRef checks are N/A for this package workflow.
