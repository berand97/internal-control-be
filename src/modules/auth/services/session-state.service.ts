import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UserStatus } from '../enums/user-status.enum.js';
import { isInvitationExpired } from './invitation-policy.js';

/** Estado de la sesión que el guard JWT necesita en cada petición. */
export interface LiveSessionState {
  readonly mustChangePassword: boolean;
}

interface SessionRow {
  readonly status: UserStatus;
  readonly must_change_password: boolean;
  readonly invitation_expires_at: Date | null;
  readonly session_active: boolean;
}

interface CacheEntry {
  readonly state: LiveSessionState;
  readonly expiresAt: number;
}

/**
 * Vida de una respuesta positiva en caché. Es el retraso máximo con el que OTRA réplica ve una revocación; en la
 * réplica que la ejecuta, la invalidación explícita (invalidate) la hace inmediata.
 */
export const SESSION_STATE_TTL_MS = 5_000;
/** Tope de entradas: evita que la caché crezca sin límite con muchas sesiones distintas. */
const MAX_ENTRIES = 10_000;

/**
 * Validez de la sesión en cada petición autenticada (BE-09). Un access token solo sirve si su familia de refresh
 * (claim sid) sigue ACTIVE y sin vencer, y si el usuario puede usar la cuenta (ACTIVE, o PENDING_ACTIVATION con
 * la contraseña temporal aún vigente). Así logout, desactivación, suspensión, revocación de sesiones o reset de MFA
 * surten efecto de inmediato, no al vencer el token.
 *
 * Costo: una consulta por petición cuando no hay caché (dos búsquedas por clave primaria); las respuestas positivas
 * se guardan SESSION_STATE_TTL_MS por (usuario, sesión). Las negativas no se guardan: una sesión cerrada nunca vuelve
 * a ser válida y un usuario reactivado debe verse en el acto.
 */
@Injectable()
export class SessionStateService {
  private readonly entries = new Map<string, Map<string, CacheEntry>>();
  private size = 0;

  constructor(private readonly dataSource: DataSource) {}

  /** null si la sesión ya no es utilizable. */
  async resolve(
    userId: string,
    sessionId: string,
    now: number = Date.now(),
  ): Promise<LiveSessionState | null> {
    const cached = this.entries.get(userId)?.get(sessionId);
    if (cached && cached.expiresAt > now) {
      return cached.state;
    }
    const [row] = (await this.dataSource.query(
      `SELECT u.status, u.must_change_password, u.invitation_expires_at,
              EXISTS (
                SELECT 1 FROM refresh_token_family f
                WHERE f.id = $2 AND f.user_id = u.id AND f.status = 'ACTIVE' AND f.expires_at > NOW()
              ) AS session_active
       FROM app_user u
       WHERE u.id = $1`,
      [userId, sessionId],
    )) as SessionRow[];
    if (!row || !row.session_active || !isUsable(row, new Date(now))) {
      this.forget(userId, sessionId);
      return null;
    }
    const state: LiveSessionState = {
      mustChangePassword: row.must_change_password === true,
    };
    this.remember(userId, sessionId, {
      state,
      expiresAt: now + SESSION_STATE_TTL_MS,
    });
    return state;
  }

  /** Borra lo guardado del usuario: se llama al cerrar sesiones o cambiar el estado de la cuenta. */
  invalidate(userId: string): void {
    const sessions = this.entries.get(userId);
    if (sessions) {
      this.size -= sessions.size;
      this.entries.delete(userId);
    }
  }

  private remember(userId: string, sessionId: string, entry: CacheEntry): void {
    if (this.size >= MAX_ENTRIES) {
      this.entries.clear();
      this.size = 0;
    }
    let sessions = this.entries.get(userId);
    if (!sessions) {
      sessions = new Map();
      this.entries.set(userId, sessions);
    }
    if (!sessions.has(sessionId)) {
      this.size += 1;
    }
    sessions.set(sessionId, entry);
  }

  private forget(userId: string, sessionId: string): void {
    const sessions = this.entries.get(userId);
    if (sessions?.delete(sessionId)) {
      this.size -= 1;
      if (sessions.size === 0) {
        this.entries.delete(userId);
      }
    }
  }
}

/** Misma regla que AuthService.assertAccountUsable, sobre la fila leída. */
const isUsable = (row: SessionRow, now: Date): boolean => {
  const mustChange = row.must_change_password === true;
  const statusAllows =
    row.status === UserStatus.Active ||
    (row.status === UserStatus.PendingActivation && mustChange);
  if (!statusAllows) {
    return false;
  }
  return !(
    mustChange &&
    isInvitationExpired(
      row.invitation_expires_at ? new Date(row.invitation_expires_at) : null,
      now,
    )
  );
};
