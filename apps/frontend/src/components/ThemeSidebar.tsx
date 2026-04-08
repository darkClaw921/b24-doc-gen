/**
 * ThemeSidebar — left-hand panel listing template themes.
 *
 * Owns:
 *  - Fetching themes via TanStack Query (`['themes']`).
 *  - Inline create / rename / delete via shadcn DropdownMenu and a
 *    small modal Dialog for the create+rename forms.
 *  - Selection state — the selected theme id is *controlled* by the
 *    parent so the templates list can react.
 *
 * Server contract:
 *  - GET    /api/themes      → `{ themes: ThemeDTO[] }`
 *  - POST   /api/themes      → create
 *  - PUT    /api/themes/:id  → rename / reorder
 *  - DELETE /api/themes/:id  → delete (returns 409 if templates exist)
 *
 * On a 409 from delete we surface the backend error message inline so
 * the admin understands why deletion is blocked. The toast plumbing in
 * shadcn/ui exists in the project but is not yet wired to a provider,
 * so we use an in-component banner here. A future PR can swap to a
 * global toast.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, FolderOpen, AlertCircle, Loader2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { ApiError, themesApi, type ThemeDTO } from '@/lib/api';
import { useCurrentRole } from '@/lib/useCurrentRole';
import { cn } from '@/lib/utils';
import { ThemeSettingsDialog } from './ThemeSettingsDialog';

export interface ThemeSidebarProps {
  /** Currently selected theme id. May be null on first render. */
  selectedThemeId: string | null;
  /** Called whenever the user picks a different theme. */
  onSelect: (themeId: string | null) => void;
  /** Optional class for the wrapper. */
  className?: string;
}

interface DialogState {
  mode: 'create' | 'rename';
  theme?: ThemeDTO;
}

export function ThemeSidebar({
  selectedThemeId,
  onSelect,
  className,
}: ThemeSidebarProps) {
  const queryClient = useQueryClient();
  const { isAdmin } = useCurrentRole();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [settingsTheme, setSettingsTheme] = useState<ThemeDTO | null>(null);

  const {
    data,
    isLoading,
    isError,
    error: queryError,
  } = useQuery({
    queryKey: ['themes'],
    queryFn: () => themesApi.list().then((r) => r.themes),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['themes'] });

  const createMutation = useMutation({
    mutationFn: (n: string) => themesApi.create({ name: n }),
    onSuccess: ({ theme }) => {
      invalidate();
      onSelect(theme.id);
      closeDialog();
    },
    onError: (err) => setError(toMessage(err)),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, n }: { id: string; n: string }) =>
      themesApi.update(id, { name: n }),
    onSuccess: () => {
      invalidate();
      closeDialog();
    },
    onError: (err) => setError(toMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => themesApi.delete(id),
    onSuccess: (_void, id) => {
      invalidate();
      if (selectedThemeId === id) onSelect(null);
    },
    onError: (err) => setError(toMessage(err)),
  });

  const openCreate = () => {
    setName('');
    setError(null);
    setDialog({ mode: 'create' });
  };

  const openRename = (theme: ThemeDTO) => {
    setName(theme.name);
    setError(null);
    setDialog({ mode: 'rename', theme });
  };

  const closeDialog = () => {
    setDialog(null);
    setName('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Имя темы обязательно');
      return;
    }
    if (dialog?.mode === 'create') {
      createMutation.mutate(trimmed);
    } else if (dialog?.mode === 'rename' && dialog.theme) {
      renameMutation.mutate({ id: dialog.theme.id, n: trimmed });
    }
  };

  const handleDelete = (theme: ThemeDTO) => {
    if (!window.confirm(`Удалить тему «${theme.name}»?`)) return;
    setError(null);
    deleteMutation.mutate(theme.id);
  };

  const themes = data ?? [];

  return (
    <aside
      className={cn(
        'flex h-full w-64 shrink-0 flex-col border-r border-border bg-muted/30',
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="text-sm font-semibold">Темы</div>
        {isAdmin && (
          <Button
            size="sm"
            variant="ghost"
            onClick={openCreate}
            aria-label="Новая тема"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        )}
        {isError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{toMessage(queryError)}</span>
          </div>
        )}
        {!isLoading && !isError && themes.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            Пока нет тем. Нажмите «+», чтобы создать первую.
          </div>
        )}
        <ul className="space-y-1">
          {themes.map((theme) => {
            const isActive = theme.id === selectedThemeId;
            return (
              <li key={theme.id}>
                <div
                  className={cn(
                    'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                    isActive
                      ? 'bg-primary/10 text-foreground'
                      : 'hover:bg-muted text-muted-foreground hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    className="flex flex-1 items-center gap-2 text-left"
                    onClick={() => onSelect(theme.id)}
                  >
                    <FolderOpen className="h-4 w-4 shrink-0" />
                    <span className="truncate">{theme.name}</span>
                    {theme.templatesCount !== undefined && (
                      <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {theme.templatesCount}
                      </span>
                    )}
                  </button>
                  {isAdmin && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="rounded p-1 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100 focus:opacity-100"
                          aria-label="Действия"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setSettingsTheme(theme)}>
                          Настройки темы
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openRename(theme)}>
                          Переименовать
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => handleDelete(theme)}
                        >
                          Удалить
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {error && !dialog && (
        <div className="m-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <ThemeSettingsDialog
        theme={settingsTheme}
        onClose={() => setSettingsTheme(null)}
      />

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>
                {dialog?.mode === 'create' ? 'Новая тема' : 'Переименовать тему'}
              </DialogTitle>
              <DialogDescription>
                Тема — это группа шаблонов (например, «Договоры», «Счета»).
              </DialogDescription>
            </DialogHeader>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Название темы"
              autoFocus
            />
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog}>
                Отмена
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending || renameMutation.isPending}
              >
                {createMutation.isPending || renameMutation.isPending
                  ? 'Сохранение…'
                  : dialog?.mode === 'create'
                    ? 'Создать'
                    : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function toMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}
