import type { EntityManager } from 'typeorm';
import type { AppEvent } from './app-event.js';

/** Quien recibe los eventos de un usuario (un stream SSE abierto). */
export interface EventSubscriber {
  /** Evento publicado y confirmado (COMMIT) para el usuario suscrito. No debe lanzar. */
  event(event: AppEvent): void;
  /**
   * El bus pudo haber perdido eventos (se cayó y recuperó la conexión que escucha): el suscriptor debe releer su
   * estado desde la BD (reponer desde su último id y recontar).
   */
  resync(): void;
}

/**
 * Reparto de eventos entre instancias. Implementación de hoy: PgEventBus (PostgreSQL LISTEN/NOTIFY). Otra (Redis,
 * NATS) solo tiene que respetar el contrato: publish se entrega únicamente si la transacción del llamador confirma.
 */
export interface EventBus {
  /**
   * Publica dentro de la transacción de `manager`: el evento sale solo con el COMMIT y se descarta con el ROLLBACK.
   * Llamarlo con un manager sin transacción lo publica en el acto.
   */
  publish(manager: EntityManager, event: AppEvent): Promise<void>;
  /** Suscribe a los eventos de un usuario. Resuelve cuando la suscripción ya recibe; devuelve cómo cancelarla. */
  subscribe(userId: string, subscriber: EventSubscriber): Promise<() => void>;
}

export const EVENT_BUS = Symbol('EVENT_BUS');
