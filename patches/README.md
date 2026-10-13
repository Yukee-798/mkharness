# Independent SDK defect fixes

Pi Durable 1.2.0 is installed **without a patch**. Model selection uses native `Conversation.configure()` / `AgentDoc` and generation/compaction checkpoints. MkHarness does not add per-submission execution fields or override private runtime methods.

The remaining `agents@0.28.0` patch has two independent, reproduced responsibilities:

| Fix                                                                           | Evidence and removal gate                                                                                                                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills bridge returns `output`, replacing its obsolete `content` field        | Real native activation/resource-read history in the Skills and lifecycle workerd tests. Remove when the upstream bridge implements the Pi 1.2 public result contract. |
| Release a failed, adopted PiHarness cache entry after Pi's Session has closed | Public workerd lifecycle tests reproduce a permanently cached failed Session and the opening/adoption race. Remove when unpatched upstream passes the same tests.     |

The cache fix waits for both native close and factory adoption, and checks handle identity before clearing the cache. It never starts another runtime, cancels healthy work, or clears an in-progress factory. The earlier general closing patch and per-task binding enhancement are removed.

## Native step configuration

A new message admission freezes its configuration update and immutable credential reference in the existing `app_requests` receipt. The host serial admission line applies older unfinished admissions first, checks the native request-ID receipt, then uses public `configure` and `PiHarness.submit`. These are **two durable commits**, not a claimed atomic native operation. A lost acknowledgement rolls forward from the saved receipt without rereading credentials or source state. An already accepted duplicate never reapplies its older configuration.

The configuration receipt is not a task binding. `pi.agent` owns the current conversation configuration. Generation `prepare` resolves it before prompt rendering and context-window checking and stores model/effort/options in its request checkpoint. A later tool successor or queued input prepares using current configuration. A native generation retry which returns to `prepare` also selects current configuration; restoring an existing request/poll checkpoint retains that checkpoint's model.

Compaction independently selects current configuration, then persists its summary request. It does not inherit the triggering run's credentials. Interrupted summary requests and summary retries retain that summary checkpoint.

Saving a Key in account settings alone does not configure running conversations. The next newly accepted message selects that immutable version and updates only its conversation. Credential aliases reference encrypted D1 versions, not mutable current-key slots. Cold start reinstalls aliases required by the native agent and unfinished request/summary checkpoints. Invalid/revoked/expired credentials and changed deployment-key fingerprints fail explicitly; no fallback to newer or deployment credentials.

Interruption after a provider accepted a request but before Pi committed its response can cause a repeated model request/billing. Step checkpoints do not imply exactly-once provider calls. Remote tool intents, reconciliation and unknown-outcome protection remain separate.

## Verification and deployment

Run `pnpm typecheck`, `pnpm test:workers`, `pnpm test:hmr` and browser recovery tests after changing these fixes. The native step contract is exercised in [step configuration tests](../tests/workers/task-binding.test.ts), [real D1 credential tests](../tests/workers/byok.test.ts), and [credential alias tests](../tests/unit/execution-models.test.ts).

This changes execution semantics. Finish or explicitly discard local active/queued/background work created under the former patched contract before switching. No historical compatibility shim, task migration or automatic database reset is included. Do not downgrade a live production workload which still depends on per-task binding.
