import type { TemplateSample } from './template-leftovers.mjs';

export declare const SAMPLE: TemplateSample;
export declare const TITLE: string;
export declare const COLUMNS: ReadonlyArray<{ readonly header: string; readonly tag: string; readonly width: number; readonly align?: string }>;
export declare const build: (base: Buffer) => { output: Buffer; tags: string[] };
