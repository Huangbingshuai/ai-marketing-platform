---
name: develop-workflow-node
description: Develop or refactor one node in any of this repository's five fixed AI marketing workflows. Use when implementing a workflow node across Web, API, contracts, or workers, especially when upstream revisions, WorkingArtifact outputs, downstream stale state, async tasks, or project isolation must stay aligned.
---

# Develop Workflow Node

## 1. Establish the boundary

1. Read the root `AGENTS.md`, every applicable nested `AGENTS.md`, and the matching `agent-guide.md` under `docs/workflows/`.
2. Read the confirmed plan in the matching `docs/**/plans/` directory if the task names one.
3. Identify the exact workflow and node. Write down:
   - direct upstream artifacts and revisions;
   - editable draft state;
   - confirmation/commit boundary;
   - output `WorkingArtifact` key and content;
   - direct downstream consumers and stale rule.
4. If these cannot be derived from code and documents, stop and report the ambiguity instead of inventing a second flow.

## 2. Inspect before designing

- Find the current Web route/page, API module, contract and Worker entry for the node.
- Trace existing requests and state transitions end to end.
- Reuse project context, task, artifact and asset abstractions already present.
- For frontend work based on a frozen prototype, also use `$reproduce-prototype-ui`.

## 3. Implement one vertical slice

1. Change shared contracts first when cross-process data changes.
2. Implement server validation, project isolation, idempotency and persistence.
3. Implement Worker behavior only if the node has a real asynchronous/model step.
4. Connect the formal frontend to the API and preserve the node's prototype-defined UI.
5. Do not rewrite adjacent nodes unless their public contract must change.

## 4. Preserve revision semantics

- Auto-save editing into node draft state without increasing artifact revision.
- On explicit confirmation, normalize the content and compare its fingerprint with the latest confirmed artifact.
- Increase revision only when confirmed business content changed.
- Persist the exact upstream `artifactId + revision` consumed by the result.
- Mark only existing downstream results that consumed an older revision as stale.

## 5. Verify

- Run focused unit/integration tests for the changed layer.
- When contracts changed, verify Web, API, Contracts and Worker consumers.
- Run type or syntax checks, relevant build checks and `git diff --check`.
- For UI, verify browser states and compare with the frozen prototype.
- Report commands actually run, failures, remaining risks and intentional deviations.
