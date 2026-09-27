import { fieldsFor, IMPORT_TARGETS } from './import-fields.js';

/** Un código de error o de marca (EMAIL_NOT_INSTITUTIONAL, NAME_NOT_SPLIT): nunca bajo un campo del formulario. */
const ERROR_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

const allFields = IMPORT_TARGETS.flatMap((target) =>
  Object.entries(fieldsFor(target)).map(([field, definition]) => ({ target, field, definition })),
);

describe('resumen de cada campo de importación', () => {
  it.each(allFields)('$target.$field tiene un resumen en lenguaje llano, sin códigos', ({ definition }) => {
    expect(definition.summary.trim()).not.toBe('');
    expect(definition.summary).not.toMatch(ERROR_CODE);
  });

  it.each(allFields.filter(({ definition }) => definition.maxLength !== undefined))(
    '$target.$field: el resumen o el formato dicen el mismo límite que aplica el importador',
    ({ definition }) => {
      const limit = String(definition.maxLength?.length);
      expect(`${definition.summary} ${definition.format}`).toContain(limit);
    },
  );
});
