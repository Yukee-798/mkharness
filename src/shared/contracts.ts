import {z} from 'zod';
import type {Json} from './compute';
export const commandSchema=z.object({runId:z.uuid(),text:z.string().trim().min(1).max(32000),source:z.object({panelRef:z.string().max(512),action:z.string().max(200),state:z.record(z.string(),z.unknown())}).optional()});
export type RunCommand=z.infer<typeof commandSchema>;
export type RawState={ [key:string]:Json };
export class AppError extends Error {constructor(public status:number,public code:string, message=code){super(message);}}
