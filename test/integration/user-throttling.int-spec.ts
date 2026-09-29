import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { applyTrustProxy } from '../../src/common/http/trust-proxy.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { THROTTLE_IP_LIMIT } from '../../src/common/throttling/throttle-limits.js';
import type { AppConfig } from '../../src/config/configuration.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { openTestSession, scalar } from './helpers.js';

/**
 * Límite de peticiones por usuario (no por IP) detrás del NAT de la universidad, HTTP real + PostgreSQL real. La ruta
 * pública GET /api/v1 (sin @Throttle propio) cuenta por usuario si trae un access token válido y por IP si no.
 */
describe('Límite de peticiones: por usuario autenticado, por IP sin sesión (HTTP real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let userLimit = 0;

  const user = async (): Promise<{ username: string; token: string }> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ('Cupo', $1, $2) RETURNING id`,
      [tag, `cupo.${tag}@unac.edu.co`],
    );
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE') RETURNING id`,
      [personId, `cupo.${tag}`],
    );
    const token = app.get(TokenService).signAccessToken({
      id,
      personId,
      username: `cupo.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId: await openTestSession(dataSource, id),
    });
    return { username: `cupo.${tag}`, token };
  };

  const ping = (ip: string, token?: string) => {
    const call = request(app.getHttpServer()).get('/api/v1').set('X-Forwarded-For', ip);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    const config = app.get(ConfigService<AppConfig, true>);
    applyTrustProxy(app, config.getOrThrow('trustProxy', { infer: true }));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    userLimit = config.getOrThrow('throttleUserLimit', { infer: true });
  });

  afterAll(async () => {
    await app.close();
  });

  it('el cupo general autenticado es por usuario: 300 por defecto, mayor que el de IP', () => {
    expect(userLimit).toBe(300);
    expect(userLimit).toBeGreaterThan(THROTTLE_IP_LIMIT);
  });

  it('dos usuarios desde la misma IP no comparten cupo; quien excede el suyo recibe 429 con Retry-After', async () => {
    const nat = '203.0.113.50';
    const first = await user();
    const second = await user();
    for (let hit = 0; hit < userLimit; hit += 1) {
      expect((await ping(nat, first.token)).status).toBe(200);
    }
    const blocked = await ping(nat, first.token);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // El compañero detrás del mismo NAT sigue con su propio cupo.
    expect((await ping(nat, second.token)).status).toBe(200);
    // Y el cupo es del usuario, no de la IP: desde otra IP sigue bloqueado.
    expect((await ping('203.0.113.51', first.token)).status).toBe(429);
  });

  it('sin sesión (o con un token inválido) sigue contando por IP con el límite general', async () => {
    const ip = '203.0.113.60';
    for (let hit = 0; hit < THROTTLE_IP_LIMIT; hit += 1) {
      expect((await ping(ip, hit % 2 === 0 ? undefined : 'no-es-un-jwt')).status).toBe(200);
    }
    const blocked = await ping(ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await ping('203.0.113.61')).status).toBe(200);
  });

  it('el login conserva su límite estricto por IP aunque la petición traiga un access token válido', async () => {
    const { token } = await user();
    const login = (ip: string) =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${token}`)
        .send({ username: `no.existe.${randomUUID().slice(0, 8)}`, password: 'Clave-Incorrecta-1' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login('203.0.113.70')).status).toBe(401);
    }
    const blocked = await login('203.0.113.70');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login('203.0.113.71')).status).toBe(401);
  });
});
