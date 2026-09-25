import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { applyTrustProxy, parseTrustProxy, type TrustProxySetting } from '../../src/common/http/trust-proxy.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AppConfig } from '../../src/config/configuration.js';

const boot = async (setting?: TrustProxySetting): Promise<NestExpressApplication> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  const config = app.get(ConfigService<AppConfig, true>);
  applyTrustProxy(app, setting ?? config.getOrThrow('trustProxy', { infer: true }));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createAppValidationPipe());
  await app.init();
  return app;
};

describe('IP del cliente detrás del proxy (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await boot();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  const failedLogin = (target: NestExpressApplication, forwardedFor: string | null) => {
    const username = `no.existe.${randomUUID().slice(0, 8)}`;
    const call = request(target.getHttpServer()).post('/api/v1/auth/login');
    if (forwardedFor) {
      call.set('X-Forwarded-For', forwardedFor);
    }
    return call.send({ username, password: 'Clave-Incorrecta-1' }).then((response) => ({ response, username }));
  };

  const auditedIp = async (username: string): Promise<string | null> => {
    const [row] = (await dataSource.query(
      `SELECT host(ip_address) AS ip FROM audit_log WHERE action = 'LOGIN_FAILED' AND changes->>'username' = $1`,
      [username],
    )) as Array<{ ip: string | null }>;
    return row?.ip ?? null;
  };

  it('la configuración por defecto confía solo en proxies de red privada', () => {
    const setting = app.get(ConfigService<AppConfig, true>).getOrThrow('trustProxy', { infer: true });
    expect(setting).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('10.0.0.0/8, 173.245.48.0/20')).toEqual(['10.0.0.0/8', '173.245.48.0/20']);
    expect(() => parseTrustProxy('true')).toThrow(/TRUST_PROXY=true/);
  });

  it('la auditoría de login registra la IP real reenviada por el proxy', async () => {
    const { response, username } = await failedLogin(app, '203.0.113.10');
    expect(response.status).toBe(401);
    expect(await auditedIp(username)).toBe('203.0.113.10');
  });

  it('ignora lo que el cliente inventa a la izquierda del X-Forwarded-For', async () => {
    const { username } = await failedLogin(app, '198.51.100.66, 203.0.113.11');
    expect(await auditedIp(username)).toBe('203.0.113.11');
  });

  it('el throttler limita por cliente, no a todos juntos', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await failedLogin(app, '203.0.113.20')).response.status).toBe(401);
    }
    expect((await failedLogin(app, '203.0.113.20')).response.status).toBe(429);
    expect((await failedLogin(app, '203.0.113.21')).response.status).toBe(401);
  });

  it('con TRUST_PROXY=false el header se ignora y queda la IP del socket', async () => {
    const direct = await boot(false);
    try {
      const { username } = await failedLogin(direct, '203.0.113.30');
      expect(await auditedIp(username)).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    } finally {
      await direct.close();
    }
  });
});
