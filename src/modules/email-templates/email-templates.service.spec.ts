import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { DEFAULT_EMAIL_DESIGNS } from './domain/email-template-catalog.js';
import { EmailTemplatesService } from './email-templates.service.js';

describe('EmailTemplatesService', () => {
  let repo: {
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
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
    const manager = { getRepository: () => repo, query: vi.fn() };
    const dataSource = { transaction: vi.fn((work: (m: typeof manager) => unknown) => work(manager)) };
    const config = { get: vi.fn(() => ({ name: 'Control Interno UNAC', logoUrl: null })) };
    service = new EmailTemplatesService(repo as never, dataSource as never, config as never);
  });

  it('rechaza una variable que no está en el catálogo del tipo', async () => {
    const design = DEFAULT_EMAIL_DESIGNS.USER_INVITATION;
    await expect(
      service.create('USER_INVITATION', 'Hola {{token.inventado}}', design.blocks, 'actor'),
    ).rejects.toMatchObject({ code: ErrorCode.EmailTemplateUnknownVariable });
  });

  it('rechaza si falta una variable obligatoria', async () => {
    await expect(
      service.create('PASSWORD_RESET', 'Sin variables', [{ type: 'paragraph', text: 'Tampoco hay enlace' }], 'actor'),
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

  it('guarda la versión 1 activa con las variables usadas', async () => {
    const design = DEFAULT_EMAIL_DESIGNS.USER_INVITATION;
    const saved = await service.create('USER_INVITATION', design.subject, design.blocks, 'actor');
    expect(saved.version).toBe(1);
    expect(saved.isActive).toBe(true);
    expect(saved.placeholders).toContain('auth.temporaryPassword');
    expect(repo.update).toHaveBeenCalledWith({ templateType: 'USER_INVITATION', isActive: true }, { isActive: false });
  });

  it('previsualiza un borrador con el contexto de ejemplo: HTML y texto', () => {
    const design = DEFAULT_EMAIL_DESIGNS.PASSWORD_RESET;
    const preview = service.preview('PASSWORD_RESET', design.subject, design.blocks);
    expect(preview.subject).toBe('Restablecer contraseña — Control Interno UNAC');
    expect(preview.html).toContain('href="http://localhost:4200/auth/reset-password?token=ejemplo"');
    expect(preview.text).toContain('Restablecer contraseña: http://localhost:4200/auth/reset-password?token=ejemplo');
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
