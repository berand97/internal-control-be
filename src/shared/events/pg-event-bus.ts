import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { APP_EVENTS_CHANNEL, type AppEvent, parseAppEvent, serializeAppEvent } from './app-event.js';
import type { EventBus, EventSubscriber } from './event-bus.js';
import { EventsMetrics } from './events-metrics.js';
import { PgListener } from './pg-listener.js';

/**
 * EventBus sobre PostgreSQL LISTEN/NOTIFY.
 * - publish: `SELECT pg_notify('app_events', json)` con el manager del llamador. PostgreSQL entrega el NOTIFY solo si la
 *   transacción hace COMMIT (y en orden de commit); con ROLLBACK se descarta. Así ningún evento sale para una fila que
 *   no existe, sin construir un "after-commit" a mano, y con varias instancias todas reciben lo mismo.
 * - Recepción: `LISTEN app_events` sobre la conexión dedicada compartida del proceso (PgListener, fuera del pool de
 *   TypeORM), pedida al llegar la primera suscripción (los procesos sin streams — CLI, pruebas, exportador de OpenAPI —
 *   no la piden). Si se cae, PgListener la reabre con espera creciente y, al volver, se pide resync a cada suscriptor:
 *   lo que se publicó mientras estaba caída se repone desde la BD.
 * - Reparto local: userId → suscriptores de esta instancia.
 */
@Injectable()
export class PgEventBus implements EventBus, OnModuleDestroy {
  private readonly logger = new Logger(PgEventBus.name);
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  private registration: Promise<() => void> | null = null;
  private registered = false;
  private stopped = false;

  constructor(
    private readonly listener: PgListener,
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
    return this.registered && !this.stopped && this.listener.isListening();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.subscribers.clear();
  }

  /** El canal se registra una sola vez por proceso; la conexión (y su reconexión) es de PgListener. */
  private async ensureListening(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.registration ??= this.listener.listen(APP_EVENTS_CHANNEL, {
      notification: (payload) => this.dispatch(payload),
      reconnected: () => {
        this.metrics.busReconnected();
        this.logger.log('Conexión LISTEN recuperada; se reponen los streams abiertos');
        this.resyncAll();
      },
    });
    try {
      await this.registration;
      this.registered = true;
    } catch (error) {
      this.registration = null;
      throw error;
    }
  }

  private dispatch(payload: string | undefined): void {
    const event = parseAppEvent(payload);
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
}
