# Temporary task execution binding

These patches add a missing public capability to the locked SDK versions. They do not establish an upstream bug or replace Pi's scheduler. The earlier lifecycle/closing patch remains removed.

| Package                            | Responsibility                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@earendil-works/pi-durable@1.1.0` | Optional `SubmissionExecution`, input admission, native queue/run/task persistence, bound task agent resolution, generation successors and compaction inheritance |
| `agents@0.28.0`                    | Forward `PiSubmitOptions.execution` to native Pi; no lifecycle changes                                                                                            |

```ts
await harness.submit(text, {
  session: '1',
  operationId: runId,
  whenBusy: 'followUp',
  execution: {
    model: { provider, modelId },
    thinkingLevel,
  },
});
```

The application freezes provider/model/effort in `app_requests` before enqueue. Pi then commits the binding with admission: queued input uses `pi.inbox`, active generation uses its task input and `pi.live.run` control state. Successors copy that run's binding; automatic compaction copies its originating generation's model and effort. There is no new application task, credential or result table.

The bound native `runtime.agent()` view resolves before sections, hooks, context-window checks and model checkpoint creation. Model transport wrappers may reject a call but must not substitute model/effort after prepare.

Bound inputs use `followUp` or `reject`, never `steer`. Queue mode `all` groups only consecutive selected inputs with identical bindings. Valid retries with the same request ID keep the original submission; malformed bindings and bound steering reject before deduplication. Unbound generations resolve the SDK session defaults. Automatic compaction pins the originating generation's resolved model and effort, including an unbound generation; manual compaction without execution uses session defaults.

Manual compaction can explicitly bind with `conversation.compact(instructions, context, { execution })`. Without an explicit binding, manual compaction retains native session defaults. Task input fields do not accept raw credential material. An immutable provider ID plus the native auth resolver can identify a credential version; all referenced versions must be registered on reconstruction. Missing bound models/credentials must fail, not fall back to a default. Real encrypted credential storage, credential rotation/revocation and BYOK UI are not implemented by this patch. Current deployment API keys remain deployment configuration.

Only distribution JavaScript and declarations are patched. Modified files drop references to stale source maps so errors report real distribution offsets. These are package patches, not application overrides of private methods. `pnpm install --frozen-lockfile` must apply both; do not upgrade either package independently without replaying the regression tests.

Run `pnpm typecheck`, `pnpm test:workers`, `pnpm test:hmr` and the browser model-selection/recovery tests when changing or removing these patches. The public regression coverage is in [task-binding tests](../tests/workers/task-binding.test.ts), [credential recovery tests](../tests/workers/byok.test.ts), and [execution-model tests](../tests/unit/execution-models.test.ts).

Remove the patches when an official public per-submission binding and compaction-inheritance interface passes the same tests. Do not carry the earlier closing patch forward. This v0.1 change requires provider in stored execution records; provider-less local test records are incompatible. No automatic migration or database reset is performed.

Removal must also verify existing persistence, not just fresh submissions. The original SDK can read a patched pending `pi.generation` version 1 record while ignoring its execution binding, silently selecting the current defaults. Queued bound inputs can remain in `pi.inbox` even when no generation task is active; raising only the generation task version would not protect those inputs. Drain all active, queued and background work before a deployment that changes the contract, or use an official explicit migration that preserves all bindings. Do not downgrade running data without such evidence. Check the persisted binding invariants against [task-binding tests](../tests/workers/task-binding.test.ts) and [recovery tests](../tests/workers/recovery.test.ts) before removing either patch.
