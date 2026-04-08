/**
 * SettingsPage — admin-only page that manages AppSettings:
 *
 *  - Pick the `UF_CRM_*` file field that `POST /api/generate` writes
 *    into the deal card. The dropdown is populated from
 *    `GET /api/settings/deal-fields` which filters the raw user-field
 *    list down to `USER_TYPE_ID = "file"`.
 *  - Create a brand-new file-typed user field via
 *    `POST /api/settings/create-field` (wraps
 *    `crm.deal.userfield.add`). After creation we refetch the field
 *    list and auto-select the newly created code.
 *  - Edit the list of application admins. Reuses the user-search
 *    pattern from `InstallPage` — debounced input + local selection
 *    map. `PUT /api/settings { adminUserIds }` persists the change.
 *
 * Data flow:
 *   1. `settingsApi.get()` returns the current AppSettings row so we
 *      can highlight the active field and pre-select admins.
 *   2. `settingsApi.dealFields()` returns the file-typed UF_CRM_*
 *      list (cached via TanStack Query).
 *   3. `usersApi.search(debounced)` is used by the admin picker.
 *   4. Mutations: `settingsApi.update`, `settingsApi.createField`.
 *
 * The page does NOT enforce the admin role at render time — that
 * gate is applied server-side and will be extended in Phase 6
 * (bz3.1). Unauthorized mutations simply fail with a 403 message.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
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
import {
  ApiError,
  settingsApi,
  usersApi,
  type DealFileFieldDTO,
  type PortalUserDTO,
  type SettingsDTO,
} from '@/lib/api';

/* ------------------------------------------------------------------ */
/* Small debounce helper (duplicated from InstallPage for isolation)  */
/* ------------------------------------------------------------------ */

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function SettingsPage() {
  const queryClient = useQueryClient();

  /* -------------------------------------------------------------- */
  /* Current settings                                                */
  /* -------------------------------------------------------------- */
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get().then((r) => r.settings),
  });

  /* -------------------------------------------------------------- */
  /* File-typed UF_CRM_* fields                                     */
  /* -------------------------------------------------------------- */
  const fieldsQuery = useQuery({
    queryKey: ['settings', 'deal-fields'],
    queryFn: () => settingsApi.dealFields().then((r) => r.fields),
  });

  /* -------------------------------------------------------------- */
  /* Local form state (mirrors AppSettings)                          */
  /* -------------------------------------------------------------- */
  const [selectedFieldName, setSelectedFieldName] = useState<string>('');
  const [adminMap, setAdminMap] = useState<Map<number, PortalUserDTO>>(new Map());
  const [saveMessage, setSaveMessage] = useState<
    { kind: 'ok' | 'error'; text: string } | null
  >(null);

  // Sync local form state with the settings query result when it
  // first arrives. Subsequent mutations update the form directly.
  useEffect(() => {
    const s: SettingsDTO | undefined = settingsQuery.data;
    if (!s) return;
    setSelectedFieldName(s.dealFieldBinding ?? '');
    // We only have numeric ids from AppSettings — we don't resolve
    // them to full user records here to avoid a second search query.
    // The UI shows "User #<id>" for unknown users and the full name
    // for users returned by the ongoing search box.
    setAdminMap((prev) => {
      const next = new Map<number, PortalUserDTO>();
      for (const id of s.adminUserIds) {
        const existing = prev.get(id);
        if (existing) {
          next.set(id, existing);
        } else {
          next.set(id, {
            id,
            name: `User #${id}`,
            lastName: '',
            fullName: `User #${id}`,
            email: '',
            active: true,
          });
        }
      }
      return next;
    });
  }, [settingsQuery.data]);

  /* -------------------------------------------------------------- */
  /* Admin user search                                               */
  /* -------------------------------------------------------------- */
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);

  const usersQuery = useQuery({
    queryKey: ['users', 'search', debouncedSearch],
    queryFn: () => usersApi.search(debouncedSearch),
    enabled: debouncedSearch.trim().length > 0,
  });

  /* -------------------------------------------------------------- */
  /* Create-field dialog                                             */
  /* -------------------------------------------------------------- */
  const [createOpen, setCreateOpen] = useState(false);
  const [newXmlId, setNewXmlId] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const createFieldMutation = useMutation({
    mutationFn: () =>
      settingsApi.createField({
        xmlId: newXmlId.trim().toUpperCase(),
        label: newLabel.trim(),
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['settings', 'deal-fields'] });
      setSelectedFieldName(res.field.fieldName);
      setCreateOpen(false);
      setNewXmlId('');
      setNewLabel('');
      setSaveMessage({
        kind: 'ok',
        text: `Создано поле ${res.field.fieldName}`,
      });
    },
  });

  /* -------------------------------------------------------------- */
  /* Save mutation (combines dealFieldBinding + adminUserIds)       */
  /* -------------------------------------------------------------- */
  const saveMutation = useMutation({
    mutationFn: () =>
      settingsApi.update({
        dealFieldBinding: selectedFieldName.length > 0 ? selectedFieldName : null,
        adminUserIds: Array.from(adminMap.keys()),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaveMessage({ kind: 'ok', text: 'Настройки сохранены' });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : 'Не удалось сохранить';
      setSaveMessage({ kind: 'error', text: message });
    },
  });

  /* -------------------------------------------------------------- */
  /* Helpers                                                         */
  /* -------------------------------------------------------------- */

  const fields = fieldsQuery.data ?? [];
  const selectedField = useMemo(
    () => fields.find((f) => f.fieldName === selectedFieldName) ?? null,
    [fields, selectedFieldName],
  );

  const toggleAdmin = (user: PortalUserDTO) => {
    setAdminMap((prev) => {
      const next = new Map(prev);
      if (next.has(user.id)) next.delete(user.id);
      else next.set(user.id, user);
      return next;
    });
  };

  const removeAdmin = (id: number) => {
    setAdminMap((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  /* -------------------------------------------------------------- */
  /* Render                                                          */
  /* -------------------------------------------------------------- */

  if (settingsQuery.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (settingsQuery.isError) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertCircle className="mb-2 h-5 w-5" />
          {settingsQuery.error instanceof ApiError
            ? settingsQuery.error.message
            : 'Не удалось загрузить настройки'}
        </div>
      </div>
    );
  }

  const adminList = Array.from(adminMap.values());

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Настройки</h1>
        <p className="text-sm text-muted-foreground">
          Управление привязкой файлов к сделке и списком администраторов.
        </p>
      </header>

      {/* ------------------------------------------------------- */}
      {/* Dealfield binding                                       */}
      {/* ------------------------------------------------------- */}
      <section className="space-y-3 rounded-md border border-border bg-background p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Поле для сгенерированных файлов</h2>
            <p className="text-sm text-muted-foreground">
              Сгенерированный .docx будет прикреплён к выбранному пользовательскому
              полю сделки типа «Файл». Если поле не выбрано, файл всё равно
              попадёт на диск приложения.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1 h-4 w-4" />
            Создать поле
          </Button>
        </div>

        {fieldsQuery.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загружаем список полей…
          </div>
        )}

        {fieldsQuery.isError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {fieldsQuery.error instanceof ApiError
              ? fieldsQuery.error.message
              : 'Не удалось загрузить поля сделки'}
          </div>
        )}

        {!fieldsQuery.isLoading && fields.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            В Bitrix24 нет ни одного UF_CRM_* поля типа «file». Создайте новое
            через кнопку выше.
          </div>
        )}

        {fields.length > 0 && (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="deal-field-select">
              UF_CRM поле
            </label>
            <select
              id="deal-field-select"
              value={selectedFieldName}
              onChange={(e) => setSelectedFieldName(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">— не привязывать —</option>
              {fields.map((f: DealFileFieldDTO) => (
                <option key={f.id} value={f.fieldName}>
                  {f.editFormLabel || f.listLabel || f.fieldName} ({f.fieldName})
                </option>
              ))}
            </select>
            {selectedField && (
              <div className="text-xs text-muted-foreground">
                {selectedField.multiple
                  ? 'Поле хранит несколько файлов'
                  : 'Поле хранит один файл'}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------- */}
      {/* Admin picker                                            */}
      {/* ------------------------------------------------------- */}
      <section className="space-y-3 rounded-md border border-border bg-background p-6 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold">Администраторы приложения</h2>
          <p className="text-sm text-muted-foreground">
            Только эти пользователи Bitrix24 могут создавать/редактировать темы и
            шаблоны.
          </p>
        </div>

        {adminList.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {adminList.map((u) => (
              <li
                key={u.id}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span>
                    {u.fullName}{' '}
                    <span className="text-xs text-muted-foreground">#{u.id}</span>
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeAdmin(u.id)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {adminList.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            Администраторов нет — приложение будет недоступно для управления.
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs font-medium" htmlFor="admin-search">
            Добавить администратора
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="admin-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Имя или фамилия…"
              className="pl-9"
            />
          </div>

          {debouncedSearch.trim().length > 0 && (
            <div className="mt-2 rounded-md border border-border bg-muted/30">
              {usersQuery.isLoading && (
                <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Ищем…
                </div>
              )}
              {usersQuery.data?.users && usersQuery.data.users.length === 0 && (
                <div className="p-2 text-xs text-muted-foreground">Ничего не найдено.</div>
              )}
              {usersQuery.data?.users?.map((u) => {
                const checked = adminMap.has(u.id);
                return (
                  <label
                    key={u.id}
                    className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0 hover:bg-muted/60"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAdmin(u)}
                    />
                    <span>
                      {u.fullName}{' '}
                      <span className="text-xs text-muted-foreground">#{u.id}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------- */}
      {/* Save bar                                                */}
      {/* ------------------------------------------------------- */}
      <div className="flex items-center justify-between">
        {saveMessage ? (
          <div
            className={`flex items-center gap-2 text-sm ${
              saveMessage.kind === 'ok' ? 'text-emerald-600' : 'text-destructive'
            }`}
          >
            {saveMessage.kind === 'ok' ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
            {saveMessage.text}
          </div>
        ) : (
          <div />
        )}
        <Button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || adminList.length === 0}
        >
          {saveMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Сохраняем…
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Сохранить
            </>
          )}
        </Button>
      </div>

      {/* ------------------------------------------------------- */}
      {/* Create-field dialog                                     */}
      {/* ------------------------------------------------------- */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Создать UF_CRM_* поле</DialogTitle>
            <DialogDescription>
              Поле будет создано в Bitrix24 через crm.deal.userfield.add с типом
              «file». XML ID — идентификатор внутри Bitrix24 (A-Z, 0-9, _).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="new-xml-id">
                XML ID
              </label>
              <Input
                id="new-xml-id"
                value={newXmlId}
                onChange={(e) =>
                  setNewXmlId(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
                }
                placeholder="DOC_FILES"
              />
              {newXmlId && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Результат: <span className="font-mono">UF_CRM_{newXmlId}</span>
                </div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="new-label">
                Название (label)
              </label>
              <Input
                id="new-label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Сгенерированные документы"
              />
            </div>

            {createFieldMutation.error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {createFieldMutation.error instanceof ApiError
                  ? createFieldMutation.error.message
                  : 'Не удалось создать поле'}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={createFieldMutation.isPending}
            >
              Отмена
            </Button>
            <Button
              type="button"
              onClick={() => createFieldMutation.mutate()}
              disabled={
                createFieldMutation.isPending || !newXmlId.trim() || !newLabel.trim()
              }
            >
              {createFieldMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Создаём…
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  Создать
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
