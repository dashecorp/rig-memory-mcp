---
title: rig-memory-mcp Repository Lifecycle
description: CI, review, and merge ownership for the rig-memory-mcp repository
type: reference
audience: agents
updated: 2026-06-14
---

# rig-memory-mcp Repository Lifecycle

This repository is a dashecorp rig-managed repo. Pull request review and merge decisions are owned by rig-conductor; repository-local workflows only run validation or package publishing.

## Automation ownership

| Concern | Owner | Notes |
|---|---|---|
| Pull request intake | rig-conductor GitHub webhook | GitHub sends PR events to `POST /api/webhook/github` for conductor normalization. |
| Review routing | rig-conductor `ReviewScanService` / `ReviewRoutingPolicy` | Bot-authored PRs route automatically. Operator-authored PRs route when the `needs-review` label is present. |
| Merge gate | rig-conductor `MergeGate` | Merge requires Review-E approval, successful CI, an issue link, and no blocking labels. |
| CI | `.github/workflows/ci.yml` | Runs syntax checks, `node test.js` with a `pgvector/pgvector:pg16` service, and a Docker build check. |
| Package publish | `.github/workflows/publish.yml` | Publishes the package/image after normal repository events; it does not decide PR merge eligibility. |

## Retired workflows

| Workflow | Status | Reason |
|---|---|---|
| `.github/workflows/request-review.yml` | Removed | Legacy per-repo review requests target the retired `review-e-dashecorp` user path and duplicate conductor routing. |
| `.github/workflows/auto-merge.yml` | Removed | Legacy autonomous merge workflow used weaker local gates than conductor's merge gate. |
| `.github/workflows/auto-resolve-copilot-conversations.yml` | Removed | It only existed to re-trigger `Auto-merge` by workflow name and became orphaned when `auto-merge.yml` was removed. |

## Agent dispatch configuration

| File | Purpose |
|---|---|
| `.rig-agent.yaml` | Declares this repository as a Node stack for agent work dispatch. |
| `.rig-agent.yaml` `testCommand` | `node test.js` |
| `.rig-agent.yaml` `buildCommand` | `npm ci` |

`.rig-agent.yaml` configures how dispatched issue work runs. It does not enqueue Review-E work by itself; PR review routing remains controlled by rig-conductor policy and the `needs-review` operator opt-in label.

## Operator fallback

| Condition | Action |
|---|---|
| Webhook or conductor merge gate unavailable | Use a manual squash merge after Review-E approval and green CI. |
| Review not routed for an operator-authored PR | Add `needs-review` to opt into Review-E routing. |
