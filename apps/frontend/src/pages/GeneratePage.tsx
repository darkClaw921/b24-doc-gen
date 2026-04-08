/**
 * GeneratePage — deal-scoped preview and document generation.
 *
 * This page is the user-facing entry point on Phase 5. It is loaded
 * inside the `CRM_DEAL_DETAIL_TAB` placement so we can pull the
 * current `dealId` from the Bitrix24 SDK via `getCurrentDealId()`.
 *
 * Layout (three columns at md+):
 *
 *  ┌────────────┬───────────────────────────────┬──────────────┐
 *  │ Themes     │ Preview pane                  │ Action sidebar│
 *  │ (sidebar)  │ (HTML rendered with computed  │  • Generate   │
 *  │            │  formula values + tooltips)   │  • Result     │
 *  │ Templates  │                                │  • Warnings   │
 *  │ (sub-list) │                                │               │
 *  └────────────┴───────────────────────────────┴──────────────┘
 *
 * Data flow:
 *
 *  1. `themesApi.list()` (TanStack Query) — populates the left
 *     column. Selecting a theme expands its templates via a second
 *     query against `templatesApi.list({ themeId })`.
 *  2. Selecting a template fires `templatesApi.preview(id, dealId)`
 *     which calls our new backend endpoint. The response includes
 *     the rewritten HTML (formula spans now carry
 *     `data-computed-value`) and a per-formula evaluation map.
 *  3. The HTML is rendered with `dangerouslySetInnerHTML`. The
 *     formula spans are styled via a small CSS injection that turns
 *     them into yellow pills with a `cursor: help`. Hovering shows
 *     the formula expression and the computed value via the native
 *     `title` attribute (we set it on the spans inside a layout
 *     effect after each render).
 *  4. The "Сгенерировать документ" button calls
 *     `generateApi.generate({ templateId, dealId })`. The response
 *     contains the file id, download URL, binding/timeline status
 *     and a `warnings[]` array. We show a sticky toast-like alert
 *     with the link.
 *
 * The page degrades gracefully when no `dealId` is available
 * (the `?view=generate` query path may be reached outside of the
 * deal placement during testing): it shows a friendly stub
 * instead of trying to call preview/generate with a missing id.
 *
 * No sanitization library is used because the HTML is produced by
 * our own backend route from a TipTap-controlled editor and then
 * server-side substituted with escaped values. Adding DOMPurify is a
 * reasonable hardening step but would require a new dependency; the
 * Phase 6 hardening epic (bz3.2) will revisit this.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Download,
  Sparkles,
  Folder,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ApiError,
  themesApi,
  templatesApi,
  generateApi,
  type ThemeDTO,
  type TemplateListItemDTO,
  type GenerateResponseDTO,
  type TemplatePreviewResponseDTO,
} from '@/lib/api';
import { getCurrentDealId, reloadParentWindow } from '@/lib/b24';

/* ------------------------------------------------------------------ */
/* Inline styling for formula tags inside the preview                 */
/* ------------------------------------------------------------------ */

/**
 * Single CSS block injected once per page mount. Targets every
 * `<span data-formula-key>` produced by the backend preview endpoint.
 * The selector relies on the `data-computed-value` attribute that the
 * backend now emits, so admin-mode pills (which lack the attribute)
 * are not affected.
 */
