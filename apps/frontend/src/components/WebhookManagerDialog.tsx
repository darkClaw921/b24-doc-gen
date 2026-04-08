/**
 * WebhookManagerDialog — modal window to manage webhook triggers
 * attached to either a Theme or a single Template.
 *
 * Props:
 *   - `scope`: 'theme' | 'template' — which kind of webhook to show.
 *   - `targetId`: id of the Theme or Template the dialog is scoped to;
 *     null means the dialog is closed.
 *   - `targetName`: human-readable name of the target, shown in the
 *     dialog title.
 *   - `onClose`: called when the dialog should close.
 *
 * Behavior:
 *   - Fetches the full webhook list via `webhooksApi.list()` and
 *     filters to the current `scope` + `targetId` on the client.
 *     (The backend returns joined themeName/templateName so no extra
 *     round-trip is needed to render them, but this dialog only ever
 *     renders items for a single target so that metadata is not used
 *     here.)
 *   - "Создать новый" calls `webhooksApi.create` and invalidates the
 *     list query to re-fetch with fresh join fields.
 *   - Each item exposes:
 *       * readonly `<input>` with the webhook URL
 *       * "Скопировать" button — writes URL to navigator.clipboard and
 *         shows a small toast via `useToast()`. Falls back to an
 *         in-DOM `document.execCommand('copy')` trick when the
 *         Clipboard API is unavailable (old browsers / iframe policy).
 *       * enabled-toggle switch — calls `webhooksApi.patch(id, {enabled})`.
 *       * "Удалить" button — confirms via `window.confirm`, then calls
 *         `webhooksApi.remove(id)`.
 *   - A persistent help block explains how to paste the URL into the
 *     Bitrix24 "Исходящий вебхук" robot.
 *
 * Follows the same feedback pattern as `ThemeSidebar` and
 * `ThemeSettingsDialog`: mutation errors surface inline above the
 * action, successes are silent except for the copy-toast.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  Copy,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';
import {
  ApiError,
  webhooksApi,
  type WebhookListItemDTO,
} from '@/lib/api';

export interface WebhookManagerDialogProps {
  /** Which kind of target this dialog manages. */
  scope: 'theme' | 'template';
  /** Target id (Theme or Template id). `null` closes the dialog. */
  targetId: string | null;
  /** Human-readable name of the target, rendered in the title. */
  targetName?: string | null;
  /** Called when the dialog is dismissed. */
  onClose: () => void;
}

