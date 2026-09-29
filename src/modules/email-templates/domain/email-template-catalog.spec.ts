import { describe, expect, it } from 'vitest';
import { validateEmailBlocks } from './email-blocks.js';
import {
  DEFAULT_EMAIL_DESIGNS,
  EMAIL_PLACEHOLDER_CATALOG,
  EMAIL_SAMPLE_CONTEXT,
  EMAIL_TEMPLATE_TYPES,
  EMAIL_TEMPLATE_VARIABLES,
  EMAIL_VARIABLE_KINDS,
  checkDesignPlaceholders,
  designPlaceholders,
  extractEmailPlaceholders,
  urlVariables,
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

  it('son exactamente los 21 tipos que el sistema envía', () => {
    expect(EMAIL_TEMPLATE_TYPES).toEqual([
      'USER_INVITATION',
      'PASSWORD_RESET',
      'GENERIC_NOTIFICATION',
      'SYSTEM_ALERT',
      'LOAN_STATUS_NOTIFICATION',
      'INVENTORY_ALERT',
      'SIGNATURE_LINK',
      'IMPORT_FINISHED',
      'INVENTORY_SCHEDULED',
      'INVENTORY_RESCHEDULED',
      'INVENTORY_REMINDER',
      'INVENTORY_CANCELLED',
      'ASSET_REQUEST_CREATED',
      'ASSET_REQUEST_ACCEPTED',
      'ASSET_REQUEST_CLOSED',
      'ASSET_REQUEST_RETURNED',
      'ASSET_REQUEST_CORRECTED',
      'ASSET_REQUEST_CANCELLED',
      'ASSET_REQUEST_GENERATED',
      'ASSET_REQUEST_EXPIRED',
      'ASSET_REQUEST_COMPLETED',
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

  it.each(EMAIL_TEMPLATE_TYPES)('cada variable de %s tiene descripción, clase y (solo las de enlace) texto sugerido', (type) => {
    const catalog = EMAIL_PLACEHOLDER_CATALOG[type];
    const variables = EMAIL_TEMPLATE_VARIABLES[type];
    expect(variables.map((item) => item.name)).toEqual([...catalog.required, ...catalog.optional]);
    for (const variable of variables) {
      expect(variable.label.trim()).not.toBe('');
      expect(EMAIL_VARIABLE_KINDS).toContain(variable.kind);
      if (variable.kind === 'url') {
        expect(variable.linkText?.trim()).toBeTruthy();
      } else {
        expect(variable.linkText).toBeNull();
      }
    }
  });

  it('las variables de enlace son exactamente las que llevan un URL', () => {
    const urls = [...new Set(EMAIL_TEMPLATE_TYPES.flatMap((type) => [...urlVariables(type).keys()]))].sort();
    expect(urls).toEqual(['app.loginUrl', 'auth.loginUrl', 'auth.resetUrl', 'documento.url', 'firma.url', 'solicitud.url']);
    expect(urlVariables('PASSWORD_RESET').get('auth.resetUrl')).toEqual({
      name: 'auth.resetUrl',
      label: 'Enlace para restablecer la contraseña',
      kind: 'url',
      linkText: 'Restablecer contraseña',
    });
    // Los datos de ejemplo de una variable de enlace son un URL http(s).
    for (const type of EMAIL_TEMPLATE_TYPES) {
      for (const name of urlVariables(type).keys()) {
        expect(EMAIL_SAMPLE_CONTEXT[type][name]).toMatch(/^https?:\/\//);
      }
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
