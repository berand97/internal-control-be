import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { DEFAULT_EMAIL_DESIGNS } from './domain/email-template-catalog.js';
import { textToRichText } from './domain/rich-text.js';
import { EmailTemplatesService } from './email-templates.service.js';

const ASSET = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const MISSING = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

describe('EmailTemplatesService', () => {
  let repo: {
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  let assets: { missing: ReturnType<typeof vi.fn>; lookup: ReturnType<typeof vi.fn> };
  let service: EmailTemplatesService;

  beforeEach(() => {
    repo = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      create: vi.fn((row: unknown) => row),
      save: vi.fn(async (row: Record<string, unknown>) => ({
        ...row,
        id: '11111111-1111-4111-8111-111111111111',
      })),
    };
    assets = {
      missing: vi.fn(async (ids: ReadonlyArray<string>) => ids.filter((id) => id !== ASSET)),
      lookup: vi.fn(async (ids: ReadonlyArray<string>) =>
        new Map(
          ids
            .filter((id) => id === ASSET)
            .map((id) => [id, { url: `https://api.unac.edu.co/api/v1/public/email-assets/${id}`, width: 400, height: 100 }]),
        ),
      ),
    };
    const manager = { getRepository: () => repo, query: vi.fn() };
    const dataSource = { transaction: vi.fn((work: (m: typeof manager) => unknown) => work(manager)) };
    const config = { get: vi.fn(() => ({ name: 'Control Interno UNAC', logoUrl: null })) };
    service = new EmailTemplatesService(repo as never, dataSource as never, config as never, assets as never);
  });

  it('rechaza una variable que no está en el catálogo del tipo', async () => {
    const design = DEFAULT_EMAIL_DESIGNS.USER_INVITATION;
    await expect(
      service.create('USER_INVITATION', 'Hola {{token.inventado}}', design.blocks, 'actor'),
    ).rejects.toMatchObject({ code: ErrorCode.EmailTemplateUnknownVariable });
  });

  it('una variable ajena dentro de un enlace del párrafo o del alt de una imagen también se detecta', async () => {
    const linked = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '{{alert.message}} ' },
            { type: 'text', text: 'aquí', marks: [{ type: 'link', attrs: { href: '{{auth.resetUrl}}' } }] },
          ],
        },
      ],
    };
    await expect(
      service.create('SYSTEM_ALERT', '{{alert.title}}', [{ type: 'paragraph', content: linked }], 'actor'),
    ).rejects.toMatchObject({ code: ErrorCode.EmailTemplateUnknownVariable, details: [expect.objectContaining({ field: 'auth.resetUrl' })] });
    await expect(
      service.create(
        'SYSTEM_ALERT',
        '{{alert.title}}',
        [
          { type: 'paragraph', content: textToRichText('{{alert.message}}') },
          { type: 'image', assetId: ASSET, alt: '{{user.email}}', align: 'left' },
        ],
        'actor',
      ),
    ).rejects.toMatchObject({ code: ErrorCode.EmailTemplateUnknownVariable, details: [expect.objectContaining({ field: 'user.email' })] });
  });

  it('rechaza si falta una variable obligatoria', async () => {
    await expect(
      service.create('PASSWORD_RESET', 'Sin variables', [{ type: 'paragraph', content: textToRichText('Tampoco hay enlace') }], 'actor'),
    ).rejects.toMatchObject({ code: ErrorCode.EmailTemplateMissingVariable });
  });

  it('rechaza una estructura inválida con el campo exacto', async () => {
    await expect(
      service.create('SYSTEM_ALERT', '{{alert.title}}', [{ type: 'html', html: '<b>{{alert.message}}</b>' }], 'actor'),
    ).rejects.toMatchObject({
      code: ErrorCode.EmailTemplateInvalidDesign,
      details: [expect.objectContaining({ field: 'blocks[0].type' })],
    });
  });

  it('rechaza una imagen que no existe, al guardar y al previsualizar', async () => {
    const blocks = [
      { type: 'paragraph', content: textToRichText('{{alert.message}}') },
      { type: 'image', assetId: ASSET, alt: 'Existe', align: 'left' },
      { type: 'image', assetId: MISSING, alt: 'No existe', align: 'center' },
    ];
    const expected = {
      code: ErrorCode.EmailTemplateInvalidDesign,
      details: [{ field: 'blocks[2].assetId', message: 'La imagen no existe; súbala de nuevo' }],
    };
    await expect(service.create('SYSTEM_ALERT', '{{alert.title}}', blocks, 'actor')).rejects.toMatchObject(expected);
    await expect(service.preview('SYSTEM_ALERT', '{{alert.title}}', blocks)).rejects.toMatchObject(expected);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rechaza un URL como texto, al guardar y al previsualizar, con la ruta exacta; como enlace sí previsualiza', async () => {
    const blocks = [
      { type: 'paragraph', content: textToRichText('Hola {{user.email}},\n\nUse este enlace:\n{{auth.resetUrl}}') },
    ];
    const expected = {
      code: ErrorCode.EmailTemplateInvalidDesign,
      details: [
        {
          field: 'blocks[0].content.content[1].content[2].text',
          message: 'Use la variable {{auth.resetUrl}} como enlace o botón, no como texto',
        },
      ],
    };
    await expect(service.create('PASSWORD_RESET', 'Restablecer', blocks, 'actor')).rejects.toMatchObject(expected);
    await expect(service.preview('PASSWORD_RESET', 'Restablecer', blocks)).rejects.toMatchObject(expected);
    expect(repo.save).not.toHaveBeenCalled();

    const asLink = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hola {{user.email}}, use este enlace:' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Restablecer contraseña', marks: [{ type: 'link', attrs: { href: '{{auth.resetUrl}}' } }] },
          ],
        },
      ],
    };
    const preview = await service.preview('PASSWORD_RESET', 'Restablecer', [{ type: 'paragraph', content: asLink }]);
    expect(preview.html).toContain('href="http://localhost:4200/auth/reset-password?token=ejemplo"');
    expect(preview.html).toMatch(/<a href="http:\/\/localhost:4200\/auth\/reset-password\?token=ejemplo"[^>]*>Restablecer contraseña<\/a>/);
    expect(preview.html).not.toContain('>http://localhost:4200/auth/reset-password');
    expect(preview.text).toContain('Restablecer contraseña (http://localhost:4200/auth/reset-password?token=ejemplo)');
  });

  it('guarda la versión 1 activa con las variables usadas', async () => {
    const design = DEFAULT_EMAIL_DESIGNS.USER_INVITATION;
    const saved = await service.create('USER_INVITATION', design.subject, design.blocks, 'actor');
    expect(saved.version).toBe(1);
    expect(saved.isActive).toBe(true);
    expect(saved.placeholders).toContain('auth.temporaryPassword');
    expect(repo.update).toHaveBeenCalledWith({ templateType: 'USER_INVITATION', isActive: true }, { isActive: false });
  });

  it('previsualiza un borrador con el contexto de ejemplo: HTML y texto, con la imagen en su URL pública', async () => {
    const design = DEFAULT_EMAIL_DESIGNS.PASSWORD_RESET;
    const preview = await service.preview('PASSWORD_RESET', design.subject, [
      ...design.blocks,
      { type: 'image', assetId: ASSET, alt: 'Logo', align: 'center' },
    ]);
    expect(preview.subject).toBe('Restablecer contraseña — Control Interno UNAC');
    expect(preview.html).toContain('href="http://localhost:4200/auth/reset-password?token=ejemplo"');
    expect(preview.html).toContain(`<img src="https://api.unac.edu.co/api/v1/public/email-assets/${ASSET}" alt="Logo" width="400" height="100"`);
    expect(preview.text).toContain('Restablecer contraseña: http://localhost:4200/auth/reset-password?token=ejemplo');
    expect(preview.text).toContain('[Imagen: Logo]');
  });

  it('render usa el diseño por defecto si no hay versión activa', async () => {
    const rendered = await service.render('GENERIC_NOTIFICATION', {
      'user.email': 'ana@unac.edu.co',
      'notification.title': 'Aviso',
      'notification.message': 'Mensaje',
      'app.name': 'Control Interno UNAC',
      'app.loginUrl': 'https://control.unac.edu.co',
    });
    expect(rendered.subject).toBe('Aviso — Control Interno UNAC');
    expect(rendered.html).toContain('Mensaje');
    expect(rendered.text).toContain('Abrir Control Interno UNAC: https://control.unac.edu.co/');
  });
});