export function WebhookManagerDialog({
  scope,
  targetId,
  targetName,
  onClose,
}: WebhookManagerDialogProps) {
  const open = targetId !== null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const {
    data,
    isLoading,
    isError,
    error: queryError,
  } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => webhooksApi.list().then((r) => r.webhooks),
    enabled: open,
  });

  const items: WebhookListItemDTO[] = useMemo(() => {
    if (!data || !targetId) return [];
    return data.filter((w) => {
      if (w.scope !== scope) return false;
      if (scope === 'theme') return w.themeId === targetId;
      return w.templateId === targetId;
    });
  }, [data, scope, targetId]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['webhooks'] });

  const createMutation = useMutation({
    mutationFn: () => {
      if (!targetId) throw new Error('no target');
      return webhooksApi.create(
        scope === 'theme'
          ? { scope: 'theme', themeId: targetId }
          : { scope: 'template', templateId: targetId },
      );
    },
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(toMessage(err)),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      webhooksApi.patch(id, { enabled }),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(toMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => webhooksApi.remove(id),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(toMessage(err)),
  });

  const handleCopy = async (webhook: WebhookListItemDTO) => {
    const ok = await copyToClipboard(webhook.url);
    if (ok) {
      setCopiedId(webhook.id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === webhook.id ? null : prev));
      }, 1500);
      toast({
        title: 'URL скопирован',
        description: 'Вставьте его в настройку робота «Исходящий вебхук».',
      });
    } else {
      toast({
        title: 'Не удалось скопировать',
        description: 'Выделите URL вручную и скопируйте (Ctrl+C).',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = (webhook: WebhookListItemDTO) => {
    const confirmMsg =
      webhook.label && webhook.label.trim().length > 0
        ? `Удалить webhook «${webhook.label}»?`
        : 'Удалить этот webhook? Действие необратимо.';
    if (!window.confirm(confirmMsg)) return;
    setError(null);
    deleteMutation.mutate(webhook.id);
  };

  const title =
    scope === 'theme'
      ? `Webhook'и темы${targetName ? ` «${targetName}»` : ''}`
      : `Webhook'и шаблона${targetName ? ` «${targetName}»` : ''}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="min-w-0 break-all pr-6">{title}</DialogTitle>
          <DialogDescription>
            Webhook-триггер позволяет запустить генерацию документов из
            робота Bitrix24 «Исходящий вебхук».{' '}
            {scope === 'theme'
              ? 'На каждый вызов генерируются все шаблоны внутри темы.'
              : 'На каждый вызов генерируется этот шаблон.'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4 py-2">
          {/* Instruction block — shown only when at least one webhook
              exists, otherwise there's no URL to paste yet. */}
          {items.length > 0 && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Вставьте URL ниже в настройку робота{' '}
              <span className="font-medium text-foreground">
                «Исходящий вебхук»
              </span>{' '}
              в CRM Bitrix24, метод{' '}
              <span className="font-mono text-foreground">POST</span>.
              Content-Type подставится автоматически.
            </div>
          )}

          {/* Create button */}
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              Настроенные webhook-триггеры
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setError(null);
                createMutation.mutate();
              }}
              disabled={createMutation.isPending || !targetId}
            >
              {createMutation.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="mr-1 h-3.5 w-3.5" />
              )}
              Создать новый
            </Button>
          </div>

          {/* List */}
          {isLoading && (
            <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Загрузка…
            </div>
          )}

          {isError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{toMessage(queryError)}</span>
            </div>
          )}

          {!isLoading && !isError && items.length === 0 && (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              Пока нет webhook'ов. Нажмите «Создать новый», чтобы
              сгенерировать URL.
            </div>
          )}

          <ul className="space-y-3">
            {items.map((webhook) => {
              const isCopied = copiedId === webhook.id;
              const isPatchingThis =
                patchMutation.isPending &&
                patchMutation.variables?.id === webhook.id;
              const isDeletingThis =
                deleteMutation.isPending &&
                deleteMutation.variables === webhook.id;
              return (
                <li
                  key={webhook.id}
                  className="min-w-0 rounded-md border border-border bg-background p-3 shadow-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      readOnly
                      value={webhook.url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 font-mono text-xs"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void handleCopy(webhook)}
                      aria-label="Скопировать URL"
                      className="shrink-0"
                    >
                      {isCopied ? (
                        <>
                          <Check className="mr-1 h-3.5 w-3.5" />
                          Скопировано
                        </>
                      ) : (
                        <>
                          <Copy className="mr-1 h-3.5 w-3.5" />
                          Скопировать
                        </>
                      )}
                    </Button>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-muted-foreground">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5"
                        checked={webhook.enabled}
                        disabled={isPatchingThis}
                        onChange={(e) =>
                          patchMutation.mutate({
                            id: webhook.id,
                            enabled: e.target.checked,
                          })
                        }
                      />
                      <span>
                        {webhook.enabled ? 'Включён' : 'Отключён'}
                        {isPatchingThis ? '…' : ''}
                      </span>
                    </label>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span title="Количество вызовов">
                        Вызовов: {webhook.useCount}
                      </span>
                      {webhook.lastUsedAt && (
                        <span title="Последний вызов">
                          {formatDate(webhook.lastUsedAt)}
                        </span>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(webhook)}
                        disabled={isDeletingThis}
                        aria-label="Удалить webhook"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Writes `text` to the clipboard. Prefers the async Clipboard API,
 * falls back to a hidden `<textarea>` + `document.execCommand('copy')`
 * so it still works inside the Bitrix24 iframe where the async API
 * may be blocked by permissions policy.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function toMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}