const PREVIEW_STYLES = `
  .gen-preview-html span[data-formula-key] {
    background: #fef9c3;
    border-radius: 0.25rem;
    padding: 0 0.25rem;
    cursor: help;
    box-shadow: inset 0 0 0 1px rgba(202, 138, 4, 0.4);
    color: #713f12;
  }
  .gen-preview-html span[data-formula-key][data-formula-error] {
    background: #fee2e2;
    color: #7f1d1d;
    box-shadow: inset 0 0 0 1px rgba(220, 38, 38, 0.5);
  }
  .gen-preview-html h1 { font-size: 1.5rem; font-weight: 600; margin: 1rem 0; }
  .gen-preview-html h2 { font-size: 1.25rem; font-weight: 600; margin: 0.75rem 0; }
  .gen-preview-html h3 { font-size: 1.125rem; font-weight: 600; margin: 0.5rem 0; }
  .gen-preview-html p { margin: 0.5rem 0; line-height: 1.6; }
  .gen-preview-html ul, .gen-preview-html ol { margin: 0.5rem 0 0.5rem 1.5rem; }
  .gen-preview-html table { border-collapse: collapse; margin: 0.5rem 0; }
  .gen-preview-html th, .gen-preview-html td { border: 1px solid #e2e8f0; padding: 0.25rem 0.5rem; }
`;

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function GeneratePage() {
  const dealId = useMemo(() => getCurrentDealId(), []);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [generateResult, setGenerateResult] = useState<GenerateResponseDTO | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  /* -------------------------------------------------------------- */
  /* Themes list                                                    */
  /* -------------------------------------------------------------- */
  const {
    data: themesData,
    isLoading: themesLoading,
    isError: themesError,
    error: themesErrorObj,
  } = useQuery({
    queryKey: ['themes'],
    queryFn: () => themesApi.list().then((r) => r.themes),
  });

  // Auto-select the first theme on first load.
  useEffect(() => {
    if (!selectedThemeId && themesData && themesData.length > 0) {
      setSelectedThemeId(themesData[0].id);
    }
  }, [themesData, selectedThemeId]);

  /* -------------------------------------------------------------- */
  /* Templates of the selected theme                                */
  /* -------------------------------------------------------------- */
  const {
    data: templatesData,
    isLoading: templatesLoading,
    isError: templatesError,
  } = useQuery({
    queryKey: ['templates', { themeId: selectedThemeId }],
    queryFn: () =>
      templatesApi
        .list({ themeId: selectedThemeId ?? undefined })
        .then((r) => r.templates),
    enabled: selectedThemeId !== null,
  });

  // Reset the selected template whenever the theme changes.
  useEffect(() => {
    setSelectedTemplateId(null);
    setGenerateResult(null);
  }, [selectedThemeId]);

  /* -------------------------------------------------------------- */
  /* Preview of the selected template                               */
  /* -------------------------------------------------------------- */
  const {
    data: previewData,
    isLoading: previewLoading,
    isError: previewError,
    error: previewErrorObj,
  } = useQuery<TemplatePreviewResponseDTO>({
    queryKey: ['preview', { templateId: selectedTemplateId, dealId }],
    queryFn: () => templatesApi.preview(selectedTemplateId!, dealId!),
    enabled: selectedTemplateId !== null && dealId !== null,
  });

  // After each render of the preview HTML, walk the spans and set
  // a friendly `title` attribute carrying expression + value.
  useEffect(() => {
    const root = previewRef.current;
    if (!root || !previewData) return;
    const spans = root.querySelectorAll<HTMLSpanElement>('span[data-formula-key]');
    spans.forEach((span) => {
      const key = span.getAttribute('data-formula-key') ?? '';
      const meta = previewData.formulas[key];
      if (!meta) return;
      const titleParts = [
        `${meta.label || key}`,
        `Формула: ${meta.expression}`,
        meta.error
          ? `Ошибка: ${meta.error}`
          : `Значение: ${meta.value || '∅'}`,
      ];
      span.setAttribute('title', titleParts.join('\n'));
    });
  }, [previewData]);

  /* -------------------------------------------------------------- */
  /* Generate mutation                                              */
  /* -------------------------------------------------------------- */
  const generateMutation = useMutation({
    mutationFn: () =>
      generateApi.generate({ templateId: selectedTemplateId!, dealId: dealId! }),
    onSuccess: (data) => {
      setGenerateResult(data);
      // Ask Bitrix24 to reload the parent CRM card so the user sees
      // the freshly bound file in the UF_CRM_* field without having
      // to F5 manually. Fire-and-forget — the result panel stays
      // visible because Bitrix re-mounts the iframe with the same URL.
      void reloadParentWindow();
    },
  });

  const generateError = generateMutation.error;
  const generating = generateMutation.isPending;

  /* -------------------------------------------------------------- */
  /* No-deal stub                                                   */
  /* -------------------------------------------------------------- */
  if (dealId === null) {
    return (
      <div className="flex h-screen items-center justify-center p-10">
        <div className="max-w-md rounded-md border border-dashed border-border p-6 text-center">
          <Sparkles className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Откройте страницу из карточки сделки</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Эта страница работает только во вкладке «Документы» сделки Bitrix24.
            ID сделки не передан в плейсменте.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full">
      <style>{PREVIEW_STYLES}</style>

      {/* ------------------------------------------------------- */}
      {/* Left column — themes + templates                        */}
      {/* ------------------------------------------------------- */}
      <aside className="flex w-72 flex-col border-r border-border bg-muted/30">
        <div className="border-b border-border p-4">
          <h2 className="text-sm font-semibold text-muted-foreground">Темы</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {themesLoading && (
            <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загружаем темы…
            </div>
          )}
          {themesError && (
            <div className="m-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {themesErrorObj instanceof ApiError
                ? themesErrorObj.message
                : 'Не удалось загрузить темы'}
            </div>
          )}
          {themesData?.map((theme: ThemeDTO) => {
            const isSelected = theme.id === selectedThemeId;
            return (
              <div key={theme.id} className="mb-1">
                <button
                  type="button"
                  onClick={() => setSelectedThemeId(theme.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                    isSelected
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted'
                  }`}
                >
                  <Folder className="h-4 w-4 shrink-0" />
                  <span className="truncate">{theme.name}</span>
                </button>

                {isSelected && (
                  <div className="ml-2 mt-1 border-l border-border pl-3">
                    {templatesLoading && (
                      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Шаблоны…
                      </div>
                    )}
                    {templatesError && (
                      <div className="py-1 text-xs text-destructive">
                        Ошибка загрузки шаблонов
                      </div>
                    )}
                    {!templatesLoading &&
                      !templatesError &&
                      templatesData &&
                      templatesData.length === 0 && (
                        <div className="py-1 text-xs text-muted-foreground">
                          Нет шаблонов
                        </div>
                      )}
                    {templatesData?.map((tpl: TemplateListItemDTO) => (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => setSelectedTemplateId(tpl.id)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors ${
                          tpl.id === selectedTemplateId
                            ? 'bg-secondary text-secondary-foreground'
                            : 'hover:bg-muted'
                        }`}
                      >
                        <FileText className="h-3 w-3 shrink-0" />
                        <span className="truncate" title={tpl.name}>
                          {tpl.name}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* ------------------------------------------------------- */}
      {/* Center column — preview                                 */}
      {/* ------------------------------------------------------- */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold">Генерация документа</h1>
            <p className="text-sm text-muted-foreground">
              Сделка #{dealId} · выберите шаблон слева
            </p>
          </div>
        </header>

        <section className="flex-1 overflow-y-auto bg-muted/10 p-6">
          {!selectedTemplateId && (
            <div className="rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              Слева выберите тему и затем шаблон, чтобы увидеть предпросмотр с
              подставленными значениями.
            </div>
          )}

          {selectedTemplateId && previewLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Готовим предпросмотр…
            </div>
          )}

          {selectedTemplateId && previewError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {previewErrorObj instanceof ApiError
                  ? previewErrorObj.message
                  : 'Не удалось загрузить предпросмотр'}
              </span>
            </div>
          )}

          {selectedTemplateId && previewData && (
            <div
              ref={previewRef}
              className="gen-preview-html mx-auto max-w-3xl rounded-md border border-border bg-background p-8 shadow-sm"
              // The HTML is server-rendered + escaped in our backend
              // route, so direct injection here is safe enough for the
              // Phase 5 milestone. Phase 6 (bz3.2) revisits hardening.
              dangerouslySetInnerHTML={{ __html: previewData.html }}
            />
          )}
        </section>
      </main>

      {/* ------------------------------------------------------- */}
      {/* Right column — actions and result                      */}
      {/* ------------------------------------------------------- */}
      <aside className="flex w-80 flex-col border-l border-border bg-muted/30">
        <div className="border-b border-border p-4">
          <h2 className="text-sm font-semibold text-muted-foreground">Действия</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <Button
            type="button"
            disabled={!selectedTemplateId || generating || previewLoading}
            onClick={() => generateMutation.mutate()}
            className="w-full"
          >
            {generating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Генерируем…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Сгенерировать документ
              </>
            )}
          </Button>

          {generateError && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {generateError instanceof ApiError
                  ? generateError.message
                  : 'Ошибка генерации'}
              </span>
            </div>
          )}

          {generateResult && (
            <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs">
              <div className="mb-2 flex items-center gap-2 font-medium text-emerald-800">
                <CheckCircle2 className="h-4 w-4" />
                Документ сгенерирован
              </div>
              <div className="space-y-1 text-emerald-900">
                <div>
                  <span className="font-medium">Файл:</span> {generateResult.fileName}
                </div>
                {generateResult.downloadUrl && (
                  <a
                    href={generateResult.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-emerald-700 underline hover:text-emerald-900"
                  >
                    <Download className="h-3 w-3" />
                    Скачать .docx
                  </a>
                )}
                <div>
                  <span className="font-medium">Привязка:</span>{' '}
                  {generateResult.binding
                    ? generateResult.binding.ok
                      ? `${generateResult.binding.fieldName} ✓`
                      : `${generateResult.binding.fieldName} ✗ ${generateResult.binding.error ?? ''}`
                    : '— (не настроено)'}
                </div>
                <div>
                  <span className="font-medium">Таймлайн:</span>{' '}
                  {generateResult.timeline.ok
                    ? `комментарий ${generateResult.timeline.commentId ?? ''}`
                    : `ошибка: ${generateResult.timeline.error ?? '—'}`}
                </div>
                {generateResult.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-4 text-amber-800">
                    {generateResult.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {previewData && (
            <div className="mt-6">
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                Формулы шаблона
              </h3>
              <ul className="space-y-2">
                {Object.values(previewData.formulas).map((f) => (
                  <li
                    key={f.tagKey}
                    className="rounded-md border border-border bg-background p-2 text-xs"
                  >
                    <div className="font-medium">{f.label || f.tagKey}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {f.expression}
                    </div>
                    {f.error ? (
                      <div className="mt-1 text-destructive">Ошибка: {f.error}</div>
                    ) : (
                      <div className="mt-1">
                        <span className="text-muted-foreground">Значение: </span>
                        <span className="font-medium">{f.value || '∅'}</span>
                      </div>
                    )}
                  </li>
                ))}
                {Object.keys(previewData.formulas).length === 0 && (
                  <li className="text-xs text-muted-foreground">
                    В шаблоне нет формул.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
