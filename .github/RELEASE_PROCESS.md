# Release Process

This repository uses Changesets for versioning and package publishing.

The release flow is intentionally split into two separate GitHub Actions workflows:

1. Prepare Release PR
2. Publish Release

This separation gives us control over when versions are prepared and when packages are actually published.

---

## Initial setup

Changesets must be installed and initialized in the repository.

Commands:

yarn add -D @changesets/cli  
yarn changeset init

This creates the `.changeset/` directory and initializes the Changesets config.

---

## High-level flow

### 1. Development happens on `develop`

All contributors (developers, external contributors) open PRs into the `develop` branch, not directly into `main`.

At this stage:
- features are developed
- fixes are implemented
- code is reviewed and tested
- multiple changes can accumulate safely

Nothing is prepared for release yet.

---

### 2. Maintainers prepare release metadata

Changesets are created by maintainers when they decide what should be included in the release.

Command:

yarn changeset

This opens an interactive prompt where the maintainer:
- selects package(s)
- selects version bump (patch/minor/major)
- writes a summary

This creates a file inside `.changeset/`.

Important:
- contributors do NOT need to create changesets
- maintainers define release scope
- only selected packages are included in release

---

### 3. Periodic merge from `develop` → `main`

Maintainers merge:

develop → main

This creates a release snapshot.

Important:
- only ready changes should be included
- `main` represents releasable state
- `develop` continues independently

---

### 4. Release PR is prepared automatically

After merge to `main`, workflow runs:

yarn changeset version

This:
- reads `.changeset/*`
- bumps versions
- updates changelogs
- removes processed changesets

It creates a PR:

chore: release packages

---

### 5. Release PR is reviewed and merged

Maintainer reviews:
- versions
- changelogs
- included packages

Then merges PR.

This is the release gate.

---

### 6. Packages are published after release PR merge

Workflow runs:

yarn changeset publish

This:
- finds unpublished versions
- publishes to npm

---

## Maintainer commands

Create changeset:

yarn changeset

Check status:

yarn changeset status

Apply versioning:

yarn changeset version

Publish (CI normally):

yarn changeset publish

---

## Recommended release flow

1. Checkout develop
2. Decide what to release
3. Run:

yarn changeset

4. Commit `.changeset/*`
5. Merge develop → main
6. CI creates release PR
7. Review PR
8. Merge PR → publish happens

---

## Why this flow exists

We avoid:
- auto publishing on every merge
- unfinished releases
- mixing features and hotfixes
- uncontrolled deploys

We want:
- controlled releases
- reviewable changes
- safe multi-package publishing

---

## Workflows

prepare-release.yml:
- runs on push to main
- runs yarn changeset version
- creates release PR

publish-release.yml:
- runs after PR merge
- runs yarn changeset publish

---

## Required secrets

NPM_TOKEN

Must:
- allow publishing
- support CI
- bypass 2FA if required

---

## Packages

Each package:
- must have name
- must have version
- must NOT be private if published
- must build correctly

Example:

{
  "name": "@open-mercato/example-package",
  "version": "0.1.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "publishConfig": {
    "access": "public"
  }
}

---

## Conventions

1. Use "private": true for unfinished packages
2. develop = integration branch
3. main = release snapshot
4. release PR = only release trigger

---

## Hotfix process

Option A:

1. branch from main
2. fix bug
3. run:

yarn changeset

4. merge to main
5. release PR updates
6. merge PR → publish

Option B:

merge hotfix back to develop

---

## Summary

Flow:

feature → develop → main → release PR → publish

Commands:

yarn changeset  
yarn changeset status  
yarn changeset version  
yarn changeset publish  

Meaning:

- changeset → define release
- status → inspect release
- version → prepare release
- publish → deploy to npm

---

Merge to develop:
- development only

Merge to main:
- prepares release

Merge release PR:
- publishes packages