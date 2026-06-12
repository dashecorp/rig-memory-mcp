---
title: "Troubleshooting"
description: "Common CI/release failures in rig-memory-mcp and how to fix them"
type: runbook
audience: both
updated: "2026-06-12"
---

# Troubleshooting

## Release Please

### `release-please` fails with "GitHub Actions is not permitted to create or approve pull requests"

**Symptom:** Every push to `main` produces a `failure` run for `.github/workflows/release-please.yml`. The `googleapis/release-please-action@v4` step ends with:

```
##[error]release-please failed: GitHub Actions is not permitted to create or approve pull requests.
```

The release PR is never created and main goes red.

**Cause:** The default `GITHUB_TOKEN` cannot create pull requests when the repo (or org) has **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"** disabled. This is the hardened default for `dashecorp` repos.

**Fix (workflow side — already applied):** The workflow now reads a PAT first and falls back to `github.token`:

```yaml
token: ${{ secrets.RELEASE_PAT || github.token }}
```

**Operator action — one of the following is required for the workflow to actually succeed:**

| Option | What to do | Notes |
|---|---|---|
| A. Set a PAT | Settings → Secrets and variables → Actions → New repository secret `RELEASE_PAT`. The PAT needs `repo` + `workflow` scope (classic) or `contents:write` + `pull-requests:write` (fine-grained). | Preferred — PAT-created PRs also trigger downstream workflow runs. |
| B. Enable the repo setting | Settings → Actions → General → Workflow permissions → check "Allow GitHub Actions to create and approve pull requests". | Simpler but the release PR's own CI will not auto-trigger (GITHUB_TOKEN limitation). |

If `RELEASE_PAT` is set but **expired/invalid**, the action will fail with `Bad credentials` instead. Rotate the PAT or delete the secret to fall back to `github.token`.

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
