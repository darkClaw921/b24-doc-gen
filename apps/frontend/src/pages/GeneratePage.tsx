/**
 * GeneratePage — deal-scoped preview and document generation.
 *
 * This page is the user-facing entry point loaded inside the
 * `CRM_DEAL_DETAIL_TAB` placement so we can pull the current `dealId`
 * from the Bitrix24 SDK via `getCurrentDealId()`.
 *
 * Layout (three columns at md+):
 *
 *  ┌────────────┬───────────────────────────────┬──────────────┐
 *  │ Themes     │ Preview pane                  │ Action sidebar│
 *  │ (sidebar)  │ (rendered .docx via            │  • Fields     │
 *  │            │  docx-preview, 1:1 with Word)  │  • Generate   │
 *  │ Templates  │                                │  • Result     │
 *  │ (sub-list) │                                │  • Formulas   │
 *  └────────────┴───────────────────────────────┴──────────────┘
 *
 * Data flow:
 *
 *  1. `themesApi.list()` (TanStack Query) populates the left column.
 *     Selecting a theme expands its templates via a second query.
 *  2. Selecting a template (and any change to the manual-field values)
 *     fires `templatesApi.preview(id, dealId, fieldValues, signal)`,
 *     which POSTs to the backend. The response contains the fully
 *     substituted preview `.docx` (base64-encoded in `docxBase64`),
 *     the placeholder `tags`, the per-formula evaluation map and the
 *     template's manual `fields`.
 *  3. The `.docx` is rendered client-side with `docx-preview`
 *     (`renderAsync`) into a dedicated container ref so the preview
 *     visually matches Word. Word styles are rendered into a separate,
 *     hidden style container so they never leak into the app UI.
 *  4. Manual-field edits are debounced (~500 ms) and re-request the
 *     preview with the new `fieldValues`; React Query passes an
 *     `AbortSignal` to the request so superseded fetches are cancelled.
 *  5. The "Сгенерировать документ" button calls
 *     `generateApi.generate({ templateId, dealId, fieldValues })`.
 *
 * When the selected template has no original `.docx` the backend
 * responds with HTTP 400; we surface a friendly message instead of
 * crashing the preview pane.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { renderAsync } from 'docx-preview';
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
  type TemplateFieldDTO,
} from '@/lib/api';
import { getCurrentDealId, reloadParentWindow } from '@/lib/b24';

/* ------------------------------------------------------------------ */
/* Style isolation for the docx-preview output                        */
/* ------------------------------------------------------------------ */

/**
 * docx-preview renders the document's own CSS (page size, fonts,
 * numbering) into a separate "style container". We keep that container
 * hidden so those Word-derived rules — which are scoped by the
 * `className` prefix below — are present for the body container but do
 * not visually bleed into the rest of the app. The body container holds
 * the rendered page(s) and uses the same prefix.
 */
const DOCX_CLASS_NAME = 'gen-docx-preview';

/* ------------------------------------------------------------------ */
/* Debounce                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tiny custom debounce — returns a value that lags `value` by `delay`
 * ms. Used to coalesce rapid manual-field edits into a single preview
 * re-request. Mirrors the helper used on the other pages.
 */
function useDebouncedValue<T>(value: T, delay = 500): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

/* ------------------------------------------------------------------ */
/* base64 → bytes                                                      */
/* ------------------------------------------------------------------ */

/** Decode a base64 string into a `Uint8Array` docx-preview can read. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Manual field helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Convert a raw input value into the string that goes into the
 * document. Date inputs yield ISO `yyyy-mm-dd`; we render them as the
 * Russian `dd.MM.yyyy`. Everything else passes through unchanged.
 */
function formatFieldValue(field: TemplateFieldDTO, raw: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (field.type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  }
  return value;
}

/** Today's date as the `yyyy-mm-dd` string a `<input type="date">` expects. */
function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Initial value for a field — applies its default. Date defaults are
 * tokens (`today` → ISO date for the `<input type="date">`); text /
 * textarea / number defaults are literal values the user can edit.
 */
