---
title: "Troubleshooting"
description: "Common CI/release failures in rig-memory-mcp and how to fix them"
type: runbook
audience: both
updated: "2026-06-14"
---

# Troubleshooting

## Release Please

### `release-please` fails with "Bad credentials" or "not permitted to create … pull requests"

**Symptom:** Every push to `main` produces a `failure` run for `.github/workflows/release-please.yml`. The `googleapis/release-please-action@v4` step ends with one of:

```
##[error]release-please failed: Bad credentials — https://docs.github.com/rest
##[error]release-please failed: GitHub Actions is not permitted to create or approve pull requests.
```

The release PR is never created.

**Cause:** Two distinct credential failure modes:

| Error | Cause |
|---|---|
| `Bad credentials` | `RELEASE_PAT` is set but expired/invalid. The previous workflow expression `secrets.RELEASE_PAT \|\| github.token` picks any non-empty PAT — even an invalid one — over `github.token`. |
| `not permitted to create or approve pull requests` | `GITHUB_TOKEN` is being used but **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"** is disabled (the hardened default for `dashecorp` repos). |

**Workflow-side fix (applied #28):** The workflow now **probes `RELEASE_PAT` validity** before handing it to the action, and degrades gracefully so a credential outage doesn't turn main red:

| Probe outcome | Behavior |
|---|---|
| `RELEASE_PAT` set and valid (HTTP 200 on `/user`) | Run release-please with the PAT. Failures here are real failures. |
| `RELEASE_PAT` unset, or set but invalid | Emit a workflow warning. Run release-please best-effort with `GITHUB_TOKEN` under `continue-on-error: true`. If that also fails (repo setting disabled), the step ends with a workflow warning; main stays green. |

This means: as long as a regression isn't in release-please itself, main will not go red over a missing/expired PAT. The release PR simply won't get created until an operator fixes credentials.

**Operator action — one of the following is required for the release PR to actually get created:**

| Option | What to do | Notes |
|---|---|---|
| A. Set a valid PAT | Settings → Secrets and variables → Actions → repository secret `RELEASE_PAT`. The PAT needs `repo` + `workflow` scope (classic) or `contents:write` + `pull-requests:write` (fine-grained). | Preferred — PAT-created PRs also trigger downstream workflow runs. |
| B. Enable the repo setting | Settings → Actions → General → Workflow permissions → check "Allow GitHub Actions to create and approve pull requests". | Simpler but the release PR's own CI will not auto-trigger (GITHUB_TOKEN limitation). |

If you set a PAT then later rotate/revoke it, the workflow will detect the bad credential on the next push and degrade automatically — no rush to update the workflow.

---

### `release-please` proposes a version downgrade

**Symptom:** The action logs `updating from 2.1.1 to 1.2.0` (or similar where the proposed version is lower than `package.json`).

**Cause:** `.release-please-manifest.json` is the source of truth for "what was last released" — release-please computes the next version from that, not from `package.json`. If `package.json` is hand-bumped without going through a release-please PR, the manifest stays stale and the next computed version falls behind reality.

**Fix:** Set `.release-please-manifest.json` to match the highest released git tag (e.g. `v2.1.0` → `"2.1.0"`). release-please will then compute the next bump from commits since that tag.

```bash
# inspect the highest released tag
git tag -l 'v*' | sort -V | tail -1
# update manifest to match (without the v prefix)
```

---

### Tag prefix mismatch (`rig-memory-mcp-v1.1.0` vs `v2.1.0`)

**Symptom:** The action logs `looking for tagName: rig-memory-mcp-v1.1.0` but the actual repo tags are `v2.1.0`. release-please reports `Could not find releases` and treats every push as the first release.

**Cause:** With `release-type: node` and a scoped npm package name (`@dashecorp/rig-memory-mcp`), release-please defaults to prefixing tags with the package component. Existing tags do not use that prefix.

**Fix:** In `release-please-config.json`, set both the top-level and per-package overrides so tags stay `v<version>`:

```json
{
  "include-component-in-tag": false,
  "packages": {
    ".": { "component": "" }
  }
}
```
