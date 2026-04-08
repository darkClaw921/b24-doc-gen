/**
 * ThemeSettingsDialog — modal for editing per-theme generation
 * settings. Mounted from ThemeSidebar's per-theme dropdown menu.
 *
 * Settings exposed:
 *   - addToTimeline: whether the generate pipeline posts a timeline
 *     comment with the generated .docx attached.
 *   - dealFieldBinding: which UF_CRM_* file field on the deal entity
 *     receives the generated document. NULL means "fall back to the
 *     global AppSettings.dealFieldBinding". Multi-value fields are
 *     supported by the backend (it appends instead of replacing).
 *
 * The dialog also embeds a "Создать поле" sub-flow that calls
 * `settingsApi.createField` to register a brand-new UF_CRM_* file
 * field on the deal entity, then auto-selects it as the binding.
 * This is the same backend endpoint used by SettingsPage but inlined
 * here so admins can stay inside the per-theme settings.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, AlertCircle } from 'lucide-react';
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
import {
  ApiError,
  settingsApi,
  themesApi,
  type ThemeDTO,
  type DealFileFieldDTO,
} from '@/lib/api';

export interface ThemeSettingsDialogProps {
  /** The theme being edited; null means dialog is closed. */
  theme: ThemeDTO | null;
  /** Called when the dialog should close. */
  onClose: () => void;
}

export function ThemeSettingsDialog({ theme, onClose }: ThemeSettingsDialogProps) {
  const queryClient = useQueryClient();
  const open = theme !== null;

  /* ------------------------------------------------------------ */
  /* Local form state, hydrated from `theme` on open              */
  /* ------------------------------------------------------------ */
  const [addToTimeline, setAddToTimeline] = useState<boolean>(true);
  const [fieldBinding, setFieldBinding] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newXmlId, setNewXmlId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newMultiple, setNewMultiple] = useState(false);

  useEffect(() => {
    if (theme) {
      setAddToTimeline(theme.addToTimeline);
      setFieldBinding(theme.dealFieldBinding ?? '');
      setError(null);
      setCreateOpen(false);
      setNewXmlId('');
      setNewLabel('');
      setNewMultiple(false);
    }
  }, [theme]);

  /* ------------------------------------------------------------ */
  /* Load deal file fields (same source as SettingsPage)          */
  /* ------------------------------------------------------------ */
  const fieldsQuery = useQuery({
    queryKey: ['settings', 'deal-fields'],
    queryFn: () => settingsApi.dealFields().then((r) => r.fields),
    enabled: open,
  });

  /* ------------------------------------------------------------ */
  /* Save mutation                                                */
  /* ------------------------------------------------------------ */
  const saveMutation = useMutation({
    mutationFn: () => {
      if (!theme) throw new Error('no theme');
      return themesApi.update(theme.id, {
        addToTimeline,
        dealFieldBinding: fieldBinding.trim() === '' ? null : fieldBinding,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['themes'] });
      onClose();
    },
    onError: (err) => setError(toMessage(err)),
  });

  /* ------------------------------------------------------------ */
  /* Create-field sub-flow                                        */
  /* ------------------------------------------------------------ */
  const createFieldMutation = useMutation({
    mutationFn: () =>
      settingsApi.createField({
        xmlId: newXmlId.trim().toUpperCase(),
        label: newLabel.trim(),
        multiple: newMultiple,
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['settings', 'deal-fields'] });
      setFieldBinding(res.field.fieldName);
      setCreateOpen(false);
      setNewXmlId('');
      setNewLabel('');
      setNewMultiple(false);
    },
    onError: (err) => setError(toMessage(err)),
  });

  if (!theme) return null;

  const fields: DealFileFieldDTO[] = fieldsQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Настройки темы «{theme.name}»</DialogTitle>
          <DialogDescription>
            Эти настройки применяются ко всем шаблонам внутри темы при
            генерации документов.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* addToTimeline */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={addToTimeline}
              onChange={(e) => setAddToTimeline(e.target.checked)}
            />
            <div>
              <div className="text-sm font-medium">
                Добавлять комментарий и документ в таймлайн сделки
              </div>
              <div className="text-xs text-muted-foreground">
                После генерации в карточку сделки запишется комментарий
                с прикреплённым .docx-файлом.
              </div>
            </div>
          </label>

          {/* dealFieldBinding */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium">
                Поле сделки для прикрепления документа
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setCreateOpen((v) => !v)}
              >
                <Plus className="mr-1 h-3 w-3" />
                {createOpen ? 'Отмена' : 'Создать поле'}
              </Button>
            </div>

            {fieldsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Загрузка полей…
              </div>
            ) : (
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={fieldBinding}
                onChange={(e) => setFieldBinding(e.target.value)}
              >
                <option value="">— использовать глобальную настройку —</option>
                {fields.map((f) => {
                  const human = f.editFormLabel || f.listLabel;
                  // Avoid showing "UF_CRM_X — UF_CRM_X" when there is
                  // no human label: render only the technical name.
                  const display = human ? `${human} — ${f.fieldName}` : f.fieldName;
                  return (
                    <option key={f.id} value={f.fieldName}>
                      {display}
                      {f.multiple ? ' (множественное)' : ''}
                    </option>
                  );
                })}
              </select>
            )}
            <div className="mt-1 text-xs text-muted-foreground">
              Если поле множественное, новый документ добавляется к уже
              привязанным, не заменяя их.
            </div>
          </div>

          {/* Inline create-field form */}
          {createOpen && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <div className="text-xs font-medium">Создать новое UF_CRM_* поле</div>
              <Input
                placeholder="XML ID (например, GENERATED_DOC)"
                value={newXmlId}
                onChange={(e) => setNewXmlId(e.target.value)}
              />
              <Input
                placeholder="Название поля для интерфейса"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5"
                  checked={newMultiple}
                  onChange={(e) => setNewMultiple(e.target.checked)}
                />
                Множественное (можно прикреплять несколько документов)
              </label>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    createFieldMutation.isPending ||
                    !newXmlId.trim() ||
                    !newLabel.trim()
                  }
                  onClick={() => createFieldMutation.mutate()}
                >
                  {createFieldMutation.isPending ? 'Создание…' : 'Создать поле'}
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button
            type="button"
            onClick={() => {
              setError(null);
              saveMutation.mutate();
            }}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}
