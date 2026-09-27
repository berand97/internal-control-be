import { describe, expect, it } from 'vitest';
import {
  blocksToLegacyBody,
  legacyBodyToBlocks,
} from '../../../database/migrations/1767225800000-email-template-blocks.js';
import { validateEmailBlocks } from './email-blocks.js';
import { EMAIL_TEMPLATE_TYPES, extractEmailPlaceholders } from './email-template-catalog.js';

// Textos sembrados por 1767225619000 y 1767225622000 (los que existen en las BD desplegadas).
const LEGACY_BODIES: ReadonlyArray<string> = [
  'Se creó su cuenta en {{app.name}}.\n\nRol: {{user.role}}\nCorreo: {{user.email}}\nUsuario: {{user.username}}\nContraseña temporal: {{auth.temporaryPassword}}\n\nInicie sesión en {{auth.loginUrl}} y cambie la contraseña.',
  'Hola {{user.email}},\n\nUse este enlace para restablecer su contraseña:\n{{auth.resetUrl}}\n\nEl enlace vence en {{auth.expiresInHours}} horas.',
  'Hola {{user.email}},\n\n{{notification.message}}\n\n{{app.loginUrl}}',
  '{{alert.message}}',
  'Hola {{user.email}},\nEl préstamo cambió a {{prestamo.estado}}.\nJustificación: {{prestamo.justificacion}}\n{{app.loginUrl}}',
];

describe('migración 1767225800000: texto → bloques', () => {
  it.each(LEGACY_BODIES)('convierte sin perder nada: %j', (body) => {
    const blocks = legacyBodyToBlocks(body);
    expect(blocks.every((block) => block.type === 'paragraph')).toBe(true);
    expect(validateEmailBlocks(blocks)).toEqual([]);
    expect(blocks.map((block) => block.text).join('\n\n')).toBe(body);
    expect(extractEmailPlaceholders(blocks.map((block) => block.text).join('\n'))).toEqual(
      extractEmailPlaceholders(body),
    );
  });

  it('un párrafo por bloque, conservando los saltos de línea internos', () => {
    expect(legacyBodyToBlocks('A\nB\n\nC')).toEqual([
      { type: 'paragraph', text: 'A\nB' },
      { type: 'paragraph', text: 'C' },
    ]);
    expect(legacyBodyToBlocks('A\r\n\r\nB')).toEqual([
      { type: 'paragraph', text: 'A' },
      { type: 'paragraph', text: 'B' },
    ]);
  });

  it('down(): bloques → texto con las variables intactas', () => {
    expect(
      blocksToLegacyBody([
        { type: 'heading', text: 'T {{a}}' },
        { type: 'button', label: 'Ir', url: '{{b}}' },
        { type: 'keyValueList', items: [{ label: 'X', value: '{{c}}' }] },
        { type: 'spacer', size: 'sm' },
      ]),
    ).toBe('T {{a}}\n\nIr: {{b}}\n\nX: {{c}}');
    expect(EMAIL_TEMPLATE_TYPES.length).toBe(8);
  });
});
