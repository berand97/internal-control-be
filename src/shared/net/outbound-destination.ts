import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export interface OutboundPolicy {
  readonly allowPrivateNetworks: boolean;
  readonly allowedHosts: ReadonlyArray<string>;
}

export const OUTBOUND_FORBIDDEN_CODE = 'EOUTBOUNDFORBIDDEN';

export class OutboundDestinationError extends Error {
  readonly code = OUTBOUND_FORBIDDEN_CODE;

  constructor() {
    super('Destino saliente no permitido: red privada, loopback o link-local');
    this.name = 'OutboundDestinationError';
  }
}

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

const MAPPED_V4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const INTERNAL_NAME = /(^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home\.arpa$)/i;

export const normalizeHost = (host: string): string =>
  host.trim().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '').toLowerCase();

export const isPrivateAddress = (address: string): boolean => {
  const normalized = normalizeHost(address);
  const mapped = MAPPED_V4.exec(normalized)?.[1];
  if (mapped) {
    return BLOCKED.check(mapped, 'ipv4');
  }
  const family = isIP(normalized);
  if (family === 4) {
    return BLOCKED.check(normalized, 'ipv4');
  }
  if (family === 6) {
    return BLOCKED.check(normalized, 'ipv6');
  }
  return false;
};

const isAllowedHost = (host: string, policy: OutboundPolicy): boolean =>
  policy.allowedHosts.some((allowed) => normalizeHost(allowed) === normalizeHost(host));

export const assertHostShapeAllowed = (host: string, policy: OutboundPolicy): void => {
  if (policy.allowPrivateNetworks || isAllowedHost(host, policy)) {
    return;
  }
  const normalized = normalizeHost(host);
  if (normalized === '') {
    throw new OutboundDestinationError();
  }
  if (isIP(normalized) !== 0) {
    if (isPrivateAddress(normalized)) {
      throw new OutboundDestinationError();
    }
    return;
  }
  if (INTERNAL_NAME.test(normalized) || !normalized.includes('.')) {
    throw new OutboundDestinationError();
  }
};

const assertAddressesAllowed = (
  host: string,
  addresses: ReadonlyArray<string>,
  policy: OutboundPolicy,
): void => {
  if (policy.allowPrivateNetworks || isAllowedHost(host, policy)) {
    return;
  }
  for (const address of addresses) {
    if (isPrivateAddress(address) && !isAllowedHost(address, policy)) {
      throw new OutboundDestinationError();
    }
  }
};

type LookupAll = (hostname: string, options: LookupAllOptions) => Promise<ReadonlyArray<LookupAddress>>;

const defaultLookupAll: LookupAll = (hostname, options) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, options, (error, addresses) => (error ? reject(error) : resolve(addresses)));
  });

export const assertDestinationAllowed = async (
  host: string,
  policy: OutboundPolicy,
  lookupAll: LookupAll = defaultLookupAll,
): Promise<void> => {
  assertHostShapeAllowed(host, policy);
  if (policy.allowPrivateNetworks || isAllowedHost(host, policy) || isIP(normalizeHost(host)) !== 0) {
    return;
  }
  let addresses: ReadonlyArray<LookupAddress>;
  try {
    addresses = await lookupAll(normalizeHost(host), { all: true });
  } catch {
    return;
  }
  assertAddressesAllowed(host, addresses.map((item) => item.address), policy);
};

export const guardedLookup = (
  policy: OutboundPolicy,
  lookupAll: LookupAll = defaultLookupAll,
): LookupFunction =>
  ((hostname: string, options: { family?: number | string; all?: boolean }, callback: (...args: unknown[]) => void) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family ?? 0);
    lookupAll(hostname, { all: true, ...(family === 4 || family === 6 ? { family } : {}) })
      .then((addresses) => {
        assertAddressesAllowed(hostname, addresses.map((item) => item.address), policy);
        if (options.all) {
          callback(null, addresses);
          return;
        }
        const first = addresses[0];
        if (!first) {
          callback(Object.assign(new Error('Sin direcciones para el host'), { code: 'ENOTFOUND' }));
          return;
        }
        callback(null, first.address, first.family);
      })
      .catch((error: unknown) => callback(error));
  }) as unknown as LookupFunction;

export const isOutboundForbidden = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === OUTBOUND_FORBIDDEN_CODE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};
