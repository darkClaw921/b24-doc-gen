/**
 * TemplatesPage — admin landing page for template management.
 *
 * Layout:
 *  - `<ThemeSidebar>` on the left (selectable theme list).
 *  - On the right: a header with the selected theme name, a search
 *    input that filters templates by name, an "Загрузить новый
 *    шаблон" button that opens a Dialog containing the
 *    `<TemplateUploader>`, and a list of templates that match the
 *    current filters.
 *
 * Data flow:
 *  - Selected theme id lives in component state. Whenever it changes
 *    or the user types in the search box we re-query
 *    `templatesApi.list({themeId, search})` via TanStack Query.
 *  - Search input is debounced 250 ms client-side to keep the API
 *    calls reasonable.
 *  - On successful upload we navigate to `/templates/:id/edit`.
 *
 * The page does NOT enforce admin role; that gate is added in
 * Phase 6 (bz3.1).
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  Upload,
  FileText,
  Loader2,
  AlertCircle,
  Pencil,
  Settings as SettingsIcon,
  Webhook,
} from 'lucide-react';
import { ThemeSidebar } from '@/components/ThemeSidebar';
import { TemplateUploader } from '@/components/TemplateUploader';
import { AdminOnly } from '@/components/AdminOnly';
import { WebhookManagerDialog } from '@/components/WebhookManagerDialog';
import { useCurrentRole } from '@/lib/useCurrentRole';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ApiError, templatesApi, type TemplateListItemDTO } from '@/lib/api';

/**
 * Tiny custom debounce — we deliberately avoid pulling in `lodash` /
 * `use-debounce` for one input. The hook returns a value that lags
 * `value` by `delay` ms.
 */
function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

export function TemplatesPage() {
  const navigate = useNavigate();
  const { isAdmin } = useCurrentRole();
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [webhookTarget, setWebhookTarget] = useState<
    { id: string; name: string } | null
  >(null);

  const search = useDebouncedValue(searchInput, 250);

  const queryEnabled = selectedThemeId !== null;
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['templates', { themeId: selectedThemeId, search }],
    queryFn: () =>
      templatesApi
        .list({
          themeId: selectedThemeId ?? undefined,
          search: search.trim() || undefined,
        })
        .then((r) => r.templates),
    enabled: queryEnabled,
  });

  const templates: TemplateListItemDTO[] = useMemo(() => data ?? [], [data]);

  const handleUploaded = (templateId: string) => {
    setUploadOpen(false);
    void refetch();
    navigate(`/templates/${templateId}/edit`);
  };

  return (
    <div className="flex h-screen w-full">
      <ThemeSidebar
        selectedThemeId={selectedThemeId}
        onSelect={setSelectedThemeId}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold">Шаблоны документов</h1>
            <p className="text-sm text-muted-foreground">
              {selectedThemeId
                ? 'Шаблоны выбранной темы'
                : 'Выберите тему слева, чтобы увидеть шаблоны'}
            </p>
          </div>
          <AdminOnly>
            <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate('/settings')}
              title="Открыть настройки приложения"
            >
              <SettingsIcon className="mr-2 h-4 w-4" />
              Настройки
            </Button>
            <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
              <DialogTrigger asChild>
                <Button disabled={!selectedThemeId}>
                  <Upload className="mr-2 h-4 w-4" />
                  Загрузить шаблон
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Загрузить новый шаблон</DialogTitle>
                  <DialogDescription>
                    Выберите .docx-файл — он будет распарсен в HTML и привязан к
                    выбранной теме.
                  </DialogDescription>
                </DialogHeader>
                {selectedThemeId && (
                  <TemplateUploader
                    themeId={selectedThemeId}
                    onSuccess={(template) => handleUploaded(template.id)}
                  />
                )}
              </DialogContent>
            </Dialog>
            </div>
          </AdminOnly>
        </header>

        <div className="border-b border-border px-6 py-3">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Поиск по имени шаблона…"
              className="pl-9"
              disabled={!selectedThemeId}
            />
          </div>
        </div>

        <section className="flex-1 overflow-y-auto p-6">
          {!selectedThemeId && (
            <div className="rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              Слева в сайдбаре выберите тему или создайте новую, чтобы
              управлять шаблонами.
            </div>
          )}

          {selectedThemeId && isLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загружаем шаблоны…
            </div>
          )}

          {selectedThemeId && isError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {error instanceof ApiError ? error.message : 'Ошибка загрузки'}
              </span>
            </div>
          )}

          {selectedThemeId && !isLoading && !isError && templates.length === 0 && (
            <div className="rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              {search.trim()
                ? 'Шаблонов с таким именем нет.'
                : 'В этой теме пока нет шаблонов. Загрузите первый.'}
            </div>
          )}

          {selectedThemeId && templates.length > 0 && (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {templates.map((tpl) => (
                <li
                  key={tpl.id}
                  className="flex flex-col rounded-lg border border-border bg-background p-4 shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="mb-2 flex items-start gap-2">
                    <FileText className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium" title={tpl.name}>
                        {tpl.name}
                      </div>
                      {tpl.themeName && (
                        <div className="truncate text-xs text-muted-foreground">
                          {tpl.themeName}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-auto flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Формул: {tpl.formulasCount}
                      {tpl.hasOriginalDocx && ' · .docx'}
                    </span>
                    {isAdmin && (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setWebhookTarget({ id: tpl.id, name: tpl.name })
                          }
                          title="Webhook шаблона"
                        >
                          <Webhook className="mr-1 h-3.5 w-3.5" />
                          Webhook
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/templates/${tpl.id}/edit`)}
                        >
                          <Pencil className="mr-1 h-3.5 w-3.5" />
                          Открыть
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <WebhookManagerDialog
        scope="template"
        targetId={webhookTarget?.id ?? null}
        targetName={webhookTarget?.name ?? null}
        onClose={() => setWebhookTarget(null)}
      />
    </div>
  );
}
