export const ALLOW_REMOTE_DATABASE_ENV = 'ALLOW_REMOTE_DATABASE';

const LOCAL_CONTAINER_HOSTS = new Set(['postgres']);

type Env = Readonly<Record<string, string | undefined>>;

export type DatabaseHostDecision =
  | { readonly allowed: 'production' }
  | { readonly allowed: 'local'; readonly hosts: ReadonlyArray<string> }
  | { readonly allowed: 'escape'; readonly hosts: ReadonlyArray<string>; readonly warning: string };

const stripBrackets = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

export const isLocalDatabaseHost = (rawHost: string): boolean => {
  const host = stripBrackets(rawHost.trim().toLowerCase());
  if (host === '' || host.startsWith('/')) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    return ipv4.slice(1).every((octet) => Number(octet) <= 255);
  }
  return LOCAL_CONTAINER_HOSTS.has(host);
};

const databaseHosts = (url: string): ReadonlyArray<string> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL no es una URL válida (postgres://usuario:clave@host:puerto/base)');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL no es una URL válida: debe empezar por postgres:// o postgresql://');
  }
  const queryHosts = parsed.searchParams.getAll('host');
  return queryHosts.length > 0 ? queryHosts : [parsed.hostname];
};

export const checkDatabaseHost = (url: string, env: Env): DatabaseHostDecision => {
  if (env['NODE_ENV'] === 'production') {
    return { allowed: 'production' };
  }
  const hosts = databaseHosts(url);
  const remote = hosts.filter((host) => !isLocalDatabaseHost(host));
  if (remote.length === 0) {
    return { allowed: 'local', hosts };
  }
  const shown = remote.map((host) => host || '(vacío)').join(', ');
  if (env[ALLOW_REMOTE_DATABASE_ENV] === 'true') {
    return {
      allowed: 'escape',
      hosts,
      warning:
        `${ALLOW_REMOTE_DATABASE_ENV}=true: conectando a la base de datos NO local ${shown} ` +
        `con NODE_ENV=${env['NODE_ENV'] ?? '(sin definir)'}. Verifique que no sea la de producción.`,
    };
  }
  throw new Error(
    `DATABASE_URL apunta a un host no local (${shown}) y NODE_ENV no es production. ` +
      'Fuera de producción solo se permite localhost, 127.0.0.0/8, ::1 o el contenedor "postgres" de docker-compose.dev.yml. ' +
      `Si de verdad necesita esa base, declare ${ALLOW_REMOTE_DATABASE_ENV}=true.`,
  );
};

export const guardDatabaseUrl = (url: string, env: Env, warn: (message: string) => void): string => {
  const decision = checkDatabaseHost(url, env);
  if (decision.allowed === 'escape') {
    warn(decision.warning);
  }
  return url;
};
