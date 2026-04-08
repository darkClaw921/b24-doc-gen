/**
 * `useApiError` — small React hook that converts an unknown error
 * (typically thrown by `apiRequest` / `uploadRequest` from `lib/api.ts`)
 * into a structured object and pushes a destructive toast.
 *
 * Usage:
 *
 *   const handleError = useApiError();
 *   const mutation = useMutation({
 *     mutationFn: () => themesApi.create({ name }),
 *     onError: (err) => handleError(err, 'Не удалось создать тему'),
 *   });
 *
 * The returned function:
 *
 *   1. Inspects the error: ApiError → uses its status/message; plain
 *      Error → uses .message; everything else → falls back to title.
 *   2. Picks a user-friendly Russian title for common HTTP statuses
 *      (401, 403, 404, 409, 5xx).
 *   3. Calls `toast({ variant: 'destructive', ... })`.
 *
 * The hook itself is a thin wrapper around the imperative `toast` so
 * it can also be called from non-React code (just import the helper
 * `reportApiError` directly).
 */

import { useCallback } from 'react';
import { ApiError } from './api';
import { toast } from '@/components/ui/use-toast';

interface ReportedError {
  status: number;
  message: string;
  code?: string;
}

function statusTitle(status: number, fallback: string): string {
  if (status === 401) return 'Требуется авторизация Bitrix24';
  if (status === 403) return 'Недостаточно прав';
  if (status === 404) return 'Не найдено';
  if (status === 409) return 'Конфликт данных';
  if (status === 413) return 'Файл слишком большой';
  if (status === 429) return 'Слишком много запросов';
  if (status >= 500) return 'Ошибка сервера';
  if (status === 0) return 'Сеть недоступна';
  return fallback;
}

/** Imperative version usable outside React. */
export function reportApiError(err: unknown, fallbackTitle = 'Ошибка'): ReportedError {
  let status = 0;
  let message = '';
  let code: string | undefined;

  if (err instanceof ApiError) {
    status = err.status;
    message = err.message;
    code = err.code;
  } else if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === 'string') {
    message = err;
  } else {
    message = 'Неизвестная ошибка';
  }

  const title = statusTitle(status, fallbackTitle);
  toast({
    variant: 'destructive',
    title,
    description: message || fallbackTitle,
  });

  return { status, message: message || title, code };
}

/** React hook returning a stable callback bound to the global toaster. */
export function useApiError(): (err: unknown, fallbackTitle?: string) => ReportedError {
  return useCallback((err: unknown, fallbackTitle?: string) => {
    return reportApiError(err, fallbackTitle);
  }, []);
}
