import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../../config/configuration.js';

/** Lo que se usa del cliente de node-postgres (el mismo módulo `pg` que cargó TypeORM). */
interface PgNotification {
  readonly channel: string;
  readonly payload?: string;
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (message: PgNotification) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(): unknown;
}

interface PgModule {
  readonly Client: new (config: {
    connectionString: string;
    keepAlive: boolean;
    application_name: string;
  }) => PgClient;
}

/** Quien escucha un canal. */
export interface PgChannelHandler {
  /** Llegó un NOTIFY por el canal (payload tal cual; puede faltar). */
  notification(payload: string | undefined): void;
  /**
   * La conexión LISTEN se cayó y volvió: lo notificado mientras tanto se perdió y hay que reponerlo desde la BD.
   * No se llama en la primera apertura.
   */
  reconnected(): void;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** Consulta de salud de la conexión LISTEN: una conexión muerta en silencio se detecta y se reabre. */
const HEALTH_CHECK_MS = 30_000;
/** Nombre de la conexión en pg_stat_activity (las pruebas la ubican por él). */
export const PG_LISTENER_APPLICATION_NAME = 'control-interno-events';
/** Los nombres de canal se interpolan en LISTEN/UNLISTEN: solo identificadores simples. */
const CHANNEL_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * UNA conexión dedicada de PostgreSQL por proceso (fuera del pool de TypeORM) para LISTEN de varios canales: la usan el
 * bus de eventos (`app_events`) y la caché de módulos (`feature_flags`).
 * - Se abre al registrarse el primer canal: los procesos que no escuchan nada (CLI, exportador de OpenAPI, la mayoría
 *   de pruebas) no la abren.
 * - Si se cae se reabre con espera creciente, vuelve a hacer LISTEN de todos los canales y avisa `reconnected()` a cada
 *   manejador para que reponga desde la BD lo que se perdió.
 * - Consulta de salud periódica: una conexión muerta en silencio también se detecta.
 */
@Injectable()
export class PgListener implements OnModuleDestroy {
  private readonly logger = new Logger(PgListener.name);
  private readonly channels = new Map<string, Set<PgChannelHandler>>();
  /** Canales con LISTEN hecho en la conexión actual. */
  private readonly active = new Set<string>();
  private client: PgClient | null = null;
  private listening = false;
  private starting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private pendingReconnected = false;
  private stopped = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Registra un manejador para el canal y asegura la conexión. Devuelve la función que lo retira (al quedar el canal
   * sin manejadores se hace UNLISTEN; la conexión sigue abierta mientras haya otros canales).
   */
  async listen(channel: string, handler: PgChannelHandler): Promise<() => void> {
    if (!CHANNEL_PATTERN.test(channel)) {
      throw new Error(`Canal LISTEN inválido: ${channel}`);
    }
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(handler);
    if (this.listening && this.client) {
      await this.syncChannels(this.client);
    } else {
      await this.ensureListening();
    }
    return () => this.unlisten(channel, handler);
  }

  isListening(): boolean {
    return this.listening;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.channels.clear();
    await this.starting?.catch(() => undefined);
    await this.closeClient();
  }

  private unlisten(channel: string, handler: PgChannelHandler): void {
    const set = this.channels.get(channel);
    if (!set?.delete(handler) || set.size > 0) {
      return;
    }
    this.channels.delete(channel);
    this.active.delete(channel);
    if (this.listening && this.client) {
      void this.client.query(`UNLISTEN ${channel}`).catch(() => undefined);
    }
  }

  private ensureListening(): Promise<void> {
    if (this.listening || this.stopped) {
      return Promise.resolve();
    }
    if (this.reconnectTimer) {
      // Ya hay una reconexión programada: el manejador recibirá reconnected() cuando vuelva.
      return Promise.resolve();
    }
    this.starting ??= this.connect().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async connect(): Promise<void> {
    const pg = (this.dataSource.driver as unknown as { postgres: PgModule }).postgres;
    const client = new pg.Client({
      connectionString: this.config.getOrThrow('database.url', { infer: true }),
      keepAlive: true,
      application_name: PG_LISTENER_APPLICATION_NAME,
    });
    client.on('notification', (message) => this.dispatch(message));
    client.on('error', (error) => this.lost(client, error));
    client.on('end', () => this.lost(client, null));
    try {
      await client.connect();
    } catch (error) {
      this.lost(client, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (this.stopped) {
      client.removeAllListeners();
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.listening = true;
    this.active.clear();
    if (!(await this.syncChannels(client))) {
      return;
    }
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.healthTimer = setInterval(() => {
      client.query('SELECT 1').catch((error: unknown) => {
        this.lost(client, error instanceof Error ? error : new Error(String(error)));
      });
    }, HEALTH_CHECK_MS);
    this.healthTimer.unref();
    if (this.pendingReconnected) {
      this.pendingReconnected = false;
      this.logger.log('Conexión LISTEN recuperada; se repone lo notificado durante la caída');
      for (const set of this.channels.values()) {
        for (const handler of set) {
          try {
            handler.reconnected();
          } catch {
            // Cada manejador maneja sus propios errores; uno roto no detiene a los demás.
          }
        }
      }
    }
  }

  /** LISTEN de los canales registrados que aún no lo tienen en esta conexión. false si la conexión falló. */
  private async syncChannels(client: PgClient): Promise<boolean> {
    try {
      for (const channel of this.channels.keys()) {
        if (this.active.has(channel)) {
          continue;
        }
        this.active.add(channel);
        await client.query(`LISTEN ${channel}`);
      }
      return true;
    } catch (error) {
      this.lost(client, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private dispatch(message: PgNotification): void {
    const set = this.channels.get(message.channel);
    if (!set) {
      return;
    }
    for (const handler of set) {
      try {
        handler.notification(message.payload);
      } catch (error) {
        this.logger.error(
          `Manejador del canal ${message.channel} falló: ${error instanceof Error ? error.message : 'error'}`,
        );
      }
    }
  }

  /** La conexión se cayó (o no se pudo abrir): se descarta y se programa otra si hace falta. */
  private lost(client: PgClient, error: Error | null): void {
    if (this.client !== null && this.client !== client) {
      return;
    }
    const wasListening = this.listening;
    if (wasListening || this.channels.size > 0) {
      this.pendingReconnected = true;
    }
    this.listening = false;
    this.client = null;
    this.active.clear();
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    client.removeAllListeners();
    // Sin manejador de 'error' un error tardío del socket tumbaría el proceso.
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    if (wasListening || error) {
      // El mensaje del driver no lleva datos de la aplicación (host o código de error).
      this.logger.warn(`Conexión LISTEN perdida (${error?.message ?? 'cerrada'}); reintento en ${this.reconnectDelay} ms`);
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.channels.size === 0) {
        // Sin nadie escuchando no hace falta la conexión: el próximo listen() la abre.
        return;
      }
      void this.ensureListening();
    }, delay);
    this.reconnectTimer.unref();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.listening = false;
    this.active.clear();
    if (!client) {
      return;
    }
    client.removeAllListeners();
    client.on('error', () => undefined);
    await client.query('UNLISTEN *').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
