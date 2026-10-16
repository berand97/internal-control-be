import type { EntityManager } from 'typeorm';
import type { AppEvent } from './app-event.js';

export interface EventSubscriber {
  event(event: AppEvent): void;
  resync(): void;
}

export interface EventBus {
  publish(manager: EntityManager, event: AppEvent): Promise<void>;
  subscribe(userId: string, subscriber: EventSubscriber): Promise<() => void>;
}

export const EVENT_BUS = Symbol('EVENT_BUS');
