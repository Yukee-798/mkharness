// The test context has its own Vite module graph, separate from the DO fixture entry.
// Load native UI dependencies before assertions so cold HTTP imports are not timed as validation.
import '../../src/shared/catalog';
