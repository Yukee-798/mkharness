# Source architecture

This document describes the native Pi Durable 1.3.0 implementation. The runtime starts in a new empty Worker/D1/DO/R2 environment. Earlier accounts, chats, tasks, credentials, MCP grants, Skills and browser commands are not imported. Local checks, deployment and real-provider acceptance are separate stages; follow [README.md](README.md) for installation and release preparation.

## Source ownership

| Location                                                | Responsibility                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/routes/`, `src/router.tsx`                         | TanStack application routing and Query setup                                                            |
| `src/browser/app/`                                      | Google session, navigation, directory, locale and theme                                                 |
| `src/browser/workbench/`                                | Panel selection and layout, developer contribution Interface, navigation and in-memory composer drafts  |
| `src/browser/chat/`                                     | Composer, queue and assistant-ui presentation                                                           |
| `src/browser/chat/session/`                             | Stable creation/submission receipts, HTTP/SSE remote, recovery, loaded history and assistant-ui binding |
| `src/browser/chat/messages/`                            | Messages, reasoning, tools and reply actions                                                            |
| `src/browser/models/`, `src/browser/settings/`          | Model credentials and account settings presentation                                                     |
| `src/browser/extensions/`                               | Browser contributions, resource drafts and shared extension presentation                                |
| `src/browser/ui/`, `src/browser/hooks/`                 | shadcn/ui components and shared presentation hooks                                                      |
| `src/server.ts`                                         | Worker assembly and `ChatSession` / `McpConnection` exports                                             |
| `src/server/index.ts`                                   | Authentication, Origin checks, HTTP assembly and errors                                                 |
| `src/server/chat/directory.ts`                          | D1 ownership, creation idempotency, frozen bindings and keyset listing                                  |
| `src/server/chat/routes.ts`, `protocol.ts`              | HTTP-to-DO adaptation and the actor/command/read/observe interface                                      |
| `src/server/chat/session-object.ts`                     | Native target resolution, admission, queue actions, Stop, deletion and resource writes                  |
| `src/server/chat/runtime.ts`                            | One Harness, paused opening, restoration, closure and failure eviction                                  |
| `src/server/chat/documents.ts`, `admission-recovery.ts` | Current-format native host documents and admission recovery                                             |
| `src/server/chat/queue-edits.ts`                        | Durable, bounded draft transfer receipts and explicit browser acknowledgement                           |
| `src/server/chat/policy.ts`                             | Conversation capability narrowing, fixed task authority and shared persistent execution budgets         |
| `src/server/chat/storage.ts`, `facts-index.ts`          | Official SQLite composition and atomic derived locators                                                 |
| `src/server/chat/read-model.ts`, `history.ts`           | Bounded pages, visible references, projections, observation handoff and buffering                       |
| `src/server/chat/observe.ts`                            | Read frames to AG-UI/SSE, heartbeat, reset and cancellation                                             |
| `src/server/models/`                                    | Model catalog, immutable credential versions, checkpoint aliases and HTTP settings                      |
| `src/server/extensions/`                                | Contribution contracts, declared document/page projections and output budgets                           |
| `src/server/mcp/`                                       | Deployment policy, frozen tool definitions and native MCP invocation bridge                             |
| `src/server/mcp/connections/`                           | Independent connection DO, OAuth, transport, authorization and dispatch receipts                        |
| `src/server/skills/`                                    | Package validation, immutable D1/R2 catalog, lazy native Skills bridge and management routes            |
| `src/server/http/`                                      | Bounded reads and public-network validation                                                             |
| `src/shared/`                                           | Serializable browser/server contracts and pure transformations                                          |
| `src/extensions/<feature>/`                             | Trusted native tools/tasks/hooks, scoped projections and browser renderers                              |
| `src/extensions/openui/panel/`                          | Input epochs, compute provenance, automatic-write budgets and panel lifecycle                           |

## Identity and authority

A product ChatId selects one `ChatSession` Durable Object and one Pi Session. The Session can contain a main native conversation, forks and task-owned child conversations. Their numeric IDs come from Pi; the browser never guesses a root ID. An omitted HTTP target is resolved at the DO edge, and internal operations carry an explicit native conversation ID.

| Fact                                                                       | Authority                                     |
| -------------------------------------------------------------------------- | --------------------------------------------- |
| Login identity, owner, chat directory, create hash and instance generation | D1                                            |
| Frozen user/deployment MCP definitions and selected Skill versions         | D1 creation transaction, then the DO manifest |
| Conversations, branches, task ownership, Inbox, history and results        | Native Pi SQLite                              |
| Prepared admission gaps, execution aliases and Stop state                  | Native session/conversation host documents    |
| Immutable credential ciphertext and versions                               | Models module / D1                            |
| MCP OAuth credentials, transport state and uncertain dispatch receipts     | Independent `McpConnection` DO                |
| Immutable Skill files                                                      | Private R2                                    |
| Read locators, browser pages, aliases, drafts and connection status        | Derived projections; no execution authority   |

The Worker checks authentication, Origin, owner and active directory status. It constructs `{chatId, ownerId, generation}` from D1. The DO validates that actor against its identity, current D1 row and stored manifest. An empty DO does not open Pi until this check succeeds. Deleted rows and stale generations cannot initialize a replacement Session.

## Creation and deletion

The browser freezes a create requestId before the first POST and retains it with an uncertain submission receipt. D1 enforces `UNIQUE(owner, create_request_id)`. The request hash covers canonical selection data, distinguishing account defaults from explicit empty selections. The directory row and user MCP, deployment MCP and Skill bindings commit in one D1 batch. A concurrent request or lost batch acknowledgement resolves the winning row and checks its original hash; it does not replace frozen bindings.

Listing uses an opaque `(updated_at, id)` keyset cursor scoped to the owner and returns active rows only. It is a mutable directory, not a snapshot of the whole list. A failed title/time projection after native acceptance cannot submit the message again.

Deletion covers the entire ChatId. The DO persists a local tombstone and cleanup alarm, refuses new work and closes its Harness. Cleanup deletes frozen bindings, changes D1 to a minimal `deleted` receipt, and only then erases DO content. The receipt retains ChatId, owner, generation, create requestId/hash and lifecycle; title and timestamps are cleared. Repeated delete is idempotent, while replaying the old create key returns `chat_deleted`. Failed cleanup keeps a durable future alarm and can continue after eviction. MCP uncertain-outcome receipts remain with their connection DO.

## Execution and recovery

`ChatSession` extends Cloudflare `DurableObject` directly. `ChatRuntime` uses Pi's public `Harness`, `createRegistry` and official `DurableObjectSqliteDatabase` / `SqliteStorage` adapter with the fixed `pi_` prefix. Pi packages are pinned to 1.3.0. There is one mutable Harness and one chat alarm owner. MCP's independent DO owns its own lifecycle.

Opening restores current AgentDoc/live checkpoint model aliases before scheduling resumes. API keys, OAuth, remote discovery and Skill bodies are resolved when needed rather than held inside constructor initialization. Runtime storage failure closes the native writer and evicts the DO; that incarnation does not install a second Harness.

Commands share a serialized admission/control line without holding it for an entire model generation. The host's small admission journal only spans the public configure-to-submit gap:

1. Validate the command and request hash, and complete earlier prepared admissions for that target.
2. Freeze model/credential references and validated action context; persist a recovery alarm.
3. Commit the execution binding, native configuration and prepared receipt together.
4. Look up native submission by requestId, then submit only if absent.
5. Record the native receipt and remove the pending input payload.

Prepared receipts also retain the native input IDs that preceded them. Recovery withdraws a prepared follower after an actual preceding run failed or was aborted; removing an unplaced queued input does not withdraw later work. Stop resolves task ownership rather than fork ancestry, so a task-owned child stops with its owner while an independent fork can continue. Concurrent attempts to finish the same Stop join one operation.

Pi owns placed/queued state and Inbox membership. Queue Edit atomically copies an unstarted input into a transfer receipt before native withdrawal. Its stable identity is the native target plus the original runId: retries return the same complete draft, including images, source and configuration. These receipts cannot execute input. The snapshot exposes only outstanding receipt identities, so a browser refresh can offer explicit recovery without overwriting an existing composer draft. Browser acknowledgement removes the private payload; unclaimed drafts expire after 24 hours, with at most 32 outstanding per chat. Steer changes native mode; Remove withdraws the selected unstarted input.

Stop records its control state before aborting the selected native conversation and owned subtree. Deletion atomically stores local intent and its alarm before changing D1 visibility, then closes the native writer. Its cold cleanup reads current native task records through public Storage and settles MCP obligations without opening a Harness or starting provider/tool execution. Only after that succeeds does it finish the D1 tombstone and erase local storage. Failed cleanup retains its intent and alarm. Erasure seals alarm maintenance, so delayed work cannot recreate storage. The alarm advances recovery, prepared admission, draft expiry, Stop and cleanup independently of a browser connection. Browser detach only releases observation.

Alarm writes and idle alarm removal share one ordering line. An admitted command reserves wakeup before its first asynchronous operation and holds that reservation until native placement or withdrawal settles; a stale idle inspection cannot erase that command's recovery alarm. Alarm maintenance never waits for the runtime's own initialization promise.

Configuration affects native model steps that have not prepared yet. Prepared generation/compaction checkpoints retain model, thinking level, endpoint and immutable credential version. Restoring a checkpoint does not select the newest key or fall back to a deployment model. Missing credentials or definitions fail the affected work without making completed history, Stop or deletion depend on provider availability.

Authorization and model budgets run at the provider boundary. Pi 1.3 may report and skip a throwing Generation hook, so such a hook cannot be the authorization gate. `ChatRuntime.conversationCreated` records `ProviderDoc.sessionId` → actual native conversation in the session-scoped `ModelTarget` document family within the same native commit. `guardModels` resolves `options.sessionId` through that mapping before a provider call and applies host policy and `beforeModel`. Missing mappings and capabilities fail closed. Tool hooks and actual execution both enforce policy, including safe tool recovery that skips the native hook.

`ConversationPolicy` is created in that same transaction. Child/fork capabilities can only narrow tools, MCP connections, Skills and models. Task-owned children have no external target eligibility; product reads, commands and observation return 404 for them. Ownerless forks retain their parent's external eligibility. The root input creates a persistent execution scope; compaction, forks, child creation and recovery share its accumulated reservations rather than recounting active context. Defaults are 20 native model steps (including compaction), 40 native tool tasks, depth 3, eight child/fork conversations and three concurrently executing children. Native TaskId reservations deduplicate retries; they do not count every network retry as a new step. An admitted root model configuration is separate authority from its input budget, so configuration changes still affect unprepared steps without resetting consumption. Child policy remains restricted to its inherited model set.

Task policy binds scope and capabilities before execution. Trusted host tasks that create conversations must call `bindExecutionTask` in their creation transaction; task derivation carries `fromTaskId`. An older background owner and its descendants keep the old scope after a new root input starts. There is no task-owner inference from the newest root input and no historical policy backfill.

`ExecutionBinding` restores immutable provider/model/credential aliases without embedding secrets. Thinking level comes from native configuration and each prepared checkpoint; the same alias/model can serve multiple thinking levels without changing its credential identity.

## Bounded reads and projections

`GET /api/conversations/:id/snapshot` always returns entries, history metadata, queue, pending state, Stop state and the actual native conversation ID. Optional `conversationId` selects a target. There is one envelope: unknown fields or missing required state produce a protocol error with a refresh instruction. The browser never loops through an older whole-history protocol.

The initial page targets 100 native entries and extends to preserve complete input/reply/tool cohorts. `GET /api/conversations/:id/history?cursor=...` reads older pages. Tokens bind ChatId, native conversation, before boundary and fixed upper boundary; invalid or cross-target cursors return `invalid_cursor`. Fork reads use Pi's visible history, including inherited entries. Resource reads verify the visible entry and exact tool result before applying extension validation.

Regenerate uses an exact visible answer → authoritative completed input receipt → visible input lookup. It works after successful compaction without scanning whole history. Inherited timing facts require visible output entries with exact `byTaskId` and matching assistant/callId relationships; one round's reused callId cannot prove another round's result. Generation completion is withheld when its tool outputs lie beyond the fork cut.

`ConversationReadModel` owns subscribe/snapshot handoff, terminal races, facts and bounded buffering. Its `open` operation returns initial frames, an async frame stream and a close operation. `observe.ts` only encodes those frames as AG-UI/SSE, including heartbeat and reset. Overflow closes the watcher and requests a fresh bounded snapshot; it never resubmits input.

`ConversationHistory` merges pages and current stream snapshots by native identity, retains entry annotations by revision and resets state when the native target changes. Pagination is single-flight, aborts on unmount and preserves a DOM scroll anchor without reconnecting the stream or replacing the composer. `ConversationRemote` provides snapshot/history, submit/create, queue, Stop and observation through the same HTTP seam; controlled test adapters replace network behavior.

Contributions declare native `stateDocuments`, derive conversation state with `projectConversation`, and attach page annotations with `projectHistory`. `taskReferences` identifies extra exact facts needed by a declared document. They receive selected page facts and documents, not an implicit scan of all completed history. The browser workbench collects namespaced `panels` from enabled browser contributions. One selected panel shares the existing assistant-ui runtime and conversation submission port. Desktop uses resizable panes; mobile uses a full-screen Sheet. Account-scoped local storage holds only opted-in resource references and layout; unsent text/images/model drafts remain in memory. Scheduled-task and marketplace routes are placeholders. See [the workbench implementation and developer Interface](WORKBENCH_DESIGN.md#13-首期实际实现与开发者接入).

OpenUI's `PanelSession` and draft saver retain input epochs, compute provenance, debounce, CAS, conflict and lost-acknowledgement recovery. Browser Worker and server QuickJS are separate compute adapters.

## Storage and cost boundaries

`app_read_tasks` and `app_read_submissions` contain only locators. `app_read_meta` tracks their read revision. `storage.ts` captures current public Storage writes and updates locators inside the same official SQL transaction as the native commit. A failed locator write rolls back both sides. Results are always re-read through Pi's public Storage interface.

The new empty store maintains locators from its first native write. There is no startup backfill, old table conversion or alternate read protocol. Execution aliases live in `ExecutionBinding` documents; admission receipts retain minimal identity/hash/state after acceptance. `app_resource_states` stores conversation-scoped resource state and CAS revision.

Admission receipts carry no unused sequence or duplicate execution-binding key, and Stop control stores only its consumed stopping flag. Native `AgentDoc` and prepared checkpoints identify execution bindings. Task locators retain id, conversation, assistant and status; submission locators retain id, conversation, entry, answer and status. Kind and request identity remain authoritative in native records instead of being copied into unused locator columns. These are current empty-environment definitions, with no schema conversion or legacy readers.

Measure idle pages and exact associated facts separately from active context: initial native `watchEvents` setup can still depend on the active context size. A bounded idle page is not evidence that active watch startup, compaction, provider work or cold recovery costs the same amount. Real-time frames fold incremental changes rather than repeatedly serializing every loaded old page.

## MCP, Skills and extension boundaries

User MCP scope is keyed by owner and connection ID. Deployment scope is keyed by owner and stable server ID; configuration revision is validated at dispatch and does not create another receipt namespace. Chat creation freezes tool descriptors outside chat initialization. The connection DO rechecks permissions, revision and credentials before dispatch, persists intent/result receipts and fails closed on an uncertain unsafe operation. Different chats, forks or children cannot bypass that logical connection's unknown-outcome guard. `customMcp=false` disables user management while retaining deployment-managed MCP.

The native result and its background acknowledgement task commit together. A lost confirmation RPC retries with a persisted checkpoint; Stop atomically transfers this obligation to a successor. Definitions remain installed when MCP exposure is disabled, and confirmation uses the immutable owner/connection/operation identity rather than current tool configuration. The call task also stores its immutable dispatch identity, so deletion can reconcile a remote result that preceded its native result commit. A known result can be acknowledged; an unknown unsafe outcome keeps the connection guard. Cleanup never dispatches the original remote operation again.

The connection's outstanding unsafe receipt query uses a partial index limited to dispatching, unknown and responded rows. Acknowledged tombstones stay available for idempotency without joining this guard index. Deployment bridge configuration needs only the owner and chat identity; native task context supplies the actual conversation target.

The native Skills bridge lists frozen metadata, lazily activates instructions and reads bounded private R2 resources. It uses Pi 1.3's `output` result contract. Skills are data: they do not grant tools, execute scripts or bypass MCP approval. Browser configuration, generated forms and OpenUI state writes also do not authorize external side effects.

Trusted extensions register native tools/tasks/prompts/hooks and explicit host resources/actions/controls. They use the selected native target; they do not open another runtime or create a second task queue. Provider-specific reconciliation stays inside its extension. Disabling OpenUI excludes its renderers, catalog, CSS, QuickJS and compute Worker from the build.

## Validation and release boundary

Tests are grouped by `unit`, `native`, `workers`, `e2e` and `hmr`. Test-only fixture conveniences call the production command/read/observe protocol; they are not shipped runtime aliases. Source paths have no compatibility forwarding modules.

Wrangler declares fresh SQLite DO exports and a native D1 migration chain starting at `migrations/0001_initial.sql`. `0002_google_accounts.sql` revokes legacy browser-only sessions and drops the retired identity flag without deleting users or their owned data. Apply it before deploying Google-only authentication. Local storage uses `.wrangler/native-state`; browser fixtures use separate native E2E storage/build output. The independent `mkharness-native-test` environment must pass real authentication, provider, MCP, Skills, OpenUI and offline-wake acceptance before a public-domain cutover. Keep old deployed resources separate until that cutover is approved and their work has drained or been explicitly stopped.
