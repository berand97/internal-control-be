import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UserStatus } from '../enums/user-status.enum.js';
import { isInvitationExpired } from './invitation-policy.js';

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

export const SESSION_STATE_TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;

@Injectable()
export class SessionStateService {
  private readonly entries = new Map<string, Map<string, CacheEntry>>();
  private size = 0;

  constructor(private readonly dataSource: DataSource) {}

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
