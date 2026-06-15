/**
 * FieldPresetsSettings — settings section for managing reusable `select`
 * field presets (the option lists + value mapping that admins reuse
 * across templates instead of re-typing them every time).
 *
 * Self-contained: owns its own TanStack Query + mutations against
 * `fieldPresetsApi` and an add/edit dialog built on the shared
 * {@link SelectOptionsEditor}. Rendered as one `<section>` inside
 * {@link SettingsPage}.
 *
 * Flow:
 *  - List existing presets (name, mode, option count) with edit/delete.
 *  - "Создать список" opens the dialog with an empty form; clicking a
 *    preset's edit button opens it seeded with that preset.
 *  - Saving calls `create`/`update`; deleting calls `delete`. All
 *    mutations invalidate the `['field-presets']` query so the
 *    ManualFieldBuilder picker and this list stay in sync.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SelectOptionsEditor } from '@/components/SelectOptionsEditor';
import {
  ApiError,
  fieldPresetsApi,
  type FieldPresetDTO,
  type SelectOptionDTO,
  type SelectValueModeDTO,
} from '@/lib/api';

export function FieldPresetsSettings() {
  const queryClient = useQueryClient();

  const presetsQuery = useQuery({
    queryKey: ['field-presets'],
    queryFn: () => fieldPresetsApi.list(),
  });
  const presets = presetsQuery.data?.presets ?? [];

  /* ---------------------------- dialog ---------------------------- */
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FieldPresetDTO | null>(null);
  const [name, setName] = useState('');
  const [valueMode, setValueMode] = useState<SelectValueModeDTO>('direct');
  const [options, setOptions] = useState<SelectOptionDTO[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the dialog form whenever it opens.
  useEffect(() => {
    if (!dialogOpen) return;
    setName(editing?.name ?? '');
    setValueMode(editing?.valueMode ?? 'direct');
    setOptions(editing?.options.map((o) => ({ ...o })) ?? [{ label: '', value: '' }]);
    setError(null);
  }, [dialogOpen, editing]);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (preset: FieldPresetDTO) => {
    setEditing(preset);
    setDialogOpen(true);
  };

  /* -------------------------- mutations --------------------------- */
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['field-presets'] });

  const saveMutation = useMutation({
    mutationFn: (body: {
      name: string;
      valueMode: SelectValueModeDTO;
      options: SelectOptionDTO[];
    }) =>
      editing
        ? fieldPresetsApi.update(editing.id, body)
        : fieldPresetsApi.create(body),
    onSuccess: async () => {
      await invalidate();
      setDialogOpen(false);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить список');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fieldPresetsApi.delete(id),
    onSuccess: () => invalidate(),
  });

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Введите название списка');
      return;
    }
    const cleanOptions = options
      .map((o) => ({ label: o.label.trim(), value: o.value.trim() }))
      .filter((o) => o.label.length > 0);
    if (cleanOptions.length === 0) {
      setError('Добавьте хотя бы один вариант');
      return;
    }
    setError(null);
    saveMutation.mutate({ name: trimmedName, valueMode, options: cleanOptions });
  };

  return (
    <section className="space-y-3 rounded-md border border-border bg-background p-6 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">Списочные поля (готовые списки)</h2>
          <p className="text-sm text-muted-foreground">
            Создайте список вариантов с маппингом значений один раз — и выбирайте
            его при вставке поля «Выпадающий список» в шаблоне, не вводя варианты
            заново.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" />
          Создать список
        </Button>
      </div>

      {presetsQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загружаем списки…
        </div>
      )}

      {presetsQuery.isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {presetsQuery.error instanceof ApiError
            ? presetsQuery.error.message
            : 'Не удалось загрузить списки'}
        </div>
      )}

      {!presetsQuery.isLoading && presets.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          Пока нет ни одного списка. Создайте первый через кнопку выше.
        </div>
      )}

      {presets.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {presets.map((preset) => (
            <li key={preset.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{preset.name}</div>
                <div className="text-xs text-muted-foreground">
                  {preset.options.length} вар.{' '}
                  {preset.valueMode === 'mapped' ? '· с маппингом' : '· без маппинга'}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Изменить список"
                  onClick={() => openEdit(preset)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  aria-label="Удалить список"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (window.confirm(`Удалить список «${preset.name}»?`)) {
                      deleteMutation.mutate(preset.id);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {deleteMutation.isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {deleteMutation.error instanceof ApiError
            ? deleteMutation.error.message
            : 'Не удалось удалить список'}
        </div>
      )}

      {/* ---------------------------- dialog ---------------------------- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-md flex-col">
          <DialogHeader>
            <DialogTitle>{editing ? 'Изменить список' : 'Новый список'}</DialogTitle>
            <DialogDescription>
              Список вариантов с маппингом значений для полей «Выпадающий список».
            </DialogDescription>
          </DialogHeader>

          <div className="-mr-2 min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Название списка</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например: Страховые компании"
                autoFocus
              />
            </div>

            <SelectOptionsEditor
              valueMode={valueMode}
              onValueModeChange={setValueMode}
              options={options}
              onOptionsChange={setOptions}
            />

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Отмена
            </Button>
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {editing ? 'Сохранить' : 'Создать'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default FieldPresetsSettings;
