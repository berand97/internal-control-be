import { describe, expect, it } from 'vitest';
import { validateEmailBlocks } from './email-blocks.js';
import {
  DEFAULT_EMAIL_DESIGNS,
  EMAIL_PLACEHOLDER_CATALOG,
  EMAIL_SAMPLE_CONTEXT,
  EMAIL_TEMPLATE_TYPES,
  checkDesignPlaceholders,
  designPlaceholders,
  extractEmailPlaceholders,
} from './email-template-catalog.js';

describe('email-template-catalog', () => {
  it('extrae tokens únicos', () => {
    expect(
      extractEmailPlaceholders('Hola {{user.username}} en {{app.name}} y {{user.username}}'),
    ).toEqual(['user.username', 'app.name']);
  });

  it('exige tokens de invitación y reset', () => {
    expect(EMAIL_PLACEHOLDER_CATALOG.USER_INVITATION.required).toContain('auth.temporaryPassword');
    expect(EMAIL_PLACEHOLDER_CATALOG.PASSWORD_RESET.required).toContain('auth.resetUrl');
  });

  it('son exactamente los 8 tipos que el sistema envía', () => {
    expect(EMAIL_TEMPLATE_TYPES).toEqual([
      'USER_INVITATION',
      'PASSWORD_RESET',
      'GENERIC_NOTIFICATION',
      'SYSTEM_ALERT',
      'LOAN_STATUS_NOTIFICATION',
      'INVENTORY_ALERT',
      'SIGNATURE_LINK',
      'IMPORT_FINISHED',
    ]);
  });

  it.each(EMAIL_TEMPLATE_TYPES)('el diseño por defecto de %s es válido y usa solo variables de su catálogo', (type) => {
    const design = DEFAULT_EMAIL_DESIGNS[type];
    expect(validateEmailBlocks(design.blocks)).toEqual([]);
    const check = checkDesignPlaceholders(type, design);
    expect(check.unknown).toEqual([]);
    expect(check.missing).toEqual([]);
  });

  it.each(EMAIL_TEMPLATE_TYPES)('los datos de ejemplo de %s cubren todas las variables del catálogo', (type) => {
    const catalog = EMAIL_PLACEHOLDER_CATALOG[type];
    for (const token of catalog.required) {
      expect(EMAIL_SAMPLE_CONTEXT[type]).toHaveProperty([token]);
    }
  });

  it('designPlaceholders recorre asunto, textos, filas y URL de botón', () => {
    expect(
      designPlaceholders({
        subject: '{{a.b}}',
        blocks: [
          { type: 'keyValueList', items: [{ label: '{{c}}', value: '{{d}}' }] },
          { type: 'button', label: 'Ir', url: '{{e}}' },
        ],
      }),
    ).toEqual(['a.b', 'c', 'd', 'e']);
  });
});
