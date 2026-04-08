/**
 * TemplateEditorPage — admin WYSIWYG editor for a single template.
 *
 * Route: `/templates/:id/edit`
 *
 * Behaviour:
 *  1. Reads `:id` from the URL and fetches the full template via
 *     `templatesApi.get(id)` (TanStack Query).
 *  2. Mounts `<TiptapEditor>` + `<Toolbar>` and seeds them with
 *     `template.contentHtml`.
 *  3. Tracks dirty state. The Save button submits a PUT with the
 *     latest HTML, name, themeId and the formulas array extracted
 *     from the editor state by walking the ProseMirror doc and
 *     collecting every `formulaTag` node.
 *  4. Renders a small toolbar with the template name (editable) and
 *     a theme picker (controlled by another query for `['themes']`).
 *  5. Wires the FormulaBuilder dialog: the "Σ" toolbar button opens
 *     it, submissions call `editor.chain().focus().insertFormulaTag`
 *     and merge the new formula into the local formulas metadata
 *     map. Tag keys already used in the editor are forwarded to the
 *     builder so uniqueness is preserved.
 *  6. Surfaces save errors as inline banners. The page does not yet
 *     auto-save — admins click Save explicitly.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Save,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { TiptapEditor, Toolbar } from '@/components/Editor';
import type { Editor as TiptapEditorInstance } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  FormulaBuilder,
  HelperTooltipContent,
  type FormulaBuilderResult,
} from '@/components/FormulaBuilder';
import {
  ApiError,
  templatesApi,
  themesApi,
  type FormulaDTO,
  type FormulaInputDTO,
  type TemplateDTO,
  type ThemeDTO,
} from '@/lib/api';
import { extractUsedHelpers } from '@/lib/formulaHelp';
import { cn } from '@/lib/utils';

export function TemplateEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editor, setEditor] = useState<TiptapEditorInstance | null>(null);
  const [contentHtml, setContentHtml] = useState<string>('');
  const [name, setName] = useState('');
  const [themeId, setThemeId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  /**
   * Formula metadata by tagKey. Seeded from the loaded template and
   * extended when the admin creates a new formula through the
   * builder. The TipTap document owns the *placement* of each formula
   * (the `formulaTag` node); this map owns the metadata we need to
   * round-trip through the backend (expression, dependsOn, label).
   */
  const [formulasByKey, setFormulasByKey] = useState<Record<string, FormulaInputDTO>>({});
  const [builderOpen, setBuilderOpen] = useState(false);
  /**
   * When set, the FormulaBuilder is opened in EDIT mode against the
   * formula with this tagKey. The submit handler then replaces the
   * existing TipTap node and metadata entry instead of inserting a
   * new one. Cleared on dialog close.
   */
  const [editingFormulaKey, setEditingFormulaKey] = useState<string | null>(null);

  const templateQuery = useQuery({
    queryKey: ['template', id],
    queryFn: () => templatesApi.get(id!).then((r) => r.template),
    enabled: !!id,
  });

  const themesQuery = useQuery<ThemeDTO[]>({
    queryKey: ['themes'],
    queryFn: () => themesApi.list().then((r) => r.themes),
  });

  // Seed local state when the template arrives or the id changes.
  useEffect(() => {
    const tpl = templateQuery.data;
    if (!tpl) return;
    setContentHtml(tpl.contentHtml);
    setName(tpl.name);
    setThemeId(tpl.themeId);
    setDirty(false);
    setSaveError(null);
    setSavedAt(null);
    // Seed formulas map from the backend payload.
    const seed: Record<string, FormulaInputDTO> = {};
    for (const f of tpl.formulas ?? []) {
      seed[f.tagKey] = formulaDtoToInput(f);
    }
    setFormulasByKey(seed);
  }, [templateQuery.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMutation = useMutation({
    mutationFn: (body: {
      name: string;
      themeId: string;
      contentHtml: string;
      formulas: FormulaInputDTO[];
    }) => templatesApi.update(id!, body),
    onSuccess: ({ template }) => {
      setSavedAt(Date.now());
      setDirty(false);
      queryClient.setQueryData(['template', id], template);
      // Refresh the templates list cache for any open TemplatesPage.
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      // Re-seed formulasByKey from the server response so new rows
      // pick up their persisted IDs.
      const seed: Record<string, FormulaInputDTO> = {};
      for (const f of template.formulas ?? []) {
        seed[f.tagKey] = formulaDtoToInput(f);
      }
      setFormulasByKey(seed);
    },
    onError: (err) => {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Не удалось сохранить шаблон';
      setSaveError(message);
    },
  });

  /**
   * Walk the current editor document, pick up every `formulaTag`
   * node, and build the array we will PUT to the backend. Formula
   * metadata is sourced from `formulasByKey` — the TipTap attrs only
   * carry tagKey/label/expression, while dependsOn is stored in the
   * map (populated by the FormulaBuilder).
   */
  const extractFormulasFromEditor = useCallback((): FormulaInputDTO[] => {
    if (!editor) {
      // Fall back to the map if the editor isn't ready yet.
      return Object.values(formulasByKey);
    }
    const seenKeys = new Set<string>();
    const result: FormulaInputDTO[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name !== 'formulaTag') return;
      const attrs = node.attrs as {
        tagKey?: string;
        label?: string;
        expression?: string;
      };
      const key = String(attrs.tagKey ?? '').trim();
      if (!key || seenKeys.has(key)) return;
      seenKeys.add(key);
      const meta = formulasByKey[key];
      result.push({
        id: meta?.id,
        tagKey: key,
        label: String(attrs.label ?? meta?.label ?? ''),
        expression: String(attrs.expression ?? meta?.expression ?? ''),
        dependsOn:
          meta?.dependsOn ?? { deal: [], contact: [], company: [] },
      });
    });
    return result;
  }, [editor, formulasByKey]);

  const handleSave = () => {
    if (!id) return;
    if (!name.trim()) {
      setSaveError('Имя шаблона обязательно');
      return;
    }
    if (!themeId) {
      setSaveError('Тема обязательна');
      return;
    }
    setSaveError(null);
    saveMutation.mutate({
      name: name.trim(),
      themeId,
      contentHtml: contentHtml,
      formulas: extractFormulasFromEditor(),
    });
  };

  /* -------------------- Formula builder wiring ------------------- */

  /** Tag keys currently present inside the editor + in the local map. */
  const existingKeys = useMemo(() => {
    const keys = new Set<string>(Object.keys(formulasByKey));
    if (editor) {
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'formulaTag') {
          const k = String(node.attrs.tagKey ?? '').trim();
          if (k) keys.add(k);
        }
      });
    }
    return Array.from(keys);
  }, [editor, formulasByKey]);

  const handleInsertFormula = useCallback(
    (result: FormulaBuilderResult) => {
      if (!editor) return;

      // EDIT mode: locate the existing formulaTag node by its old key
      // and patch its attrs in place. We rebuild the tx via setNodeMarkup
      // so the DOM rerenders with the new label/expression. If the user
      // changed the tagKey, the metadata map is updated accordingly.
      if (editingFormulaKey) {
        const oldKey = editingFormulaKey;
        let pos: number | null = null;
        editor.state.doc.descendants((node, p) => {
          if (node.type.name === 'formulaTag' && String(node.attrs.tagKey) === oldKey) {
            pos = p;
            return false;
          }
          return true;
        });
        if (pos !== null) {
          const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
            tagKey: result.tagKey,
            label: result.label,
            expression: result.expression,
          });
          editor.view.dispatch(tr);
        }
        setFormulasByKey((prev) => {
          const next = { ...prev };
          if (oldKey !== result.tagKey) delete next[oldKey];
          next[result.tagKey] = {
            id: prev[oldKey]?.id,
            tagKey: result.tagKey,
            label: result.label,
            expression: result.expression,
            dependsOn: result.dependsOn,
          };
          return next;
        });
        setEditingFormulaKey(null);
        setDirty(true);
        return;
      }

      // INSERT mode (new formula at caret).
      editor
        .chain()
        .focus()
        .insertFormulaTag({
          tagKey: result.tagKey,
          label: result.label,
          expression: result.expression,
        })
        .run();
      setFormulasByKey((prev) => ({
        ...prev,
        [result.tagKey]: {
          tagKey: result.tagKey,
          label: result.label,
          expression: result.expression,
          dependsOn: result.dependsOn,
        },
      }));
      setDirty(true);
    },
    [editor, editingFormulaKey],
  );

  /**
   * Click-to-edit: install a delegated click listener on the editor
   * DOM that catches clicks on formula pills and opens the builder
   * pre-filled with the matching metadata. We attach via the editor's
   * `view.dom` so the listener is automatically removed on unmount.
   */
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const handler = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const pill = target.closest('span[data-formula-key]') as HTMLElement | null;
      if (!pill || !dom.contains(pill)) return;
      const key = pill.getAttribute('data-formula-key') ?? '';
      if (!key) return;
      // Prevent ProseMirror from claiming the click as a node selection.
      event.preventDefault();
      event.stopPropagation();
      setEditingFormulaKey(key);
      setBuilderOpen(true);
    };
    dom.addEventListener('click', handler);
    return () => dom.removeEventListener('click', handler);
  }, [editor]);

  const handleContentChange = (html: string) => {
    setContentHtml(html);
    setDirty(true);
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setDirty(true);
  };

  const handleThemeChange = (value: string) => {
    setThemeId(value);
    setDirty(true);
  };

  const themes = useMemo(() => themesQuery.data ?? [], [themesQuery.data]);

  if (!id) {
    return (
      <div className="p-6 text-sm text-destructive">
        Не указан id шаблона в URL.
      </div>
    );
  }

  if (templateQuery.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загружаем шаблон…
      </div>
    );
  }

  if (templateQuery.isError || !templateQuery.data) {
    const message =
      templateQuery.error instanceof ApiError
        ? templateQuery.error.message
        : 'Шаблон не найден';
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{message}</span>
        </div>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/templates')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          К списку шаблонов
        </Button>
      </div>
    );
  }

  const template: TemplateDTO = templateQuery.data;

  return (
    <div className="flex h-screen w-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/templates')}
          aria-label="Назад"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex flex-1 flex-wrap items-center gap-3">
          <Input
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Имя шаблона"
            className="max-w-xs"
          />
          <select
            value={themeId}
            onChange={(e) => handleThemeChange(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {themes.length === 0 && <option value="">Нет тем</option>}
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {dirty && (
            <span className="text-xs text-muted-foreground">Несохранённые изменения</span>
          )}
          {!dirty && savedAt && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <CheckCircle2 className="h-3 w-3" />
              Сохранено
            </span>
          )}
        </div>

        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending || !dirty}
          className={cn(saveMutation.isPending && 'opacity-70')}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Сохранить
        </Button>
      </header>

      {saveError && (
        <div className="mx-6 mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="border-b border-border px-6 py-2">
        <Toolbar
          editor={editor}
          onInsertFormula={() => setBuilderOpen(true)}
        />
      </div>

      <main className="flex-1 overflow-y-auto bg-muted/20 px-6 py-6">
        <div className="mx-auto max-w-4xl">
          <TiptapEditor
            content={template.contentHtml}
            onChange={handleContentChange}
            onReady={setEditor}
            placeholder="Введите содержимое шаблона…"
          />
        </div>
      </main>

      {/* Hover-подсказка над пилюлями формул прямо в редакторе. */}
      <EditorFormulaTooltip editor={editor} formulasByKey={formulasByKey} />

      <FormulaBuilder
        open={builderOpen}
        onOpenChange={(open) => {
          setBuilderOpen(open);
          if (!open) setEditingFormulaKey(null);
        }}
        onInsert={handleInsertFormula}
        existingKeys={
          editingFormulaKey
            ? existingKeys.filter((k) => k !== editingFormulaKey)
            : existingKeys
        }
        initialValues={
          editingFormulaKey ? formulasByKey[editingFormulaKey] : undefined
        }
      />
    </div>
  );
}

/**
 * Translate the TemplateDTO's Formula shape into the FormulaInputDTO
 * we will send back on save. We preserve the id so the backend can
 * reuse rows on update.
 */
function formulaDtoToInput(f: FormulaDTO): FormulaInputDTO {
  return {
    id: f.id,
    tagKey: f.tagKey,
    label: f.label,
    expression: f.expression,
    dependsOn: f.dependsOn,
  };
}

/* ----------------------------------------------------------------- */
/* EditorFormulaTooltip                                                */
/* ----------------------------------------------------------------- */

/**
 * Hover-подсказка для пилюль формул внутри TipTap.
 *
 * Подсказка работает в стиле Google Sheets:
 *  - Слушает делегированные mouseover/mouseout на `editor.view.dom`
 *    и реагирует на любые `<span data-formula-key>`.
 *  - При наведении задержка 200 мс, после чего показывается всплывающее
 *    окно поверх viewport через portal в document.body. Это необходимо,
 *    потому что TipTap рендерит пилюли как обычный HTML, а не как React,
 *    поэтому RichTooltip-обёртку поверх них поставить нельзя.
 *  - Содержимое: метка формулы, выражение, зависимости от полей CRM и
 *    автоматически собранный список встретившихся в выражении функций
 *    (через extractUsedHelpers + HelperTooltipContent).
 *
 * Подсказка не интерактивная (pointer-events: none), поэтому не мешает
 * клику по пилюле, который уже открывает FormulaBuilder в режиме EDIT.
 */
function EditorFormulaTooltip({
  editor,
  formulasByKey,
}: {
  editor: TiptapEditorInstance | null;
  formulasByKey: Record<string, FormulaInputDTO>;
}) {
  const [state, setState] = useState<
    | {
        key: string;
        rect: DOMRect;
      }
    | null
  >(null);

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    let showTimer: number | null = null;

    const clearShowTimer = () => {
      if (showTimer != null) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
    };

    const handleOver = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const pill = target.closest('span[data-formula-key]') as HTMLElement | null;
      if (!pill || !dom.contains(pill)) return;
      const key = pill.getAttribute('data-formula-key') ?? '';
      if (!key) return;
      clearShowTimer();
      showTimer = window.setTimeout(() => {
        setState({ key, rect: pill.getBoundingClientRect() });
      }, 200);
    };

    const handleOut = (event: Event) => {
      const e = event as MouseEvent;
      const target = e.target as HTMLElement | null;
      const pill = target?.closest('span[data-formula-key]') as HTMLElement | null;
      if (!pill) return;
      const related = e.relatedTarget as Node | null;
      if (related && pill.contains(related)) return;
      clearShowTimer();
      setState(null);
    };

    dom.addEventListener('mouseover', handleOver);
    dom.addEventListener('mouseout', handleOut);
    return () => {
      clearShowTimer();
      dom.removeEventListener('mouseover', handleOver);
      dom.removeEventListener('mouseout', handleOut);
    };
  }, [editor]);

  if (!state) return null;
  const meta = formulasByKey[state.key];

  // Позиционирование: под пилюлей с зазором, с горизонтальным
  // клэмпом по краям окна, без сложных перерасчётов после рендера
  // (для редактора этой простоты достаточно — пилюли невысокие).
  const margin = 8;
  const tooltipWidth = 360;
  let left = state.rect.left;
  if (left + tooltipWidth > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - tooltipWidth - margin);
  }
  let top = state.rect.bottom + margin;
  // Если внизу мало места — показать сверху.
  if (top + 200 > window.innerHeight && state.rect.top > 220) {
    top = Math.max(margin, state.rect.top - 220);
  }

  const usedHelpers = meta ? extractUsedHelpers(meta.expression) : [];
  const depCount = meta
    ? meta.dependsOn.deal.length +
      meta.dependsOn.contact.length +
      meta.dependsOn.company.length
    : 0;

  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[1000] w-[360px] rounded-md border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-lg"
      style={{ top, left }}
    >
      {meta ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-600">
              Σ Формула
            </span>
            <span className="font-medium text-foreground">{meta.label}</span>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Выражение
            </div>
            <pre className="mt-0.5 whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground">
              {meta.expression || '—'}
            </pre>
          </div>
          {depCount > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Зависит от полей
              </div>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {meta.dependsOn.deal.map((c) => (
                  <code
                    key={`d-${c}`}
                    className="rounded bg-blue-50 px-1 py-0.5 font-mono text-[10px] text-blue-800 ring-1 ring-inset ring-blue-200"
                  >
                    DEAL.{c}
                  </code>
                ))}
                {meta.dependsOn.contact.map((c) => (
                  <code
                    key={`c-${c}`}
                    className="rounded bg-emerald-50 px-1 py-0.5 font-mono text-[10px] text-emerald-800 ring-1 ring-inset ring-emerald-200"
                  >
                    CONTACT.{c}
                  </code>
                ))}
                {meta.dependsOn.company.map((c) => (
                  <code
                    key={`co-${c}`}
                    className="rounded bg-amber-50 px-1 py-0.5 font-mono text-[10px] text-amber-900 ring-1 ring-inset ring-amber-200"
                  >
                    COMPANY.{c}
                  </code>
                ))}
              </div>
            </div>
          )}
          {usedHelpers.length > 0 && (
            <div className="border-t border-border pt-1.5">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Используемые функции
              </div>
              <div className="space-y-2">
                {usedHelpers.map((doc) => (
                  <HelperTooltipContent key={doc.name} doc={doc} />
                ))}
              </div>
            </div>
          )}
          <div className="border-t border-border pt-1 text-[10px] text-muted-foreground">
            Кликните по пилюле, чтобы изменить формулу.
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground">
          Формула <code className="font-mono">{state.key}</code> не найдена в
          метаданных шаблона.
        </div>
      )}
    </div>,
    document.body,
  );
}
