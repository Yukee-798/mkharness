import { DurableObject } from 'cloudflare:workers';
export class StorageProbe extends DurableObject {}
export default { fetch: () => new Response('native storage fixture') };
