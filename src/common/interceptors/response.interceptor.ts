import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type {
  ResponseEnvelope,
  SuccessEnvelope,
} from '../types/response-envelope.type.js';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ResponseEnvelope<T>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ResponseEnvelope<T>> {
    return next.handle().pipe(
      map((data): SuccessEnvelope<T> => ({
        data,
        type: 'SUCCESS',
        action: 'CONTINUE',
      })),
    );
  }
}
