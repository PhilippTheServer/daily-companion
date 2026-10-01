import { HttpErrorResponse } from '@angular/common/http';
import type { ErrorBody } from './types';

/** An API failure in the backend's {code, message, field} shape. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field: string | null,
    readonly status: number,
  ) {
    super(message);
  }
}

function isErrorBody(body: unknown): body is ErrorBody {
  const candidate = body as Partial<ErrorBody> | null;
  return typeof candidate?.code === 'string' && typeof candidate.message === 'string';
}

/** Any thrown value as an ApiError; the network being down is `offline`. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof HttpErrorResponse) {
    if (isErrorBody(error.error)) {
      return new ApiError(
        error.error.code,
        error.error.message,
        error.error.field ?? null,
        error.status,
      );
    }
    if (error.status === 0) {
      return new ApiError('offline', 'The server cannot be reached.', null, 0);
    }
    return new ApiError(
      'internal',
      `The server answered HTTP ${error.status}.`,
      null,
      error.status,
    );
  }
  return new ApiError('internal', error instanceof Error ? error.message : String(error), null, 0);
}

const TITLES: Record<string, string> = {
  validation: 'Please check the input',
  not_found: 'Not found',
  conflict: 'Conflict',
  stale_head: 'Changed in the meantime, reload to see the latest version',
  unauthorized: 'Signed out',
  forbidden: 'This account may not use daily',
  upstream: 'An outside service did not answer',
  internal: 'Something went wrong',
  offline: 'Offline',
};

const STATUS_TITLES: Record<number, string> = {
  401: TITLES['unauthorized'],
  403: TITLES['forbidden'],
};

/** The single place that turns an error into the sentence the user reads. */
export function errorText(error: unknown): string {
  const { code, message, status } = toApiError(error);
  const title = TITLES[code] ?? STATUS_TITLES[status] ?? TITLES['internal'];
  return `${title}: ${message}`;
}
