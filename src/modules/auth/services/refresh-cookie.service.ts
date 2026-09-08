import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import {
  REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_PATH,
} from '../../../common/constants/refresh-token-cookie.constant.js';
import type { AppConfig } from '../../../config/configuration.js';

@Injectable()
export class RefreshCookieService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  attach(res: Response, refreshToken: string | null): void {
    if (refreshToken === null) {
      return;
    }
    res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, this.buildOptions());
  }

  clear(res: Response): void {
    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, this.buildOptions());
  }

  private buildOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.getOrThrow('refreshCookie.secure', { infer: true }),
      sameSite: 'strict',
      path: REFRESH_TOKEN_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS * 1000,
    };
  }
}