function initialFieldValue(field: TemplateFieldDTO): string {
  if (field.type === 'date') {
    return field.defaultValue === 'today' ? todayISO() : '';
  }
  return field.defaultValue ?? '';
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function GeneratePage() {
  const dealId = useMemo(() => getCurrentDealId(), []);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [generateResult, setGenerateResult] = useState<GenerateResponseDTO | null>(null);
  /** Raw input values for manual fields, keyed by fieldKey. */
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  /** Container the rendered `.docx` page(s) go into. */
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  /** Hidden container for the document's own (Word) CSS. */
  const previewStyleRef = useRef<HTMLDivElement | null>(null);

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
    setFieldValues({});
  }, [selectedThemeId]);

  // Reset manual-field values whenever the template changes.
  useEffect(() => {
    setFieldValues({});
    setGenerateResult(null);
  }, [selectedTemplateId]);

  /* -------------------------------------------------------------- */
  /* Debounced field values → preview payload                       */
  /* -------------------------------------------------------------- */
  // Debounce the raw field values so rapid typing coalesces into a
  // single preview re-request. The debounced object is what feeds the
  // query key (so the request only re-fires once the user pauses).
  const debouncedFieldValues = useDebouncedValue(fieldValues, 500);

  /* -------------------------------------------------------------- */
  /* Preview of the selected template                               */
  /* -------------------------------------------------------------- */
  // React Query passes an AbortSignal into queryFn; when the query key
  // changes (template switch or debounced field edit) the previous
  // request is aborted automatically, so stale previews never win.
  const {
    data: previewData,
    isFetching: previewLoading,
    isError: previewError,
    error: previewErrorObj,
  } = useQuery<TemplatePreviewResponseDTO>({
    queryKey: ['preview', { templateId: selectedTemplateId, dealId, fieldValues: debouncedFieldValues }],
    queryFn: ({ signal }) =>
      templatesApi.preview(selectedTemplateId!, dealId!, debouncedFieldValues, signal),
    enabled: selectedTemplateId !== null && dealId !== null,
    // The preview .docx can be sizeable; keep the previous frame visible
    // while a debounced re-request is in flight to avoid flicker.
    placeholderData: (prev) => prev,
    retry: false,
  });

  /* -------------------------------------------------------------- */
  /* Render the preview .docx via docx-preview                      */
  /* -------------------------------------------------------------- */
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const body = previewBodyRef.current;
    const styles = previewStyleRef.current;
    if (!body || !styles) return;
    if (!previewData?.docxBase64) {
      body.replaceChildren();
      styles.replaceChildren();
      return;
    }

    // Guard against races: a fast debounced re-render can resolve out of
    // order. Only the latest effect run is allowed to commit its result.
    let cancelled = false;
    setRenderError(null);

    // Clear previous nodes before re-rendering (docx-preview appends).
    body.replaceChildren();
    styles.replaceChildren();

    const bytes = base64ToBytes(previewData.docxBase64);

    void renderAsync(bytes, body, styles, {
      // Keep the document's CSS prefixed and isolated to our containers.
      className: DOCX_CLASS_NAME,
      // Render the wrapper (page chrome) so the preview looks like Word.
      inWrapper: true,
      // Respect the original page width/height for a 1:1 representation.
      ignoreWidth: false,
      ignoreHeight: false,
      // Break across pages on explicit page breaks.
      breakPages: true,
      // Inline images as base64 data URLs so they survive container
      // clears / re-renders without dangling object URLs.
      useBase64URL: true,
      // Render headers/footers/footnotes for fidelity with Word.
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
    })
      .then(() => {
        if (cancelled) {
          // A newer render superseded us — drop whatever we produced.
          body.replaceChildren();
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        body.replaceChildren();
        styles.replaceChildren();
        setRenderError(
          err instanceof Error ? err.message : 'Не удалось отобразить .docx',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [previewData]);

  // Pre-fill fields that declare a default (e.g. date "today") once the
  // template's field list loads. Only fills keys the user hasn't touched.
  useEffect(() => {
    if (!previewData) return;
    setFieldValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const f of previewData.fields) {
        if (next[f.fieldKey] == null || next[f.fieldKey] === '') {
          const init = initialFieldValue(f);
          if (init) {
            next[f.fieldKey] = init;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [previewData]);

  /* -------------------------------------------------------------- */
  /* Generate mutation                                              */
  /* -------------------------------------------------------------- */
  // Build the payload of formatted manual-field values to send.
  const formattedFieldValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of previewData?.fields ?? []) {
      out[f.fieldKey] = formatFieldValue(f, fieldValues[f.fieldKey] ?? '');
    }
    return out;
  }, [previewData, fieldValues]);

  // Required manual fields the user has not filled in yet.
  const missingRequired = useMemo(
    () =>
      (previewData?.fields ?? []).filter(
        (f) => f.required && (fieldValues[f.fieldKey] ?? '').trim() === '',
      ),
    [previewData, fieldValues],
  );

  const generateMutation = useMutation({
    mutationFn: () =>
      generateApi.generate({
        templateId: selectedTemplateId!,
        dealId: dealId!,
        fieldValues: formattedFieldValues,
      }),
    onSuccess: (data) => {
      setGenerateResult(data);
      // Ask Bitrix24 to reload the parent CRM card so the user sees
      // the freshly bound file in the UF_CRM_* field without having
      // to F5 manually. Fire-and-forget.
      void reloadParentWindow();
    },
  });

  const generateError = generateMutation.error;
  const generating = generateMutation.isPending;

  /* -------------------------------------------------------------- */
  /* Friendly preview-error message                                 */
  /* -------------------------------------------------------------- */
  // The backend returns HTTP 400 when the template has no original
  // `.docx` to substitute into. Show an explanatory message instead of
  // the raw error so the user knows the template must be re-uploaded.
  const previewErrorMessage = useMemo(() => {
    if (!previewError) return null;
    if (previewErrorObj instanceof ApiError) {
      if (previewErrorObj.status === 400) {
        return (
          'У этого шаблона нет исходного .docx для предпросмотра. ' +
          'Загрузите .docx-файл шаблона в редакторе и попробуйте снова.'
        );
      }
      return previewErrorObj.message;
    }
    return 'Не удалось загрузить предпросмотр';
  }, [previewError, previewErrorObj]);

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
      {/* Hidden style container for the document's own (Word) CSS. Kept
          out of the visual flow so Word styles do not leak into the UI. */}
      <div ref={previewStyleRef} className="hidden" aria-hidden="true" />

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
          {selectedTemplateId && previewLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Обновляем предпросмотр…
            </div>
          )}
        </header>

        <section className="flex-1 overflow-y-auto bg-muted/10 p-6">
          {!selectedTemplateId && (
            <div className="rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              Слева выберите тему и затем шаблон, чтобы увидеть предпросмотр с
              подставленными значениями.
            </div>
          )}

          {selectedTemplateId && previewLoading && !previewData && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Готовим предпросмотр…
            </div>
          )}

          {selectedTemplateId && previewErrorMessage && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{previewErrorMessage}</span>
            </div>
          )}

          {selectedTemplateId && !previewError && renderError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Ошибка отображения .docx: {renderError}</span>
            </div>
          )}

          {/* The rendered .docx is committed here by docx-preview. We keep
              the container mounted (hidden while empty/erroring) so the ref
              is always available to the render effect. */}
          <div
            className={`mx-auto flex justify-center ${
              selectedTemplateId && previewData && !previewError && !renderError
                ? ''
                : 'hidden'
            }`}
          >
            <div ref={previewBodyRef} className="docx-preview-host" />
          </div>
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
          {previewData && previewData.fields.length > 0 && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50/60 p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase text-amber-800">
                Поля для заполнения
              </h3>
              <div className="space-y-3">
                {previewData.fields.map((field) => (
                  <ManualFieldInput
                    key={field.fieldKey}
                    field={field}
                    value={fieldValues[field.fieldKey] ?? ''}
                    onChange={(v) =>
                      setFieldValues((prev) => ({ ...prev, [field.fieldKey]: v }))
                    }
                  />
                ))}
              </div>
            </div>
          )}

          <Button
            type="button"
            disabled={
              !selectedTemplateId ||
              generating ||
              previewLoading ||
              !!previewError ||
              missingRequired.length > 0
            }
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

          {missingRequired.length > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              Заполните обязательные поля:{' '}
              {missingRequired.map((f) => f.label || f.fieldKey).join(', ')}
            </p>
          )}

          {generateError && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                {generateError instanceof ApiError
                  ? generateError.message
                  : 'Ошибка генерации'}
              </span>
            </div>
          )}

          {generateResult && (
            <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs">
              <div className="mb-2 flex items-center gap-2 font-medium text-emerald-800">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">Документ сгенерирован</span>
              </div>
              <div className="space-y-1 break-words text-emerald-900">
                <div className="break-all">
                  <span className="font-medium">Файл:</span> {generateResult.fileName}
                </div>
                {generateResult.downloadUrl && (
                  <a
                    href={generateResult.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-emerald-700 underline hover:text-emerald-900"
                  >
                    <Download className="h-3 w-3 shrink-0" />
                    Скачать .docx
                  </a>
                )}
                <div className="break-words">
                  <span className="font-medium">Привязка:</span>{' '}
                  {generateResult.binding
                    ? generateResult.binding.ok
                      ? `${generateResult.binding.fieldName} ✓`
                      : `${generateResult.binding.fieldName} ✗ ${generateResult.binding.error ?? ''}`
                    : '— (не настроено)'}
                </div>
                <div className="break-words">
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
                    ) : (f.value?.startsWith('data:image/') || f.value?.startsWith('/api/images/')) ? (
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-muted-foreground">Значение: </span>
                        <img
                          src={f.value}
                          alt={f.label || f.tagKey}
                          className="inline-block rounded border border-border"
                          style={{ maxWidth: 40, maxHeight: 40, objectFit: 'contain' }}
                        />
                      </div>
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

/* ------------------------------------------------------------------ */
/* ManualFieldInput                                                    */
/* ------------------------------------------------------------------ */

/**
 * Single control for a manual field on the generate form. Renders the
 * right input type (textarea / number / date / text), shows the label
 * with a required marker and the placeholder hint.
 */
function ManualFieldInput({
  field,
  value,
  onChange,
}: {
  field: TemplateFieldDTO;
  value: string;
  onChange: (value: string) => void;
}) {
  const baseClass =
    'w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ' +
    'focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-foreground">
        {field.label || field.fieldKey}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {field.type === 'textarea' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || undefined}
          rows={3}
          className={baseClass}
        />
      ) : (
        <input
          type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || undefined}
          className={baseClass}
        />
      )}
    </div>
  );
}
