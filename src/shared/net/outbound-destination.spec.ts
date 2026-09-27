import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import {
  assertDestinationAllowed,
  assertHostShapeAllowed,
  guardedLookup,
  isOutboundForbidden,
  isPrivateAddress,
  OutboundDestinationError,
} from './outbound-destination.js';

const production = { allowPrivateNetworks: false, allowedHosts: [] as string[] };
const resolvesTo =
  (...addresses: string[]) =>
  async (): Promise<ReadonlyArray<LookupAddress>> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('destinos salientes (BE-16)', () => {
  it.each([
    '127.0.0.1',
    '127.8.8.8',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '224.0.0.1',
  ])('%s es privada', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '52.95.110.1', '2606:4700::1111'])('%s es pública', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each([
    '127.0.0.1',
    'localhost',
    'LOCALHOST.',
    'gotenberg',
    'postgres',
    'db.internal',
    'nas.local',
    '[::1]',
    '169.254.169.254',
  ])('en producción %s se rechaza sin resolver DNS', (host) => {
    expect(() => assertHostShapeAllowed(host, production)).toThrow(OutboundDestinationError);
  });

  it('fuera de producción (redes privadas permitidas) localhost pasa', async () => {
    await expect(
      assertDestinationAllowed(
        'localhost',
        { allowPrivateNetworks: true, allowedHosts: [] },
        resolvesTo('127.0.0.1'),
      ),
    ).resolves.toBeUndefined();
  });

  it('un nombre público que resuelve a una IP privada se rechaza (basta una sola de sus IP)', async () => {
    await expect(
      assertDestinationAllowed('smtp.evil.example', production, resolvesTo('8.8.8.8', '10.0.0.7')),
    ).rejects.toBeInstanceOf(OutboundDestinationError);
    await expect(
      assertDestinationAllowed('smtp.office365.com', production, resolvesTo('52.95.110.1')),
    ).resolves.toBeUndefined();
  });

  it('OUTBOUND_ALLOWED_HOSTS admite un host o una IP concretos', async () => {
    const policy = { allowPrivateNetworks: false, allowedHosts: ['minio', '10.0.0.9'] };
    await expect(assertDestinationAllowed('minio', policy, resolvesTo('10.0.0.9'))).resolves.toBeUndefined();
    await expect(
      assertDestinationAllowed('s3.corp.example', policy, resolvesTo('10.0.0.9')),
    ).resolves.toBeUndefined();
    await expect(
      assertDestinationAllowed('s3.corp.example', policy, resolvesTo('10.0.0.10')),
    ).rejects.toBeInstanceOf(OutboundDestinationError);
  });

  it('guardedLookup valida lo que resuelve en el momento de conectar (DNS rebinding)', async () => {
    let answer = '52.95.110.1';
    const lookup = guardedLookup(production, async () => [{ address: answer, family: 4 }]) as unknown as (
      hostname: string,
      options: object,
      callback: (error: unknown, address?: unknown) => void,
    ) => void;
    const call = () =>
      new Promise<unknown>((resolve, reject) => {
        lookup('smtp.rebind.example', {}, (error, address) => (error ? reject(error) : resolve(address)));
      });
    await expect(call()).resolves.toBe('52.95.110.1');
    answer = '127.0.0.1';
    const failure = await call().catch((error: unknown) => error);
    expect(isOutboundForbidden(failure)).toBe(true);
  });

  it('el error no repite el host ni la IP', () => {
    expect(new OutboundDestinationError().message).not.toMatch(/\d+\.\d+/);
  });
});
