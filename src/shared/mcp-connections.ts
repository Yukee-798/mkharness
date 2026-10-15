import { z } from 'zod';

export const toolPermission = z.enum(['disabled', 'ask', 'auto']);
export type ToolPermission = z.infer<typeof toolPermission>;
export const connectionInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    endpoint: z.string().trim().max(2048),
    auth: z.enum(['auto', 'none', 'bearer']).default('auto'),
    token: z.string().min(1).max(8192).optional(),
    clientId: z.string().min(1).max(2048).optional(),
    clientSecret: z.string().min(1).max(8192).optional(),
  })
  .strict()
  .refine((v) => v.auth !== 'bearer' || !!v.token, 'Bearer token is required');
export type ConnectionInput = z.infer<typeof connectionInput>;
export type ConnectionTool = {
  name: string;
  description: string;
  schema: Record<string, import('./json').Json>;
  hash: string;
  permission: ToolPermission;
  supported: boolean;
};
export type ConnectionView = {
  id: string;
  name: string;
  endpoint: string;
  auth: 'auto' | 'none' | 'bearer';
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'authorizing' | 'ready' | 'reauthorize' | 'error';
  error?: string;
  revision: number;
  grant: number;
  tools: ConnectionTool[];
};
export type ConnectionBinding = {
  connectionId: string;
  connectionName: string;
  endpoint: string;
  grant: number;
  tool: ConnectionTool;
  name: string;
};
