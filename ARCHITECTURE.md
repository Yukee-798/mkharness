# Source architecture

## Ownership

| Location                                | Responsibility                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/routes/`, `src/router.tsx`         | TanStack application routing and Query setup                                                                         |
| `src/browser/app/`                      | Session bootstrap, navigation, conversation directory, locale and theme                                              |
| `src/browser/chat/`                     | Composer, queue and chat presentation                                                                                |
| `src/browser/chat/session/`             | Conversation submission, recovery, queue races, history windows, message identity and HTTP/SSE/assistant-ui adapters |
| `src/browser/chat/messages/`            | assistant-ui message, reasoning, tool and reply presentation                                                         |
| `src/browser/models/`                   | Model selection and credential settings presentation                                                                 |
| `src/browser/settings/`                 | Settings dialog composition                                                                                          |
| `src/browser/extensions/`               | Browser extension contracts, discovery, context, decorations and resource drafts                                     |
| `src/browser/ui/`, `src/browser/hooks/` | Shared shadcn/ui components and presentation hooks                                                                   |
| `src/server/index.ts`                   | HTTP assembly, authentication, origin checks and error responses                                                     |
| `src/server/conversations/`             | Owned routes, DO orchestration, receipts, derived read indexes and conversation read model                           |
| `src/server/models/`                    | Catalog, credential versions, accepted destinations, execution binding and routes                                    |
| `src/server/extensions/`                | Contribution assembly/validation, state and tool projections, output budgets                                         |
| `src/server/mcp/`                       | Deployment-managed MCP and uncertain-outcome records                                                                 |
| `src/server/mcp/connections/`           | User-owned MCP connections, OAuth, permission checks and management routes                                           |
| `src/server/skills/`                    | Package validation, immutable D1/R2 versions, sources and management routes                                          |
| `src/server/http/`                      | Bounded body reading and public-network checks shared by host and extensions                                         |
| `src/shared/`                           | Browser/server contracts and pure data transformations                                                               |
| `src/extensions/<feature>/`             | Feature-specific tools, prompts, browser renderers and settings                                                      |
| `src/extensions/openui/panel/`          | Panel input epochs, compute provenance, automatic-write budgets and lifecycle                                        |

## Entry points and invariants

- `src/server.ts` assembles the Worker and exports durable classes. `src/server/index.ts` applies authentication and origin checks before mounting feature routes. Conversation routes check ownership before accessing a DO.
- `extensions.config.ts` enables deployment-owned capabilities; `src/extensions/server.ts` and `src/extensions/browser.ts` retain separate static activation lists. The resolved configuration is passed to factories, including MCP's `custom` option.
- Pi/PiHarness owns task identity, queue membership, scheduling, history and recovery. One conversation retains one DO, one private SQLite store and one active Pi runtime. Host receipts retain idempotency and immutable credential references. Browser caches and derived indexes do not authorize or schedule work.
- Admission, queue actions, Stop and deletion remain serialized by `ConversationAgent`. `ConversationReadModel` owns snapshot/observation bootstrap, fact loading, terminal races and idempotent close. `observe.ts` is its SSE adapter.
- `useConversationSession` owns recovery revisions, queue epochs, submission receipts, active-run filtering, retry/backoff and loaded history. `Chat.tsx` owns composer text and layout; `ChatRuntime.tsx` renders the session view through assistant-ui primitives. The internal runtime adapter owns message aliases and imports without remounting the composer or reattaching a run for pagination.
- The `ConversationRemote` seam has a production HTTP adapter and controlled in-memory test adapters. Network snapshot/history envelopes are decoded against `src/shared/conversation.ts`; Pi entry payloads retain their extensibility.
- Core extension code lives under `server/extensions/` and `browser/extensions/`. Concrete capabilities, including MCP/Skills settings, live under `extensions/<feature>/`.
- Generic request-body and DNS/IP checks live in `server/http/`, so credentials and management routes do not import Web tool registration.
- Credentials and MCP tokens stay in server storage. Browser MCP resources are presentation adapters. A Skill is guidance and resource data; it does not install executable code or grant tool permissions.
- OpenUI's `PanelSession` owns input epochs, actual compute-result provenance, per-StateSync write chains and disposal. Renderer/catalog components call its actions. The existing draft saver continues to own debounce, CAS, conflict and acknowledgement-loss recovery. Browser Worker and server QuickJS remain separate compute adapters.
- Disabling OpenUI must exclude its renderer, CSS, catalog integration, QuickJS and compute Worker from the build.

## History read contract

The browser requests `GET /api/conversations/:id/snapshot?view=window`. Once derived indexes are ready, the response contains the latest history window and `history: { olderCursor?, upperEntryId, revision, annotations }`. The initial page targets 100 native entries. This is a soft limit: the read extends to include the user input, completed reply and leading tool round needed by the page's projections.

`GET /api/conversations/:id/history?cursor=...` reads an older window. Its cursor fixes the upper entry boundary and moves backwards using native IDs. Concurrent new entries are obtained through observation or a fresh snapshot, not inserted into an old page. Invalid cursors return `invalid_cursor`.

The viewport loads older pages on upward scrolling near the top. Requests are single-flight and aborted when the view unmounts. Failed pages have an explicit retry button. A DOM anchor is restored after assistant-ui imports the older messages; automatic browser anchoring is disabled to avoid competing adjustments. Composer focus and local panel state retain their existing lifetimes.

Windowed observations use `events?view=window`. They send the current tail plus live messages. `ConversationHistory` merges already loaded older entries into subsequent snapshots, deduplicates by native identity and retains per-entry annotations by revision. Pagination imports history without reconnecting the active run or replacing its draft.

Historical reply suggestions, sources, timing and loaded Skills are keyed by entry ID in `history.annotations`. Conversation-level state remains separate. Built-in contributions declare `projectHistory`, `projectConversation`, `historyScope` and/or task references as needed. A third-party `projectState` contribution without a scope declaration retains the legacy full-history projection until migrated. Clients without `view=window` also retain the original ascending pagination contract.

## Derived storage and upgrades

`ConversationFactsIndex` stores task/submission locators in `app_read_tasks` and `app_read_submissions`. It does not copy authoritative results. Exact records are read through Pi's public Storage interface. Locator updates and native writes share the existing ownership-fenced storage transaction; either both commit or both roll back.

Existing task/submission records are backfilled in resumable batches of 100 using public Storage scans. Checkpoints live in `app_meta`. New commit publications win over older backfill records. While the index is incomplete, window snapshot requests fall back to the legacy response, which the browser can read. Read-model indexes can be rebuilt; they never become an alternative queue or runtime.

`ExecutionBindings` stores immutable model/credential binding metadata in `app_request_execution`. A one-time resumable migration reads existing request payloads in batches of 100. Subsequent cold starts resolve current AgentDoc/checkpoint model references and pending host acceptance gaps from this compact metadata. Original input, images, action context and idempotency receipts remain intact. Initial upgrade work is proportional to old records; active Pi runtime recovery also retains its native context costs.

## Extending the project

Add a feature beneath `src/extensions/<feature>/`, register it in the activation lists and configure it in `extensions.config.ts`. Reuse host contribution contracts and the existing observation stream. Historical decoration should declare a scoped projection; host modules are reserved for capabilities the host must authorize or persist independently of one extension.

Tests remain grouped by execution environment (`unit`, `workers`, `e2e`, `hmr`). They import current implementations directly. Old source paths have no compatibility re-export files, and folders do not need blanket barrel exports.
