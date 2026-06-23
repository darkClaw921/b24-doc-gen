/**
 * TemplateEditorPage — admin editor for a single template.
 *
 * Route: `/templates/:id/edit`
 *
 * Editing model (tags, not WYSIWYG):
 *  The placement of every placeholder lives in the admin-uploaded
 *  `.docx` itself (e.g. `{nds_20}`, `{nomer_dogovora}`). This page no
 *  longer uses a TipTap WYSIWYG document to *position* formulas/fields.
 *  Instead it:
 *
 *   1. Fetches the template with `templatesApi.get(id, { withDocx: true })`,
 *      which returns the original `.docx` (`originalDocxBase64`) and the
 *      list of placeholder tags scanned from it (`docxPlaceholders`).
 *   2. Renders the original `.docx` in an *editable* in-browser editor
 *      (`@eigenpal/docx-editor-react`) so the admin can both see where each
 *      tag sits and edit the document text/placeholders directly. Edits are
 *      tracked via `docDirty`; on save the edited `.docx` is pushed to
 *      `PUT /api/templates/:id/docx`, which re-scans the placeholder tags.
 *   3. Shows a "Теги шаблона" panel listing every tag with its binding
 *      status: bound to a formula, declared a manual field, reserved
 *      (product-loop tags filled automatically), or *unbound* (no
 *      binding yet — highlighted as a warning so the admin doesn't
 *      forget it).
 *   4. For each tag the admin can attach a formula (reusing
 *      `FormulaBuilder` + `FieldPicker`, with `tagKey` pre-filled from the
 *      tag) or declare a manual field (reusing `ManualFieldBuilder`, with
 *      `fieldKey` pre-filled). Bindings live in local `formulasByKey` /
 *      `fieldsByKey` maps keyed by the tag name.
 *   4b. Alternatively, the "Вставить формулу" / "Вставить поле" buttons above
 *      the editor open the same builders in *insert* mode: the admin authors a
 *      brand-new formula/field and its `{tagKey}` is dropped into the document
 *      at the cursor via the ProseMirror view (`getEditorRef().getView()`),
 *      mirroring the legacy TipTap "Σ" toolbar. The new tag is tracked in
 *      `locallyInsertedTags` so it shows in the panel before the next save.
 *   4c. The `<DocxEditor>` is wrapped in `<PluginHost plugins={[templatePlugin]}>`,
 *      whose `renderOverlay` paints a `.template-highlight` pill over every
 *      `{tag}` placeholder on the document pages. A delegated `mouseover` off the
 *      editor host reads the hovered tag from `pluginHostRef.getPluginState(
 *      'template').hoveredId` (the pill div has no `data-tag`) and anchors a
 *      `TagHoverContent` tooltip showing the tag's binding — restoring the old
 *      pill highlight + hover popup.
 *   5. Saving issues `PUT /api/templates/:id` with the `formulas[]` and
 *      `fields[]` arrays only. `contentHtml` is sent unchanged (it no
 *      longer carries any formula/field markup). The admin is warned
 *      before saving if any non-reserved tag is still unbound.
 *
 * The template name and theme remain editable in the header, alongside
 * the Save button. The legacy TipTap editor/toolbar is intentionally not
 * mounted here.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DocxEditor, type DocxEditorRef } from '@eigenpal/docx-editor-react';
import { PluginHost, templatePlugin, type PluginHostRef } from '@eigenpal/docx-editor-react/plugin-api';
import '@eigenpal/docx-editor-react/styles.css';
import {
  ArrowLeft,
  Save,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Sigma,
  PenLine,
  Lock,
  Plus,
  Pencil,
  Trash2,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  FormulaBuilder,
  type FormulaBuilderResult,
} from '@/components/FormulaBuilder';
import {
  ManualFieldBuilder,
  type ManualFieldBuilderResult,
} from '@/components/ManualFieldBuilder';
import {
  ApiError,
  templatesApi,
  themesApi,
  type FormulaDTO,
  type FormulaInputDTO,
  type TemplateDTO,
  type TemplateFieldDTO,
  type TemplateFieldInputDTO,
  type ThemeDTO,
} from '@/lib/api';
import { computeTagStatus, isReservedTag, type TagBindingStatus } from '@/lib/templateTags';
import { generateTagKey } from '@/lib/formulas';
import {
  buildLinePattern,
  findFormulaSuggestion,
  addFormulaMemory,
  loadFormulaMemory,
  saveFormulaMemory,
  type FormulaMemoryEntry,
} from '@/lib/formulaSuggest';
import { cn } from '@/lib/utils';

/**
 * The DocxEditor ships its own (Word-like) styles via `styles.css`. We mount
 * the editor inside a container carrying this class and a CSS `isolation`
 * context so its layout/paint stays scoped to the left pane and does not
 * bleed into the surrounding app chrome or the right-hand tags panel.
 */
const EDITOR_CLASS_NAME = 'docx-editor-host';

/**
 * Pill-style highlight for the `{tag}` placeholders the template plugin
 * decorates with `.docx-template-tag`. The plugin's own `TEMPLATE_DECORATION_STYLES`
 * only sets cursor/hover-filter, so we add the amber background that mirrors the
 * old TipTap formula pills. Scoped under the editor host so it can't leak. The
 * cursor is `help` to hint the hover tooltip.
 */
const TAG_HIGHLIGHT_STYLES = `
.docx-editor-host .docx-template-tag {
  background: #fef9c3;
  border-radius: 3px;
  box-shadow: inset 0 0 0 1px rgba(202, 138, 4, 0.45);
  cursor: help;
}
.docx-editor-host .docx-template-tag:hover,
.docx-editor-host .docx-template-tag.hovered {
  background: #fde68a;
}
`;

