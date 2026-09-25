import type { TemplateSample } from './template-leftovers.mjs';

export declare const SAMPLE: TemplateSample;
export declare const FIELDS: Readonly<Record<string, string | ReadonlyArray<string>>>;
export declare const build: (source: Buffer) => { output: Buffer; tags: string[] };
