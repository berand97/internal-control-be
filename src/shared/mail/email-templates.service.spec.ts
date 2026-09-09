import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { DEFAULT_EMAIL_TEMPLATES } from './domain/email-template-catalog.js';
import { EmailTemplatesService } from './email-templates.service.js';

describe('EmailTemplatesService', () => {
  let templates: {
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  let service: EmailTemplatesService;

  beforeEach(() => {
    templates = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      create: vi.fn((row: unknown) => row),
      save: vi.fn(async (row: { version: number }) => ({
        ...row,
        id: '11111111-1111-4111-8111-111111111111',
      })),
    };
    service = new EmailTemplatesService(templates as never);
  });

  it('rechaza un token que no está en el catálogo', async () => {
    await expect(
      service.save(
        'USER_INVITATION',
        'Hola {{token.inventado}}',
        DEFAULT_EMAIL_TEMPLATES.USER_INVITATION.body,
        'actor',
      ),
    ).rejects.toMatchObject({ code: ErrorCode.TemplateUnknownPlaceholder });
  });

  it('rechaza si falta un token obligatorio', async () => {
    await expect(
      service.save('PASSWORD_RESET', 'Sin tokens', 'Tampoco hay enlace', 'actor'),
    ).rejects.toMatchObject({ code: ErrorCode.TemplateMissingPlaceholder });
  });

  it('guarda y activa una versión válida', async () => {
    const draft = DEFAULT_EMAIL_TEMPLATES.USER_INVITATION;
    const saved = await service.save('USER_INVITATION', draft.subject, draft.body, 'actor');
    expect(saved.version).toBe(1);
    expect(saved.isActive).toBe(true);
    expect(saved.placeholders).toContain('auth.temporaryPassword');
    expect(templates.update).toHaveBeenCalled();
  });

  it('previsualiza con el contexto de ejemplo', async () => {
    const preview = await service.preview(
      'PASSWORD_RESET',
      DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET.subject,
      DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET.body,
    );
    expect(preview.subject).toContain('Control Interno UNAC');
    expect(preview.body).toContain('juliana.perez@unac.edu.co');
    expect(preview.body).toContain('/auth/reset-password');
  });
});
