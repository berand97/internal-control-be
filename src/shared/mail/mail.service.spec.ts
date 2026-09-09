import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { SecretCipherService } from '../crypto/secret-cipher.service.js';
import { MailService } from './mail.service.js';

describe('MailService', () => {
  let current: {
    id: string;
    host: string | null;
    port: number;
    secure: boolean;
    username: string | null;
    password: string | null;
    fromName: string | null;
    fromEmail: string | null;
    enabled: boolean;
    updatedAt: Date;
    updatedBy: string | null;
  };
  let settings: {
    find: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  let service: MailService;
  let cipher: SecretCipherService;

  beforeEach(() => {
    current = {
      id: '11111111-1111-4111-8111-111111111111',
      host: null,
      port: 587,
      secure: false,
      username: null,
      password: null,
      fromName: null,
      fromEmail: null,
      enabled: false,
      updatedAt: new Date(),
      updatedBy: null,
    };
    settings = {
      find: vi.fn(async () => [current]),
      create: vi.fn((row: typeof current) => ({ ...row })),
      save: vi.fn(async (row: typeof current) => {
        current = { ...row };
        return current;
      }),
    };
    cipher = new SecretCipherService({
      getOrThrow: () => 'unit-test-settings-key',
    } as never);
    service = new MailService(
      settings as never,
      {
        getOrThrow: vi.fn().mockReturnValue('http://localhost:4200'),
      } as never,
      {
        render: vi.fn().mockResolvedValue({
          subject: 'Asunto',
          text: 'Cuerpo',
        }),
      } as never,
      cipher,
    );
  });

  it('no envía la invitación si el SMTP no está listo', async () => {
    const sent = await service.sendUserInvitation(
      'ana.ruiz@unac.edu.co',
      'ana.ruiz@unac.edu.co',
      'Temp.1234',
    );
    expect(sent).toBe(false);
  });

  it('rechaza la prueba si no hay SMTP', async () => {
    await expect(service.testConnection('ana.ruiz@unac.edu.co')).rejects.toMatchObject({
      code: ErrorCode.MailNotConfigured,
    });
  });

  it('rechaza verificar la conexión si no hay host', async () => {
    await expect(service.verifyConnection()).rejects.toMatchObject({
      code: ErrorCode.MailNotConfigured,
    });
  });

  it('guarda host, usuario y contraseña cifrados', async () => {
    const result = await service.updateSettings(
      {
        host: 'smtp.office365.com',
        username: 'noreply@unac.edu.co',
        password: 'AppPassword.1234',
        fromEmail: 'noreply@unac.edu.co',
        fromName: 'Control Interno UNAC',
      },
      'actor',
    );
    expect(current.password).toMatch(/^enc\.v1\./);
    expect(current.password).not.toContain('AppPassword.1234');
    expect(current.host).toMatch(/^enc\.v1\./);
    expect(current.host).not.toContain('smtp.office365.com');
    expect(current.username).toMatch(/^enc\.v1\./);
    expect(current.fromEmail).toMatch(/^enc\.v1\./);
    expect(result.host).toBe('smtp.office365.com');
    expect(result.username).toBe('noreply@unac.edu.co');
    expect(result.hasPassword).toBe(true);
    expect(result).not.toHaveProperty('password');
  });

  it('sella un SMTP legado en texto plano la primera vez que se lee', async () => {
    current.host = 'smtp.gmail.com';
    current.fromEmail = 'noreply@unac.edu.co';
    current.password = 'Plain.Legacy1';
    const loaded = await service.getSettings();
    expect(current.password).toMatch(/^enc\.v1\./);
    expect(current.password).not.toBe('Plain.Legacy1');
    expect(loaded.host).toBe('smtp.gmail.com');
    expect(loaded.hasPassword).toBe(true);
  });
});