/** Decode a base64 string into a `Uint8Array`. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function TemplateEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [themeId, setThemeId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  /**
   * Formula metadata keyed by tagKey. Seeded from the loaded template and
   * extended when the admin binds a tag to a formula. The `.docx` owns the
   * *placement* of each tag; this map owns the metadata we round-trip
   * through the backend (expression, dependsOn, label).
   */
  const [formulasByKey, setFormulasByKey] = useState<Record<string, FormulaInputDTO>>({});
  /** Manual-field metadata keyed by fieldKey. Mirrors `formulasByKey`. */
  const [fieldsByKey, setFieldsByKey] = useState<Record<string, TemplateFieldInputDTO>>({});

  /** The tag currently targeted by an open builder dialog. */
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [fieldBuilderOpen, setFieldBuilderOpen] = useState(false);
  /**
   * When true, the open builder is in "insert" mode: it creates a brand-new
   * binding (the admin picks the tagKey) and the resulting `{tagKey}` is
   * inserted into the editor at the cursor — mirroring the old TipTap "Σ"
   * button. When false (the default), the builder is in "bind" mode and
   * attaches a formula/field to an existing `.docx` tag (`activeTag`).
   */
  const [insertMode, setInsertMode] = useState(false);
  /**
   * Tags inserted into the document during this session via the "Вставить
   * формулу/поле" buttons. They are not yet in the server-side
   * `docxPlaceholders` (that list refreshes only after the `.docx` is saved),
   * so we merge them into the tags panel locally for immediate feedback.
   * Cleared when a fresh template loads.
   */
  const [locallyInsertedTags, setLocallyInsertedTags] = useState<string[]>([]);

  /** Imperative handle to the docx editor (used to `save()` on submit). */
  const editorRef = useRef<DocxEditorRef>(null);
  /**
   * Wrapper around the editor (and the template plugin's highlight overlays).
   * Hover listeners are delegated off this node because the highlighted `{tag}`
   * pills are rendered by the plugin overlay (which carries `data-tag`), not in
   * the hidden ProseMirror DOM.
   */
  const editorHostRef = useRef<HTMLDivElement>(null);
  /**
   * Handle to the PluginHost — its `getPluginState('template')` returns the
   * template plugin's `{ tags, hoveredId }`, which is how we map a hovered
   * highlight pill (the overlay div carries no `data-tag`) back to its tag name.
   */
  const pluginHostRef = useRef<PluginHostRef>(null);
  /**
   * The tag currently hovered in the editor and the viewport coordinates where
   * its tooltip should anchor. Null when nothing is hovered.
   */
  const [hoverInfo, setHoverInfo] = useState<{ tag: string; top: number; left: number } | null>(null);
  /**
   * «Обучение по примеру»: история сопоставлений «шаблон строки → формула»
   * (lib/formulaSuggest.ts, localStorage). Когда админ выделяет фрагмент и
   * вставляет вместо него формулу, шаблон ВСЕЙ строки запоминается; при
   * выделении в похожей строке редактор предлагает ту же формулу.
   */
  const [formulaMemory, setFormulaMemory] = useState<FormulaMemoryEntry[]>(() =>
    loadFormulaMemory(),
  );
  /**
   * Активное предложение формулы для текущего выделения: запись из памяти и
   * экранные координаты якоря всплывашки. Null — предложить нечего.
   */
  const [suggestion, setSuggestion] = useState<
    { entry: FormulaMemoryEntry; top: number; left: number } | null
  >(null);
  /**
   * Шаблон строки, зафиксированный в момент открытия конструктора в
   * insert-режиме. По нему `handleConfirmFormula` запоминает сопоставление
   * после успешной вставки формулы.
   */
  const pendingLinePatternRef = useRef<string | null>(null);
  /**
   * Template plugin (docxtemplater syntax detection + highlight overlays). It is
   * driven by `<PluginHost>`, which computes the plugin's `renderOverlay` output
   * and feeds it back to `<DocxEditor>` as `pluginOverlays` — this is what
   * actually paints the `{tag}` pills over the document pages.
   */
  const plugins = useMemo(() => [templatePlugin], []);
  /**
   * Whether the admin edited the `.docx` in the editor since it was loaded.
   * Drives whether `handleSave` pushes the edited bytes to the backend.
   */
  const [docDirty, setDocDirty] = useState(false);
  /** Last error reported by the editor (parse/render failure). */
  const [editorError, setEditorError] = useState<string | null>(null);
  /**
   * True while the edited `.docx` is being serialized and pushed to
   * `PUT /api/templates/:id/docx` (step 1 of the save flow). Combined with
   * `saveMutation.isPending` (step 3) to drive the Save button's spinner.
   */
  const [isSavingDocx, setIsSavingDocx] = useState(false);

  // Fetch the template *with* the original .docx so we can both render a
  // preview and read its scanned placeholder tags.
  const templateQuery = useQuery({
    queryKey: ['template', id, 'withDocx'],
    queryFn: () => templatesApi.get(id!, { withDocx: true }).then((r) => r.template),
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
    setName(tpl.name);
    setThemeId(tpl.themeId);
    setDirty(false);
    setDocDirty(false);
    setEditorError(null);
    setSaveError(null);
    setSavedAt(null);
    setLocallyInsertedTags([]);
    const seed: Record<string, FormulaInputDTO> = {};
    for (const f of tpl.formulas ?? []) {
      seed[f.tagKey] = formulaDtoToInput(f);
    }
    setFormulasByKey(seed);
    const fieldSeed: Record<string, TemplateFieldInputDTO> = {};
    for (const f of tpl.fields ?? []) {
      fieldSeed[f.fieldKey] = fieldDtoToInput(f);
    }
    setFieldsByKey(fieldSeed);
  }, [templateQuery.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The original `.docx` bytes decoded into an `ArrayBuffer` for the editor's
   * `documentBuffer` prop. `null` while the base64 hasn't arrived (or the
   * template has no original `.docx`), in which case a placeholder is shown.
   * Re-derived only when the loaded bytes change, so editing the document in
   * place does not re-seed (and reset) the editor.
   */
  const documentBuffer = useMemo<ArrayBuffer | null>(() => {
    const b64 = templateQuery.data?.originalDocxBase64;
    if (!b64) return null;
    const bytes = base64ToBytes(b64);
    // `base64ToBytes` allocates over a fresh, non-shared `ArrayBuffer`, so the
    // backing buffer is exactly the docx bytes — hand it straight to the
    // editor. Casting to `ArrayBuffer` narrows the `ArrayBufferLike` type.
    return bytes.buffer as ArrayBuffer;
  }, [templateQuery.data?.originalDocxBase64]);

  /**
   * Hover tooltip wiring. The template plugin paints each `{tag}` as a
   * `.template-highlight` overlay pill (`pointer-events: auto`). The pill div
   * carries no `data-tag`, so we read the hovered tag from the plugin state:
   * the pill's own `onMouseEnter` calls `setHoveredElement`, after which
   * `getPluginState('template').hoveredId` resolves to a tag in `tags`. The
   * lookup is deferred via `requestAnimationFrame` so the plugin's handler has
   * landed before we read the state. Anchored to the pill's bounding box.
   */
  useEffect(() => {
    const dom = editorHostRef.current;
    if (!dom) return;
    let hideTimer: number | undefined;
    const onOver = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.('.template-highlight') as HTMLElement | null;
      if (!el) return;
      if (hideTimer) window.clearTimeout(hideTimer);
      const r = el.getBoundingClientRect();
      window.requestAnimationFrame(() => {
        const state = pluginHostRef.current?.getPluginState<{
          tags?: Array<{ id: string; name: string }>;
          hoveredId?: string;
        }>('template');
        const tag = state?.tags?.find((t) => t.id === state?.hoveredId);
        if (!tag?.name) return;
        setHoverInfo({ tag: tag.name, top: r.bottom + 6, left: r.left });
      });
    };
    const onOut = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.('.template-highlight')) return;
      hideTimer = window.setTimeout(() => setHoverInfo(null), 150);
    };
    dom.addEventListener('mouseover', onOver);
    dom.addEventListener('mouseout', onOut);
    return () => {
      if (hideTimer) window.clearTimeout(hideTimer);
      dom.removeEventListener('mouseover', onOver);
      dom.removeEventListener('mouseout', onOut);
    };
  }, [documentBuffer]);

  /**
   * Автоподсказка формулы по выделению. На `mouseup`/`keyup` в редакторе
   * строим шаблон текущей строки и ищем сопоставление в `formulaMemory`.
   * Если строка похожа на ту, где формулу уже вставляли, показываем
   * всплывашку с предложением вставить ту же формулу. Чтение selection
   * отложено через rAF, чтобы ProseMirror успел обновить состояние.
   */
  useEffect(() => {
    const dom = editorHostRef.current;
    if (!dom) return;
    if (formulaMemory.length === 0) {
      setSuggestion(null);
      return;
    }
    const refresh = () => {
      window.requestAnimationFrame(() => {
        const view = editorRef.current?.getEditorRef()?.getView();
        if (!view || view.state.selection.empty) {
          setSuggestion(null);
          return;
        }
        const entry = findFormulaSuggestion(captureLinePattern(), formulaMemory);
        if (!entry) {
          setSuggestion(null);
          return;
        }
        const coords = view.coordsAtPos(view.state.selection.from);
        setSuggestion({ entry, top: coords.bottom + 6, left: coords.left });
      });
    };
    dom.addEventListener('mouseup', refresh);
    dom.addEventListener('keyup', refresh);
    return () => {
      dom.removeEventListener('mouseup', refresh);
      dom.removeEventListener('keyup', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentBuffer, formulaMemory]);

  const saveMutation = useMutation({
    mutationFn: (body: {
      name: string;
      themeId: string;
      formulas: FormulaInputDTO[];
      fields: TemplateFieldInputDTO[];
    }) => templatesApi.update(id!, body),
    onSuccess: ({ template }) => {
      setSavedAt(Date.now());
      setDirty(false);
      // `PUT /templates/:id` responds with a `withDocx: false` DTO (no
      // `originalDocxBase64`, no `docxPlaceholders`). Merge it into the cache
      // while preserving the docx body and scanned placeholders so the editor
      // and the "Теги шаблона" panel keep their data after a binding save.
      queryClient.setQueryData<TemplateDTO | undefined>(
        ['template', id, 'withDocx'],
        (prev) => ({
          ...template,
          hasOriginalDocx: prev?.hasOriginalDocx ?? template.hasOriginalDocx,
          originalDocxBase64: prev?.originalDocxBase64,
          docxPlaceholders: prev?.docxPlaceholders,
        }),
      );
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      // Re-seed maps from the server response so new rows pick up their
      // persisted IDs.
      const seed: Record<string, FormulaInputDTO> = {};
      for (const f of template.formulas ?? []) {
        seed[f.tagKey] = formulaDtoToInput(f);
      }
      setFormulasByKey(seed);
      const fieldSeed: Record<string, TemplateFieldInputDTO> = {};
      for (const f of template.fields ?? []) {
        fieldSeed[f.fieldKey] = fieldDtoToInput(f);
      }
      setFieldsByKey(fieldSeed);
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

  const themes = useMemo(() => themesQuery.data ?? [], [themesQuery.data]);

  /**
   * True while either save step is in flight (pushing the edited `.docx` or
   * persisting the formula/field bindings). Drives the Save button spinner.
   */
  const isSaving = isSavingDocx || saveMutation.isPending;

  /* -------------------- Derived tag model ------------------------ */

  const formulaKeySet = useMemo(
    () => new Set(Object.keys(formulasByKey)),
    [formulasByKey],
  );
  const fieldKeySet = useMemo(
    () => new Set(Object.keys(fieldsByKey)),
    [fieldsByKey],
  );

  /**
   * The list of placeholder tags scanned from the .docx. Falls back to
   * the union of currently-bound keys when the template has no scanned
   * tags (e.g. a template created before the .docx scan existed), so the
   * admin can still see and manage existing bindings.
   */
  const tags = useMemo<string[]>(() => {
    const scanned = templateQuery.data?.docxPlaceholders ?? [];
    // Merge server-scanned tags with the ones inserted locally this session
    // (not yet re-scanned), so freshly inserted placeholders appear in the
    // panel immediately instead of waiting for the next .docx save.
    if (scanned.length > 0 || locallyInsertedTags.length > 0) {
      const merged = new Set<string>([...scanned, ...locallyInsertedTags]);
      return Array.from(merged).sort((a, b) => a.localeCompare(b));
    }
    const union = new Set<string>([
      ...Object.keys(formulasByKey),
      ...Object.keys(fieldsByKey),
    ]);
    return Array.from(union).sort((a, b) => a.localeCompare(b));
  }, [templateQuery.data?.docxPlaceholders, locallyInsertedTags, formulasByKey, fieldsByKey]);

  const tagStatuses = useMemo(
    () =>
      tags.map((tag) => ({
        tag,
        status: computeTagStatus(tag, formulaKeySet, fieldKeySet),
      })),
    [tags, formulaKeySet, fieldKeySet],
  );

  /** Non-reserved tags that still have no formula/field binding. */
  const unboundTags = useMemo(
    () => tagStatuses.filter((t) => t.status === 'unbound').map((t) => t.tag),
    [tagStatuses],
  );

  /**
   * Bound keys that are not present among the scanned tags — orphaned
   * bindings (e.g. the admin edited the .docx and removed a placeholder).
   * Surfaced so they can still be removed.
   */
  const orphanBindings = useMemo(() => {
    const tagSet = new Set(tags);
    const out: Array<{ key: string; status: TagBindingStatus }> = [];
    for (const k of Object.keys(formulasByKey)) {
      if (!tagSet.has(k)) out.push({ key: k, status: 'formula' });
    }
    for (const k of Object.keys(fieldsByKey)) {
      if (!tagSet.has(k)) out.push({ key: k, status: 'field' });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }, [tags, formulasByKey, fieldsByKey]);

  /* -------------------- Tag binding actions ---------------------- */

  /** Open the FormulaBuilder targeting `tag` (create or edit binding). */
  const openFormulaFor = (tag: string) => {
    setInsertMode(false);
    setActiveTag(tag);
    setBuilderOpen(true);
  };

  /** Open the ManualFieldBuilder targeting `tag` (create or edit binding). */
  const openFieldFor = (tag: string) => {
    setInsertMode(false);
    setActiveTag(tag);
    setFieldBuilderOpen(true);
  };

  /**
   * Open the FormulaBuilder in "insert" mode — a blank form where the admin
   * authors a new formula whose `{tagKey}` is then inserted at the cursor.
   * Mirrors the old TipTap "Σ Вставить формулу" toolbar button.
   */
  const openInsertFormula = () => {
    // Снимок шаблона строки до открытия диалога (пока выделение активно),
    // чтобы запомнить сопоставление «строка → формула» после вставки.
    pendingLinePatternRef.current = captureLinePattern();
    setSuggestion(null);
    setActiveTag(null);
    setInsertMode(true);
    setBuilderOpen(true);
  };

  /** Open the ManualFieldBuilder in "insert" mode (new field at cursor). */
  const openInsertField = () => {
    setActiveTag(null);
    setInsertMode(true);
    setFieldBuilderOpen(true);
  };

  /**
   * Insert a `{tagKey}` placeholder into the docx editor at the current
   * cursor position via the ProseMirror view exposed by `DocxEditorRef`.
   * Returns false when the editor view isn't ready yet (caller then asks the
   * admin to type the tag manually). Replaces the current selection, focuses
   * the editor and flags the document dirty so the new tag is persisted on save.
   */
  const insertPlaceholderAtCursor = (tagKey: string): boolean => {
    // `DocxEditorRef` exposes the inner ProseMirror handle via `getEditorRef()`,
    // whose `getView()` returns the live `EditorView` we dispatch into.
    const view = editorRef.current?.getEditorRef()?.getView();
    if (!view) return false;
    const { from, to } = view.state.selection;
    view.dispatch(view.state.tr.insertText(`{${tagKey}}`, from, to));
    view.focus();
    return true;
  };

  /**
   * Построить шаблон ВСЕЙ строки (абзаца), в которой сейчас стоит выделение:
   * текст родительского блока с маркером на месте выделения, нормализованный
   * (lib/formulaSuggest). Возвращает null, если редактор не готов, выделение
   * охватывает несколько блоков или строка пустая.
   */
  const captureLinePattern = (): string | null => {
    const view = editorRef.current?.getEditorRef()?.getView();
    if (!view) return null;
    const { $from, $to } = view.state.selection;
    // Учитываем только выделение в пределах одного текстового блока.
    if (!$from.sameParent($to)) return null;
    const lineText = $from.parent.textContent;
    return buildLinePattern(lineText, $from.parentOffset, $to.parentOffset);
  };

  /**
   * Применить предложенную формулу к текущему выделению: сгенерировать
   * уникальный tagKey из имени формулы, вставить `{tagKey}` вместо выделения
   * и завести привязку (как insert-режим конструктора, но без диалога).
   */
  const applySuggestion = (entry: FormulaMemoryEntry) => {
    const tagKey = generateTagKey(entry.label, Object.keys(formulasByKey));
    if (!tagKey) return;
    const inserted = insertPlaceholderAtCursor(tagKey);
    setFieldsByKey((prev) => {
      if (!(tagKey in prev)) return prev;
      const next = { ...prev };
      delete next[tagKey];
      return next;
    });
    setFormulasByKey((prev) => ({
      ...prev,
      [tagKey]: {
        id: prev[tagKey]?.id,
        tagKey,
        label: entry.label,
        expression: entry.expression,
        dependsOn: entry.dependsOn,
      },
    }));
    setLocallyInsertedTags((prev) => (prev.includes(tagKey) ? prev : [...prev, tagKey]));
    if (inserted) setDocDirty(true);
    else
      setSaveError(
        `Не удалось вставить {${tagKey}} в документ — впишите тег вручную в нужном месте.`,
      );
    setDirty(true);
    setSuggestion(null);
  };

  /** Remove the formula bound to `tag`. */
  const removeFormula = (tag: string) => {
    setFormulasByKey((prev) => {
      if (!(tag in prev)) return prev;
      const next = { ...prev };
      delete next[tag];
      return next;
    });
    setDirty(true);
  };

  /** Remove the manual field bound to `tag`. */
  const removeField = (tag: string) => {
    setFieldsByKey((prev) => {
      if (!(tag in prev)) return prev;
      const next = { ...prev };
      delete next[tag];
      return next;
    });
    setDirty(true);
  };

  const handleConfirmFormula = (result: FormulaBuilderResult) => {
    // Insert mode: the builder authored a brand-new formula. Its tagKey is
    // the binding key, and we insert `{tagKey}` into the document at the
    // cursor so the placeholder is positioned where the admin wants it.
    if (insertMode) {
      const tagKey = result.tagKey.trim();
      if (!tagKey) return;
      const inserted = insertPlaceholderAtCursor(tagKey);
      setFieldsByKey((prev) => {
        if (!(tagKey in prev)) return prev;
        const next = { ...prev };
        delete next[tagKey];
        return next;
      });
      setFormulasByKey((prev) => ({
        ...prev,
        [tagKey]: {
          id: prev[tagKey]?.id,
          tagKey,
          label: result.label,
          expression: result.expression,
          dependsOn: result.dependsOn,
        },
      }));
      setLocallyInsertedTags((prev) => (prev.includes(tagKey) ? prev : [...prev, tagKey]));
      if (inserted) setDocDirty(true);
      else
        setSaveError(
          `Не удалось вставить {${tagKey}} в документ — впишите тег вручную в нужном месте.`,
        );
      // Запомнить «шаблон строки → формула» для будущих автоподсказок.
      const pattern = pendingLinePatternRef.current;
      pendingLinePatternRef.current = null;
      if (pattern) {
        setFormulaMemory((prev) => {
          const next = addFormulaMemory(prev, {
            pattern,
            label: result.label,
            expression: result.expression,
            dependsOn: result.dependsOn,
          });
          saveFormulaMemory(next);
          return next;
        });
      }
      setDirty(true);
      setInsertMode(false);
      return;
    }

    const tag = activeTag;
    if (!tag) return;
    // Binding a formula to a tag clears any prior manual-field binding on
    // the same tag — a tag has exactly one binding.
    setFieldsByKey((prev) => {
      if (!(tag in prev)) return prev;
      const next = { ...prev };
      delete next[tag];
      return next;
    });
    setFormulasByKey((prev) => ({
      ...prev,
      [tag]: {
        id: prev[tag]?.id,
        // The tag name is the binding key; ignore any tagKey the builder
        // may have suggested so the formula always matches the .docx tag.
        tagKey: tag,
        label: result.label,
        expression: result.expression,
        dependsOn: result.dependsOn,
      },
    }));
    setDirty(true);
    setActiveTag(null);
  };

  const handleConfirmField = (result: ManualFieldBuilderResult) => {
    // Insert mode: author a new manual field and drop its `{fieldKey}` into
    // the document at the cursor.
    if (insertMode) {
      const fieldKey = result.fieldKey.trim();
      if (!fieldKey) return;
      const inserted = insertPlaceholderAtCursor(fieldKey);
      setFormulasByKey((prev) => {
        if (!(fieldKey in prev)) return prev;
        const next = { ...prev };
        delete next[fieldKey];
        return next;
      });
      setFieldsByKey((prev) => ({
        ...prev,
        [fieldKey]: {
          id: prev[fieldKey]?.id,
          fieldKey,
          label: result.label,
          type: result.type,
          required: result.required,
          placeholder: result.placeholder,
          defaultValue: result.defaultValue,
          options: result.options,
          valueMode: result.valueMode,
          order: prev[fieldKey]?.order,
        },
      }));
      setLocallyInsertedTags((prev) => (prev.includes(fieldKey) ? prev : [...prev, fieldKey]));
      if (inserted) setDocDirty(true);
      else
        setSaveError(
          `Не удалось вставить {${fieldKey}} в документ — впишите тег вручную в нужном месте.`,
        );
      setDirty(true);
      setInsertMode(false);
      return;
    }

    const tag = activeTag;
    if (!tag) return;
    // A tag has exactly one binding — drop any formula bound to it.
    setFormulasByKey((prev) => {
      if (!(tag in prev)) return prev;
      const next = { ...prev };
      delete next[tag];
      return next;
    });
    setFieldsByKey((prev) => ({
      ...prev,
      [tag]: {
        id: prev[tag]?.id,
        fieldKey: tag,
        label: result.label,
        type: result.type,
        required: result.required,
        placeholder: result.placeholder,
        defaultValue: result.defaultValue,
        options: result.options,
        valueMode: result.valueMode,
        order: prev[tag]?.order,
      },
    }));
    setDirty(true);
    setActiveTag(null);
  };

  /* -------------------- Save ------------------------------------- */

  /**
   * Save flow, run as one sequential operation behind the single "Сохранить"
   * button:
   *
   *  1. If the `.docx` was edited (`docDirty`), serialize it via
   *     `editorRef.save()` and push it to `PUT /api/templates/:id/docx`. The
   *     backend replaces `originalDocx` and re-scans placeholder tags,
   *     returning the fresh `docxPlaceholders`. The cache is updated so the
   *     "Теги шаблона" panel picks up any newly-added (or removed) tags.
   *  2. The unbound-tag confirmation runs *after* the re-scan, because the
   *     set of tags may have changed in step 1.
   *  3. The formula/field bindings are persisted via `PUT /api/templates/:id`.
   *     If step 1 fails, steps 2–3 do not run and no bindings are saved.
   */
  const handleSave = async () => {
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

    // ---- Step 1: persist the edited .docx (if it changed) -------------
    // `effectiveTags` is the tag set the unbound check and `order` use. It
    // starts from the currently-loaded tags and is replaced by the freshly
    // re-scanned placeholders when the .docx is saved.
    let effectiveTags = tags;
    if (docDirty) {
      setIsSavingDocx(true);
      try {
        const buf = await editorRef.current?.save();
        if (!buf) {
          throw new Error('Редактор не вернул содержимое документа');
        }
        const blob = new Blob([buf], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        const { template: docxTemplate, docxPlaceholders } =
          await templatesApi.saveDocx(id, blob);

        // Merge the re-scanned placeholders into the cached withDocx template
        // so the tags panel re-renders immediately. The saveDocx response
        // omits the (large) base64 body and inline placeholders, so preserve
        // the existing base64 and graft the new placeholder list on.
        queryClient.setQueryData<TemplateDTO | undefined>(
          ['template', id, 'withDocx'],
          (prev) => ({
            ...(prev ?? {}),
            ...docxTemplate,
            originalDocxBase64: prev?.originalDocxBase64,
            docxPlaceholders,
          }),
        );
        // Reconcile the true new bytes in the background.
        queryClient.invalidateQueries({ queryKey: ['template', id, 'withDocx'] });
        queryClient.invalidateQueries({ queryKey: ['templates'] });

        effectiveTags = [...docxPlaceholders].sort((a, b) => a.localeCompare(b));
        setDocDirty(false);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Не удалось сохранить .docx';
        setSaveError(`Ошибка сохранения .docx: ${message}`);
        return;
      } finally {
        setIsSavingDocx(false);
      }
    }

    // ---- Step 2: warn about still-unbound tags (post re-scan) ----------
    const pendingUnbound = effectiveTags.filter(
      (tag) =>
        computeTagStatus(tag, formulaKeySet, fieldKeySet) === 'unbound',
    );
    if (pendingUnbound.length > 0) {
      const ok = window.confirm(
        `Остались несвязанные теги (${pendingUnbound.length}): ` +
          `${pendingUnbound.join(', ')}.\n` +
          'Они не будут заполнены при генерации. Сохранить всё равно?',
      );
      if (!ok) return;
    }

    // ---- Step 3: persist formula/field bindings ------------------------
    // We send arrays only — no contentHtml markup (the .docx owns placement
    // now). `order` is the tag's position so the generate form follows the
    // document layout.
    const formulas: FormulaInputDTO[] = Object.values(formulasByKey).map((f) => ({
      id: f.id,
      tagKey: f.tagKey,
      label: f.label,
      expression: f.expression,
      dependsOn: f.dependsOn ?? { deal: [], contact: [], company: [] },
    }));
    const tagOrder = new Map(effectiveTags.map((t, i) => [t, i]));
    const fields: TemplateFieldInputDTO[] = Object.values(fieldsByKey).map((f) => ({
      id: f.id,
      fieldKey: f.fieldKey,
      label: f.label,
      type: f.type,
      required: f.required,
      placeholder: f.placeholder ?? '',
      defaultValue: f.defaultValue ?? '',
      options: f.options,
      valueMode: f.valueMode,
      order: tagOrder.get(f.fieldKey) ?? 0,
    }));

    saveMutation.mutate({ name: name.trim(), themeId, formulas, fields });
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setDirty(true);
  };

  const handleThemeChange = (value: string) => {
    setThemeId(value);
    setDirty(true);
  };

  /* -------------------- Builder seed values ---------------------- */

  const formulaInitialValues = useMemo(() => {
    if (!activeTag) return undefined;
    const meta = formulasByKey[activeTag];
    if (meta) {
      return {
        tagKey: meta.tagKey,
        label: meta.label,
        expression: meta.expression,
        dependsOn: meta.dependsOn,
      };
    }
    // New binding — pre-fill the tagKey with the tag name.
    return { tagKey: activeTag, label: activeTag } as Partial<FormulaBuilderResult>;
  }, [activeTag, formulasByKey]);

  const fieldInitialValues = useMemo(() => {
    if (!activeTag) return undefined;
    const meta = fieldsByKey[activeTag];
    if (meta) {
      return {
        fieldKey: meta.fieldKey,
        label: meta.label,
        type: meta.type,
        required: meta.required,
        placeholder: meta.placeholder ?? '',
        defaultValue: meta.defaultValue ?? '',
        options: meta.options ?? [],
        valueMode: meta.valueMode ?? 'direct',
      };
    }
    return {
      fieldKey: activeTag,
      label: activeTag,
      type: 'text',
      required: false,
      placeholder: '',
      defaultValue: '',
    } as Partial<ManualFieldBuilderResult>;
  }, [activeTag, fieldsByKey]);

  // The builders enforce key uniqueness against `existingKeys`; since the
  // binding key is fixed to the tag, exclude the tag itself so re-binding
  // doesn't trip the "key already used" guard.
  const otherFormulaKeys = useMemo(
    () => Object.keys(formulasByKey).filter((k) => k !== activeTag),
    [formulasByKey, activeTag],
  );
  const otherFieldKeys = useMemo(
    () => Object.keys(fieldsByKey).filter((k) => k !== activeTag),
    [fieldsByKey, activeTag],
  );

  /* -------------------- Guards ----------------------------------- */

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
  const hasDocx = template.hasOriginalDocx && !!template.originalDocxBase64;

  return (
    <div className="flex h-screen w-full flex-col">
      <style>{TAG_HIGHLIGHT_STYLES}</style>
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
          {(dirty || docDirty) && (
            <span className="text-xs text-muted-foreground">Несохранённые изменения</span>
          )}
          {!dirty && !docDirty && savedAt && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <CheckCircle2 className="h-3 w-3" />
              Сохранено
            </span>
          )}
        </div>

        <Button
          onClick={() => void handleSave()}
          disabled={isSaving || (!dirty && !docDirty)}
          className={cn(isSaving && 'opacity-70')}
        >
          {isSaving ? (
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

      <div className="flex flex-1 overflow-hidden">
        {/* ---------------------------------------------------------- */}
        {/* Left — editable original .docx                             */}
        {/* ---------------------------------------------------------- */}
        <main className="flex flex-1 flex-col overflow-hidden border-r border-border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-6 py-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <FileText className="h-4 w-4" />
              Исходный .docx шаблона
            </h2>
            {/* Author a new formula/field and drop its {tag} at the cursor —
                the modern equivalent of the old TipTap Σ toolbar button. */}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={openInsertFormula}
                disabled={!hasDocx}
                title="Создать формулу и вставить её тег в позицию курсора"
              >
                <Sigma className="mr-1 h-3 w-3" />
                Вставить формулу
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={openInsertField}
                disabled={!hasDocx}
                title="Создать ручное поле и вставить его тег в позицию курсора"
              >
                <PenLine className="mr-1 h-3 w-3" />
                Вставить поле
              </Button>
            </div>
          </div>
          <section className="relative flex-1 overflow-hidden bg-muted/10">
            {!hasDocx ? (
              <div className="flex h-full items-center justify-center p-6">
                <div className="rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                  У этого шаблона нет исходного .docx. Загрузите .docx-файл на
                  странице списка шаблонов, чтобы редактировать документ и видеть
                  расположение тегов.
                </div>
              </div>
            ) : (
              <>
                {editorError && (
                  <div className="absolute inset-x-0 top-0 z-10 mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive shadow">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Ошибка редактора .docx: {editorError}</span>
                  </div>
                )}
                {/* CSS-isolation wrapper (`isolation-isolate`) scopes the
                    editor's Word-like styles to this pane. `contain` is
                    deliberately NOT used here — it would clip the template
                    plugin's highlight overlays. */}
                <div ref={editorHostRef} className={cn(EDITOR_CLASS_NAME, 'isolate h-full w-full')}>
                  {documentBuffer ? (
                    <PluginHost ref={pluginHostRef} plugins={plugins} className="h-full w-full">
                      <DocxEditor
                        ref={editorRef}
                        documentBuffer={documentBuffer}
                        mode="editing"
                        showToolbar
                        showRuler
                        documentName={name || 'template.docx'}
                        className="h-full w-full"
                        onChange={() => setDocDirty(true)}
                        onError={(err: Error) =>
                          setEditorError(err.message || 'Не удалось загрузить .docx')
                        }
                      />
                    </PluginHost>
                  ) : (
                    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Загружаем документ…
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </main>

        {/* ---------------------------------------------------------- */}
        {/* Right — tags panel                                         */}
        {/* ---------------------------------------------------------- */}
        <aside className="flex w-[28rem] max-w-[40vw] flex-col bg-muted/20">
          <div className="border-b border-border px-4 py-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Теги шаблона</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Привяжите каждый тег к формуле или объявите его ручным полем.
            </p>
          </div>

          {unboundTags.length > 0 && (
            <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Несвязанных тегов: <strong>{unboundTags.length}</strong>. Они не
                будут заполнены при генерации.
              </span>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3">
            {tags.length === 0 && (
              <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                В исходном .docx не найдено тегов{' '}
                <code className="font-mono">{'{tag}'}</code>.
              </div>
            )}

            <ul className="space-y-2">
              {tagStatuses.map(({ tag, status }) => (
                <TagRow
                  key={tag}
                  tag={tag}
                  status={status}
                  formula={formulasByKey[tag]}
                  field={fieldsByKey[tag]}
                  onBindFormula={() => openFormulaFor(tag)}
                  onBindField={() => openFieldFor(tag)}
                  onRemoveFormula={() => removeFormula(tag)}
                  onRemoveField={() => removeField(tag)}
                />
              ))}
            </ul>

            {orphanBindings.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Привязки без тега в .docx
                </h3>
                <ul className="space-y-2">
                  {orphanBindings.map(({ key, status }) => (
                    <TagRow
                      key={key}
                      tag={key}
                      status={status}
                      orphan
                      formula={formulasByKey[key]}
                      field={fieldsByKey[key]}
                      onBindFormula={() => openFormulaFor(key)}
                      onBindField={() => openFieldFor(key)}
                      onRemoveFormula={() => removeFormula(key)}
                      onRemoveField={() => removeField(key)}
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>
        </aside>
      </div>

      <FormulaBuilder
        open={builderOpen}
        onOpenChange={(open) => {
          setBuilderOpen(open);
          if (!open) {
            setActiveTag(null);
            setInsertMode(false);
          }
        }}
        onInsert={handleConfirmFormula}
        existingKeys={otherFormulaKeys}
        initialValues={formulaInitialValues}
      />

      <ManualFieldBuilder
        open={fieldBuilderOpen}
        onOpenChange={(open) => {
          setFieldBuilderOpen(open);
          if (!open) {
            setActiveTag(null);
            setInsertMode(false);
          }
        }}
        onInsert={handleConfirmField}
        existingKeys={otherFieldKeys}
        initialValues={fieldInitialValues}
      />

      {/* Hover tooltip for `{tag}` pills in the editor (portal to body so it
          escapes the editor's overflow/contain context). */}
      {hoverInfo &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[60] max-w-xs rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
            style={{ top: hoverInfo.top, left: hoverInfo.left }}
          >
            <TagHoverContent
              tag={hoverInfo.tag}
              formula={formulasByKey[hoverInfo.tag]}
              field={fieldsByKey[hoverInfo.tag]}
            />
          </div>,
          document.body,
        )}

      {/* Автоподсказка формулы для похожей строки. `onMouseDown` гасится,
          чтобы клик не сбросил выделение в ProseMirror до вставки. */}
      {suggestion &&
        createPortal(
          <div
            className="fixed z-[60] flex max-w-sm items-center gap-2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
            style={{ top: suggestion.top, left: suggestion.left }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Sigma className="h-3.5 w-3.5 shrink-0 text-blue-600" />
            <span className="shrink-0 text-muted-foreground">Вставить формулу:</span>
            <button
              type="button"
              onClick={() => applySuggestion(suggestion.entry)}
              className="max-w-[12rem] truncate rounded bg-blue-600 px-2 py-0.5 font-medium text-white hover:bg-blue-700"
              title={suggestion.entry.expression}
            >
              {suggestion.entry.label}
            </button>
            <button
              type="button"
              aria-label="Скрыть подсказку"
              onClick={() => setSuggestion(null)}
              className="shrink-0 px-0.5 text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TagHoverContent                                                     */
/* ------------------------------------------------------------------ */

/**
 * Body of the hover tooltip shown over a `{tag}` pill in the editor. Mirrors
 * the old TipTap formula tooltip: shows the tag name and what it resolves to —
 * a formula (label + expression), a manual field (label + type), a reserved
 * product-loop tag, or an unbound warning.
 */
function TagHoverContent({
  tag,
  formula,
  field,
}: {
  tag: string;
  formula?: FormulaInputDTO;
  field?: TemplateFieldInputDTO;
}) {
  const reserved = isReservedTag(tag);
  return (
    <div className="space-y-1">
      <code className="block font-mono text-[12px] font-semibold text-foreground">
        {'{'}
        {tag}
        {'}'}
      </code>
      {formula ? (
        <>
          <div className="font-medium text-blue-700">Σ {formula.label || tag}</div>
          <pre className="mt-0.5 max-w-[16rem] whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground">
            {formula.expression || '—'}
          </pre>
        </>
      ) : field ? (
        <div className="text-emerald-700">
          <span className="font-medium">✎ {field.label || tag}</span>
          {' · '}
          <span className="font-mono">{field.type}</span>
          {field.required && <span className="ml-1 text-amber-700">обязательное</span>}
        </div>
      ) : reserved ? (
        <div className="text-muted-foreground">
          Зарезервированный тег товаров — заполняется автоматически.
        </div>
      ) : (
        <div className="text-amber-700">Тег не связан — привяжите формулу или поле.</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TagRow                                                              */
/* ------------------------------------------------------------------ */

/**
 * A single row in the "Теги шаблона" panel. Shows the tag name, its
 * binding status badge and the relevant actions (bind/edit a formula,
 * declare/edit a manual field, or remove an existing binding). Unbound
 * non-reserved tags are highlighted with an amber border so the admin
 * notices them; reserved product-loop tags are shown muted with no
 * actions because the engine fills them automatically.
 */
function TagRow({
  tag,
  status,
  orphan = false,
  formula,
  field,
  onBindFormula,
  onBindField,
  onRemoveFormula,
  onRemoveField,
}: {
  tag: string;
  status: TagBindingStatus;
  orphan?: boolean;
  formula?: FormulaInputDTO;
  field?: TemplateFieldInputDTO;
  onBindFormula: () => void;
  onBindField: () => void;
  onRemoveFormula: () => void;
  onRemoveField: () => void;
}) {
  const reserved = status === 'reserved' || isReservedTag(tag);

  return (
    <li
      className={cn(
        'rounded-md border bg-background p-2.5 text-xs',
        status === 'unbound' && 'border-amber-300 bg-amber-50/40',
        status === 'formula' && 'border-blue-200',
        status === 'field' && 'border-emerald-200',
        reserved && 'border-border opacity-70',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <code className="truncate font-mono text-[12px] font-medium text-foreground" title={tag}>
          {'{'}
          {tag}
          {'}'}
        </code>
        <StatusBadge status={status} />
      </div>

      {/* Binding detail */}
      {status === 'formula' && formula && (
        <div className="mt-1.5 space-y-0.5">
          <div className="font-medium text-foreground">{formula.label || tag}</div>
          <pre className="whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground">
            {formula.expression || '—'}
          </pre>
        </div>
      )}
      {status === 'field' && field && (
        <div className="mt-1.5 text-muted-foreground">
          <span className="font-medium text-foreground">{field.label || tag}</span>
          {' · '}
          <span className="font-mono">{field.type}</span>
          {field.required && <span className="ml-1 text-amber-700">обязательное</span>}
        </div>
      )}
      {status === 'unbound' && !orphan && (
        <div className="mt-1 text-amber-700">Тег не связан — выберите действие.</div>
      )}
      {reserved && (
        <div className="mt-1 text-muted-foreground">
          Зарезервированный тег товаров — заполняется автоматически.
        </div>
      )}

      {/* Actions */}
      {!reserved && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {status === 'formula' ? (
            <>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onBindFormula}>
                <Pencil className="mr-1 h-3 w-3" />
                Изменить
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs text-destructive"
                onClick={onRemoveFormula}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Удалить
              </Button>
            </>
          ) : status === 'field' ? (
            <>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onBindField}>
                <Pencil className="mr-1 h-3 w-3" />
                Изменить
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs text-destructive"
                onClick={onRemoveField}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Удалить
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onBindFormula}>
                <Sigma className="mr-1 h-3 w-3" />
                Формула
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onBindField}>
                <PenLine className="mr-1 h-3 w-3" />
                Ручное поле
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Small coloured badge describing a tag's binding status. */
function StatusBadge({ status }: { status: TagBindingStatus }) {
  if (status === 'formula') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-inset ring-blue-200">
        <Sigma className="h-2.5 w-2.5" />
        Формула
      </span>
    );
  }
  if (status === 'field') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
        <PenLine className="h-2.5 w-2.5" />
        Ручное поле
      </span>
    );
  }
  if (status === 'reserved') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-inset ring-border">
        <Lock className="h-2.5 w-2.5" />
        Зарезервирован
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-300">
      <Plus className="h-2.5 w-2.5" />
      Не связан
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* DTO ↔ input mappers                                                */
/* ------------------------------------------------------------------ */

/** Translate a FormulaDTO into the FormulaInputDTO sent back on save. */
function formulaDtoToInput(f: FormulaDTO): FormulaInputDTO {
  return {
    id: f.id,
    tagKey: f.tagKey,
    label: f.label,
    expression: f.expression,
    dependsOn: f.dependsOn,
  };
}

/** Translate a TemplateFieldDTO into the input shape sent on save. */
function fieldDtoToInput(f: TemplateFieldDTO): TemplateFieldInputDTO {
  return {
    id: f.id,
    fieldKey: f.fieldKey,
    label: f.label,
    type: f.type,
    required: f.required,
    placeholder: f.placeholder ?? '',
    defaultValue: f.defaultValue ?? '',
    options: f.options,
    valueMode: f.valueMode,
    order: f.order,
  };
}
