import type { OpenAPIObject } from '@nestjs/swagger';

export interface Schema {
  readonly $ref?: string;
  readonly allOf?: ReadonlyArray<Schema>;
  readonly type?: string;
  readonly nullable?: boolean;
  readonly enum?: ReadonlyArray<unknown>;
  readonly properties?: Record<string, Schema>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: Schema;
  readonly additionalProperties?: boolean | Schema;
}

export const conform = (openapi: OpenAPIObject, value: unknown, schema: Schema, path: string, errors: string[]): void => {
  const components = (openapi.components?.schemas ?? {}) as Record<string, Schema>;
  const resolve = (item: Schema): Schema => {
    if (item.$ref) {
      return resolve(components[item.$ref.replace('#/components/schemas/', '')] ?? {});
    }
    const { allOf, ...own } = item;
    if (allOf) {
      const parts = [...allOf.map(resolve), own];
      return parts.reduce<Schema>(
        (merged, part) => ({
          ...merged,
          ...part,
          properties: { ...merged.properties, ...part.properties },
          required: [...(merged.required ?? []), ...(part.required ?? [])],
          nullable: Boolean(merged.nullable || part.nullable),
        }),
        {},
      );
    }
    return item;
  };
  const resolved = resolve(schema);
  if (value === null) {
    if (!resolved.nullable) {
      errors.push(`${path}: es null y el esquema no lo declara nullable`);
    }
    return;
  }
  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} no está en el enum ${JSON.stringify(resolved.enum)}`);
  }
  const type = resolved.type ?? (resolved.properties ? 'object' : undefined);
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: se esperaba arreglo`);
      return;
    }
    value.forEach((item, index) => conform(openapi, item, resolved.items ?? {}, `${path}[${index}]`, errors));
    return;
  }
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: se esperaba objeto`);
      return;
    }
    const declared = resolved.properties ?? {};
    for (const key of Object.keys(value)) {
      if (!(key in declared) && resolved.additionalProperties !== true) {
        errors.push(`${path}.${key}: la respuesta la trae y el esquema no la declara`);
      }
    }
    for (const key of resolved.required ?? []) {
      if (!(key in value)) {
        errors.push(`${path}.${key}: requerida en el esquema y ausente en la respuesta`);
      }
    }
    for (const [key, property] of Object.entries(declared)) {
      if (key in value) {
        conform(openapi, (value as Record<string, unknown>)[key], property, `${path}.${key}`, errors);
      }
    }
    return;
  }
  const actual = typeof value;
  const expected: Record<string, (item: unknown) => boolean> = {
    string: (item) => typeof item === 'string',
    integer: (item) => Number.isInteger(item),
    number: (item) => typeof item === 'number',
    boolean: (item) => typeof item === 'boolean',
  };
  if (type && expected[type] && !expected[type](value)) {
    errors.push(`${path}: se esperaba ${type} y llegó ${actual}`);
  }
  if (!type && !resolved.enum) {
    errors.push(`${path}: el esquema no declara tipo (queda como Object en el cliente generado)`);
  }
};
