# First-install State Implementation Plan

> **For agentic workers:** Execute inline with superpowers:executing-plans; user has approved implementation.

**Goal:** Gate all fish menus for new installs and restore settings exports during onboarding.
**Architecture:** Hello owns persistent first-use state. Host captures installation evidence before defaults; migration supplies durable committed-import evidence. All registered fish pages share one gate; onboarding reuses the settings importer.
**Tech Stack:** JavaScript, React, Node filesystem, existing migration transactions.
**Spec:** docs/hello-installation-state-design.md

## Global Constraints
- No new archive format, storage marker or import pipeline.
- Preserve existing installations, partial setup recovery and platform storage adapters.
- Gate only ChonkyFish pages; never mount target pages before state is known.

## Review Focus
- Restart before first UI visit must preserve new-install classification (task 1).
- Empty directories differ from legacy user data (task 1).
- Successful import followed by failed Hello write must recover without replay (task 1).
- Loading failures and every menu must fail closed (task 2).
- Failed/cancelled import must not release the gate or overwrite imported identity (tasks 1–2).

### Task 1: Persist installation classification and reconcile imports
**Files:** core/modules/hello/{schema,service}.js; app/shared/storage/hello/installation.js; app/shared/storage/migration/repository.js; app/dsh/host/index.js; core/modules/hello/tests/run-installation.mjs; core/modules/hello/tests/run-core.mjs.
**Interfaces:** initializeHelloInstallation({resources,syncDirectory}) -> Promise<boolean> (existing install); migration repository readCommittedImport() -> Promise<string|null>; Hello accepts installationExisting and readCommittedImport ports.
- [x] Add tests for clean install, empty directories, each legacy resource, restart, corrupt state, committed/failed import and failed completion write.
- [x] Run tests and observe failures.
- [x] Implement early initialization and committed-import reconciliation using existing owners.
- [x] Run Hello and migration suites; expect PASS.

### Task 2: Gate all pages and reuse importer
**Files:** app/dsh/ui/hello/panel.js; app/dsh/ui/settings/panel.js; app/dsh/build.mjs; app/dsh/ui/hello/tests/run-client.mjs; app/dsh/ui/hello/tests/run-gate.mjs; app/dsh/ui/settings/tests/run-client.mjs.
**Interfaces:** createHelloGate(Page,t) -> React component; createMigrationSettings(t,{importOnly}) -> React component; existing migration-complete event triggers authoritative reload.
- [x] Add tests for all registered pages, fail-closed retry, completion, unmount cleanup, import-only preflight/cancel/error/success.
- [x] Run tests and observe failures.
- [x] Remove Hello menu and bypasses; add gate and import-only UI.
- [x] Build client and run relevant tests; expect PASS.

### Task 3: Review and delivery
- [x] Review complete diff and update docs to reflect implemented behavior.
- [x] Run relevant integration checks, resolve findings, record results here.
- [x] Leave changes reviewable in current checkout; do not commit/push without a user request.

## Execution ledger
- User explicitly approved implementation; continue without a second plan approval.
- Ruling: keep current checkout and leave changes uncommitted; no branch/publication operations are necessary.

- Task 1: complete. Installation/core tests observed failing before implementation; Hello + migration suites passed.
- Task 2: complete. Menu absence/gating tests observed failing before implementation; importer, gate and generated bundle tests passed.
- Final review: independent reviewer found old skipped drafts and settings feedback unmount; both reproduced with failing tests and fixed.
- Ruling: add optional installationVersion within Hello state to distinguish reliable pre-layout classification from old bypassable drafts; required by legacy evidence found in review.
- Ruling: fix Host migration's perception stop-under-lock failure exposed by real export/import integration. Runtime quiescence performs no preference write; transaction remains the sole publisher.
- Dependency setup: npm ci --include=dev --ignore-scripts restored missing local build dependencies without lockfile changes.
- Final verification: npm test passed; npm run build and generated Client startup checks passed. After the final legacy-classification refinement, npm run test:hello passed again. git diff --check passed.
- Review follow-up: old abandoned/completed operation history does not block existing-user detection; explicit social config/binding files are included as evidence. Pending partial operations remain recoverable.
- Validation limit: automated Host/React fixtures and real archive round-trip; no live DSH GUI acceptance run.
