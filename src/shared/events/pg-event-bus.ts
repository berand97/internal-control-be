import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import type { AppConfig } from '../../config/configuration.js';
import { APP_EVENTS_CHANNEL, type AppEvent, parseAppEvent, serializeAppEvent } from './app-event.js';
import type { EventBus, EventSubscriber } from './event-bus.js';
import { EventsMetrics } from './events-metrics.js';

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

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** Consulta de salud de la conexión LISTEN: una conexión muerta en silencio se detecta y se reabre. */
const HEALTH_CHECK_MS = 30_000;

/**
 * EventBus sobre PostgreSQL LISTEN/NOTIFY.
 * - publish: `SELECT pg_notify('app_events', json)` con el manager del llamador. PostgreSQL entrega el NOTIFY solo si la
 *   transacción hace COMMIT (y en orden de commit); con ROLLBACK se descarta. Así ningún evento sale para una fila que
 *   no existe, sin construir un "after-commit" a mano, y con varias instancias todas reciben lo mismo.
 * - Recepción: UNA conexión dedicada por instancia (fuera del pool de TypeORM) con `LISTEN app_events`, abierta al
 *   llegar la primera suscripción (los procesos sin streams — CLI, pruebas, exportador de OpenAPI — no la abren). Si se
 *   cae se reabre con espera creciente y, al volver, se pide resync a cada suscriptor: lo que se publicó mientras
 *   estaba caída se repone desde la BD.
 * - Reparto local: userId → suscriptores de esta instancia.
 */
@Injectable()
export class PgEventBus implements EventBus, OnModuleDestroy {
  private readonly logger = new Logger(PgEventBus.name);
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  private client: PgClient | null = null;
  private listening = false;
  private starting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private pendingResync = false;
  private stopped = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly metrics: EventsMetrics,
  ) {}

  async publish(manager: EntityManager, event: AppEvent): Promise<void> {
    await manager.query('SELECT pg_notify($1, $2)', [APP_EVENTS_CHANNEL, serializeAppEvent(event)]);
  }

  async subscribe(userId: string, subscriber: EventSubscriber): Promise<() => void> {
    let set = this.subscribers.get(userId);
    if (!set) {
      set = new Set();
      this.subscribers.set(userId, set);
    }
    set.add(subscriber);
    await this.ensureListening();
    return () => {
      const current = this.subscribers.get(userId);
      if (current?.delete(subscriber) && current.size === 0) {
        this.subscribers.delete(userId);
      }
    };
  }

  /** Suscriptores registrados (pruebas: sin fugas al cerrar streams). */
  subscriberCount(): number {
    let total = 0;
    for (const set of this.subscribers.values()) {
      total += set.size;
    }
    return total;
  }

  isListening(): boolean {
    return this.listening;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.subscribers.clear();
    await this.starting?.catch(() => undefined);
    await this.closeClient(true);
  }

  private ensureListening(): Promise<void> {
    if (this.listening || this.stopped) {
      return Promise.resolve();
    }
    if (this.reconnectTimer) {
      // Ya hay una reconexión programada: el suscriptor recibirá resync cuando vuelva.
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
      application_name: 'control-interno-events',
    });
    client.on('notification', (message) => this.dispatch(message));
    client.on('error', (error) => this.lost(client, error));
    client.on('end', () => this.lost(client, null));
    try {
      await client.connect();
      await client.query(`LISTEN ${APP_EVENTS_CHANNEL}`);
    } catch (error) {
      this.lost(client, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (this.stopped) {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.listening = true;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.healthTimer = setInterval(() => {
      client.query('SELECT 1').catch((error: unknown) => {
        this.lost(client, error instanceof Error ? error : new Error(String(error)));
      });
    }, HEALTH_CHECK_MS);
    this.healthTimer.unref();
    if (this.pendingResync) {
      this.pendingResync = false;
      this.metrics.busReconnected();
      this.logger.log('Conexión LISTEN recuperada; se reponen los streams abiertos');
      this.resyncAll();
    }
  }

  private dispatch(message: PgNotification): void {
    if (message.channel !== APP_EVENTS_CHANNEL) {
      return;
    }
    const event = parseAppEvent(message.payload);
    if (!event) {
      this.logger.warn('Evento con payload inválido descartado');
      return;
    }
    const set = this.subscribers.get(event.userId);
    if (!set) {
      return;
    }
    for (const subscriber of set) {
      try {
        subscriber.event(event);
      } catch (error) {
        this.logger.error(`Suscriptor falló al recibir ${event.type}: ${error instanceof Error ? error.message : 'error'}`);
      }
    }
  }

  private resyncAll(): void {
    for (const set of this.subscribers.values()) {
      for (const subscriber of set) {
        try {
          subscriber.resync();
        } catch {
          // El suscriptor maneja sus propios errores; uno roto no detiene a los demás.
        }
      }
    }
  }

  /** La conexión se cayó (o no se pudo abrir): se descarta y se programa otra si hace falta. */
  private lost(client: PgClient, error: Error | null): void {
    if (this.client !== null && this.client !== client) {
      return;
    }
    const wasListening = this.listening;
    if (wasListening || this.subscribers.size > 0) {
      this.pendingResync = true;
    }
    this.listening = false;
    this.client = null;
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
      if (this.stopped || this.subscribers.size === 0) {
        // Sin nadie escuchando no hace falta la conexión: la próxima suscripción la abre.
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

  private async closeClient(unlisten: boolean): Promise<void> {
    const client = this.client;
    this.client = null;
    this.listening = false;
    if (!client) {
      return;
    }
    client.removeAllListeners();
    client.on('error', () => undefined);
    if (unlisten) {
      await client.query(`UNLISTEN ${APP_EVENTS_CHANNEL}`).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}
