import { Logger } from '@nestjs/common';
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
  // Desarrollo por defecto (redes privadas permitidas); las pruebas de BE-16 lo cambian a producción.
  let policy: { allowPrivateNetworks: boolean; allowedHosts: string[] };

  beforeEach(() => {
    policy = { allowPrivateNetworks: true, allowedHosts: [] };
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
        getOrThrow: vi.fn((key: string) =>
          key === 'outbound' ? policy : 'http://localhost:4200',
        ),
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

  it('un destinatario con salto de línea responde MAIL_ADDRESS_INVALID sin conectar ni dejar la dirección en el log', async () => {
    await service.updateSettings(
      { host: '127.0.0.1', port: 9, fromEmail: 'noreply@unac.edu.co', enabled: true },
      'actor',
    );
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(
      service.sendSigningLink('a@x.com>\nRCPT TO:<b@unac.edu.co', {
        url: 'http://localhost/firma/token',
        expiresAt: '',
        formatName: '',
        number: 'ACT-1',
        signerName: '',
        roleLabel: '',
        contact: '',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MailAddressInvalid });
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(' ');
    expect(logged).toContain('unsafe to');
    expect(logged).not.toContain('a@x.com');
    expect(logged).not.toContain('b@unac.edu.co');
    warn.mockRestore();
    error.mockRestore();
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

describe('MailService: destinos SMTP y datos personales en logs (BE-16, Ley 1581)', () => {
  const build = (policy: { allowPrivateNetworks: boolean; allowedHosts: string[] }) => {
    let row: Record<string, unknown> = {
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
    const settings = {
      find: vi.fn(async () => [row]),
      create: vi.fn((value: Record<string, unknown>) => ({ ...value })),
      save: vi.fn(async (value: Record<string, unknown>) => {
        row = { ...value };
        return row;
      }),
    };
    const cipher = new SecretCipherService({ getOrThrow: () => 'unit-test-settings-key' } as never);
    const service = new MailService(
      settings as never,
      { getOrThrow: (key: string) => (key === 'outbound' ? policy : 'http://localhost:4200') } as never,
      { render: vi.fn().mockResolvedValue({ subject: 'Asunto', text: 'Cuerpo' }) } as never,
      cipher,
    );
    return { service, settings };
  };

  it.each(['127.0.0.1', 'localhost', 'gotenberg', '10.1.2.3', '169.254.169.254', '[::1]', 'postgres.internal'])(
    'en producción PATCH /mail/settings con host %s responde OUTBOUND_DESTINATION_FORBIDDEN y no guarda',
    async (host) => {
      const { service, settings } = build({ allowPrivateNetworks: false, allowedHosts: [] });
      await expect(service.updateSettings({ host, port: 5432 }, 'actor')).rejects.toMatchObject({
        code: ErrorCode.OutboundDestinationForbidden,
      });
      expect(settings.save).not.toHaveBeenCalled();
    },
  );

  it('OUTBOUND_ALLOWED_HOSTS habilita un relay interno explícito', async () => {
    const { service } = build({ allowPrivateNetworks: false, allowedHosts: ['relay.interno'] });
    const saved = await service.updateSettings({ host: 'relay.interno', port: 25 }, 'actor');
    expect(saved.host).toBe('relay.interno');
  });

  it('en desarrollo (MailHog en localhost) el host local se acepta', async () => {
    const { service } = build({ allowPrivateNetworks: true, allowedHosts: [] });
    const saved = await service.updateSettings({ host: 'localhost', port: 1025 }, 'actor');
    expect(saved.host).toBe('localhost');
  });

  it('una conexión a un host guardado antes de la regla se corta antes de abrir el socket', async () => {
    const { service, settings } = build({ allowPrivateNetworks: false, allowedHosts: [] });
    await settings.save({ ...(await settings.find())[0], host: '127.0.0.1', port: 5432, fromEmail: 'noreply@unac.edu.co', enabled: true });
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(service.verifyConnection()).rejects.toMatchObject({ code: ErrorCode.OutboundDestinationForbidden });
    error.mockRestore();
  });

  it('sin SMTP, el aviso de respaldo del restablecimiento no lleva el correo completo', async () => {
    const { service } = build({ allowPrivateNetworks: true, allowedHosts: [] });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await service.sendPasswordReset('ana.ruiz@unac.edu.co', 'token-secreto');
    await service.sendUserInvitation('pedro.perez@unac.edu.co', 'pedro', 'Temp.1234');
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('password-reset to=a***@unac.edu.co');
    expect(logged).toContain('user-invitation to=p***@unac.edu.co');
    expect(logged).not.toContain('ana.ruiz');
    expect(logged).not.toContain('pedro.perez');
    expect(logged).not.toContain('token-secreto');
    warn.mockRestore();
  });

  it('un envío fallido registra el destinatario enmascarado y sin el asunto', async () => {
    const { service, settings } = build({ allowPrivateNetworks: true, allowedHosts: [] });
    await settings.save({ ...(await settings.find())[0], host: '127.0.0.1', port: 9, fromEmail: 'noreply@unac.edu.co', enabled: true });
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(service.testConnection('maria.gomez@unac.edu.co')).rejects.toMatchObject({ code: ErrorCode.MailSendFailed });
    const logged = error.mock.calls.flat().join(' ');
    expect(logged).toContain('to=m***@unac.edu.co');
    expect(logged).not.toContain('maria.gomez');
    expect(logged).not.toContain('Prueba de correo');
    error.mockRestore();
  });
});
