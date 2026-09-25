import { describe, expect, it, vi } from 'vitest';
import { checkDatabaseHost, guardDatabaseUrl, isLocalDatabaseHost } from './database-host-guard.js';

const url = (host: string): string => `postgres://usuario:clave-secreta@${host}:5432/internal_control`;
const dev = { NODE_ENV: 'development' };

describe('guarda de host de base de datos', () => {
  it.each(['localhost', 'LOCALHOST', 'db.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'postgres', ''])(
    'acepta %j como local',
    (host) => {
      expect(isLocalDatabaseHost(host)).toBe(true);
    },
  );

  it.each([
    'control-interno-control-interno-database-qkjtmk',
    'db.unac.edu.co',
    '10.0.0.5',
    '192.168.1.20',
    '128.0.0.1',
    '127.0.0.999',
    'localhost.evil.com',
    'postgres.unac.edu.co',
    '::2',
  ])('rechaza %j como remoto', (host) => {
    expect(isLocalDatabaseHost(host)).toBe(false);
  });

  it('permite localhost, 127.0.0.1, [::1] y el contenedor postgres fuera de producción', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'postgres']) {
      expect(checkDatabaseHost(url(host), dev)).toMatchObject({ allowed: 'local' });
    }
    // Sin NODE_ENV (tests, scripts sueltos) cuenta como fuera de producción.
    expect(checkDatabaseHost(url('localhost'), {})).toMatchObject({ allowed: 'local' });
  });

  it('rechaza un host remoto fuera de producción sin exponer credenciales', () => {
    const attempt = () => checkDatabaseHost(url('control-interno-control-interno-database-qkjtmk'), dev);
    expect(attempt).toThrow(/host no local \(control-interno-control-interno-database-qkjtmk\)/);
    expect(attempt).toThrow(/ALLOW_REMOTE_DATABASE=true/);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain('clave-secreta');
      expect((error as Error).message).not.toContain('usuario');
    }
    expect(() => checkDatabaseHost(url('db.unac.edu.co'), { NODE_ENV: 'test' })).toThrow(/host no local/);
    expect(() => checkDatabaseHost(url('db.unac.edu.co'), {})).toThrow(/host no local/);
  });

  it('usa el parámetro ?host= que pg antepone al host de la URL', () => {
    expect(() =>
      checkDatabaseHost('postgres://u:p@localhost:5432/db?host=db.unac.edu.co', dev),
    ).toThrow(/db\.unac\.edu\.co/);
    expect(checkDatabaseHost('postgres:///db?host=/var/run/postgresql', dev)).toMatchObject({ allowed: 'local' });
  });

  it('solo el valor exacto "true" de ALLOW_REMOTE_DATABASE abre el escape, y avisa sin credenciales', () => {
    const remote = url('db.unac.edu.co');
    expect(() => checkDatabaseHost(remote, { ...dev, ALLOW_REMOTE_DATABASE: '1' })).toThrow(/host no local/);
    expect(() => checkDatabaseHost(remote, { ...dev, ALLOW_REMOTE_DATABASE: 'yes' })).toThrow(/host no local/);

    const warn = vi.fn();
    expect(guardDatabaseUrl(remote, { ...dev, ALLOW_REMOTE_DATABASE: 'true' }, warn)).toBe(remote);
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('db.unac.edu.co');
    expect(message).toContain('NODE_ENV=development');
    expect(message).not.toContain('clave-secreta');
    expect(message).not.toContain('usuario');
  });

  it('no avisa cuando el host es local', () => {
    const warn = vi.fn();
    guardDatabaseUrl(url('localhost'), { ...dev, ALLOW_REMOTE_DATABASE: 'true' }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('en producción no restringe el host', () => {
    const warn = vi.fn();
    const remote = url('control-interno-control-interno-database-qkjtmk');
    expect(guardDatabaseUrl(remote, { NODE_ENV: 'production' }, warn)).toBe(remote);
    expect(warn).not.toHaveBeenCalled();
  });

  it('una DATABASE_URL inválida falla sin repetir su contenido', () => {
    expect(() => checkDatabaseHost('usuario:clave-secreta', dev)).toThrow(/no es una URL válida/);
    try {
      checkDatabaseHost('clave-secreta sin esquema', dev);
    } catch (error) {
      expect((error as Error).message).not.toContain('clave-secreta');
    }
  });
});
