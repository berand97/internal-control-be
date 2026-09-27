import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Destinos salientes configurables por administradores (host SMTP, endpoint S3) (BE-16).
 *
 * Sin esta guarda, quien tenga mail:manage:global o storage:manage:global podía apuntar el servidor a
 * 127.0.0.1:5432, http://gotenberg:3000 o 169.254.169.254 y usar las pruebas de conexión como oráculo de la red
 * interna. La política:
 * - allowPrivateNetworks (OUTBOUND_ALLOW_PRIVATE_NETWORKS): por defecto true fuera de producción (MailHog/MinIO en
 *   localhost siguen funcionando) y false en producción.
 * - allowedHosts (OUTBOUND_ALLOWED_HOSTS): excepciones explícitas, por nombre de host o IP exacta.
 *
 * Se comprueba al guardar (400) y en cada conexión: la resolución DNS pasa por `guardedLookup`, que valida las
 * direcciones que efectivamente se usan para conectar, así un DNS que cambia después de guardar (rebinding) no
 * salta la guarda.
 */
export interface OutboundPolicy {
  readonly allowPrivateNetworks: boolean;
  readonly allowedHosts: ReadonlyArray<string>;
}

export const OUTBOUND_FORBIDDEN_CODE = 'EOUTBOUNDFORBIDDEN';

export class OutboundDestinationError extends Error {
  readonly code = OUTBOUND_FORBIDDEN_CODE;

  constructor() {
    // Sin el host ni la IP: el mensaje puede terminar en un log o en la respuesta.
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

/** Host en minúsculas, sin corchetes IPv6 ni punto final. */
export const normalizeHost = (host: string): string =>
  host.trim().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '').toLowerCase();

/** true si la IP es de loopback, red privada (RFC 1918/4193), link-local (incl. metadatos de nube) o reservada. */
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

/**
 * Comprobación sin DNS: IP literal privada, `localhost`, sufijos internos (.local, .internal…) o nombre de una
 * sola etiqueta (`gotenberg`, `postgres`: nombres de servicios del compose). Lanza OutboundDestinationError.
 */
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
  // Todas: si una sola es privada, el cliente podría elegirla.
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

/**
 * Validación al guardar la configuración: forma del host y, si el nombre resuelve, sus direcciones.
 * Un nombre que hoy no resuelve se acepta (la conexión vuelve a validar con guardedLookup).
 */
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

/**
 * `lookup` para net.connect / tls.connect / http(s).Agent: resuelve, valida cada dirección y entrega al socket
 * exactamente las que validó. Las IP literales no pasan por lookup: validarlas antes con assertHostShapeAllowed.
 */
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

/** true si el error (o su causa) viene de esta guarda. */
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
