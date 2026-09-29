import type { TemplateSample } from './template-leftovers.mjs';

export declare const SAMPLE: TemplateSample;
export declare const COLUMNS: ReadonlyArray<{ readonly cell?: string; readonly header: string; readonly label?: string; readonly tag: string; readonly width: number; readonly align?: string }>;
export declare const readFormat: (xlsx: Buffer) => Promise<Record<string, string>>;
export declare const build: (base: Buffer, xlsx: Buffer) => Promise<{ output: Buffer; tags: string[] }>;
