export interface TemplateSample {
  readonly names: ReadonlyArray<string>;
  readonly documents: ReadonlyArray<string>;
  readonly numbers: ReadonlyArray<string>;
  readonly text: ReadonlyArray<string>;
}

export interface LeftoverOptions {
  /** También busca nombres del ejemplo en docProps (autor, último editor). */
  readonly metadata?: boolean;
}

export declare const OCI_01_55_SAMPLE: TemplateSample;
export declare const findLeftovers: (docx: Buffer, sample: TemplateSample, options?: LeftoverOptions) => string[];
export declare const assertTemplateClean: (docx: Buffer, sample: TemplateSample, options?: LeftoverOptions) => void;
export declare const removeInvisibleRuns: (xml: string) => string;
export declare const removeOrphanExternalRelationships: (rels: string, referencingXml: string) => string;
