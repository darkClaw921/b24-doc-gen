/**
 * FormulaBuilder — modal dialog that walks an admin through creating
 * or editing a template formula.
 *
 * Sections in the dialog body:
 *  1. A labelled text input for the formula's human-readable name.
 *     Editing it updates the `tagKey` suggestion (slugified via
 *     `generateTagKey`, with the existing template-level keys taken
 *     into account to avoid collisions).
 *  2. A monospace `<textarea>` for the mathjs expression. The caret
 *     position is tracked with a ref so field/operator/function
 *     clicks can splice tokens in place.
 *  3. `FieldPicker` for inserting `DEAL.X`/`CONTACT.Y`/`COMPANY.Z`
 *     tokens — clicking a field appends it to the expression at the
 *     caret.
 *  4. Two button palettes:
 *       - operators: + - * / ( ) , == != > < >= <= ? :
 *       - helper functions with parameter hints inside parentheses.
 *  5. Live validation: synchronous check runs on every change, and a
 *     debounced remote validator hits `POST /api/formulas/validate`
 *     500 ms after the user stops typing. Errors are shown under the
 *     textarea; the "Вставить" button is disabled while any error is
 *     active.
 *  6. Optional preview pane that shows the evaluated value when the
 *     caller provides a `testDealId` — the component fires
 *     `POST /api/formulas/evaluate` against that deal id.
 *
 * Submission:
 *  - On "Вставить" the component calls `onInsert({ tagKey, label,
 *    expression, dependsOn })` and the caller is responsible for
 *    inserting a `FormulaTag` node + adding the formula to the
 *    template's formulas array.
 *  - "Отмена" simply closes the dialog without calling onInsert.
 *
 * Prop shape:
 *  - `open` / `onOpenChange` — controlled state following the
 *    shadcn/ui Dialog convention.
 *  - `existingKeys` — array of tagKeys already used inside the
 *    current template, used to keep new keys unique.
 *  - `initialValues` — when editing an existing formula the caller
 *    passes the current label/expression; when creating a new one
 *    this is undefined.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Play } from 'lucide-react';
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
import { FieldPicker } from './FieldPicker';
import { RichTooltip } from '@/components/ui/RichTooltip';
import { HELPER_DOCS, OPERATOR_DOCS, type HelperDoc } from '@/lib/formulaHelp';
import {
  validateLocally,
  validateRemote,
  generateTagKey,
  type LocalValidationResult,
  type FormulaDependencies,
} from '@/lib/formulas';
import { formulasApi } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface FormulaBuilderResult {
  tagKey: string;
  label: string;
  expression: string;
  dependsOn: FormulaDependencies;
}

export interface FormulaBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called when the admin hits "Вставить". Receives the assembled
   * formula. The dialog closes automatically after this fires.
   */
  onInsert: (result: FormulaBuilderResult) => void;
  /** Tag keys already used in the current template (for uniqueness). */
  existingKeys: ReadonlyArray<string>;
  /** When editing, seed the form with these values. */
  initialValues?: Partial<FormulaBuilderResult>;
  /** Optional deal id to enable the live preview panel. */
  testDealId?: number | null;
}

/* ------------------------------------------------------------------ */
/* Operator + function palettes                                        */
/* ------------------------------------------------------------------ */

const OPERATORS: Array<{ label: string; insert: string; cursorDelta?: number }> = [
  { label: '+', insert: ' + ' },
  { label: '-', insert: ' - ' },
  { label: '*', insert: ' * ' },
  { label: '/', insert: ' / ' },
  { label: '(', insert: '(' },
  { label: ')', insert: ')' },
  { label: ',', insert: ', ' },
  { label: '==', insert: ' == ' },
  { label: '!=', insert: ' != ' },
  { label: '>', insert: ' > ' },
  { label: '<', insert: ' < ' },
  { label: '>=', insert: ' >= ' },
  { label: '<=', insert: ' <= ' },
];

interface HelperDescriptor {
  name: string;
  insert: string;
  /** Caret offset from the inserted snippet's start (cursor lands inside). */
  cursorOffset: number;
}

/**
 * Snippet-карта функций. Описания/сигнатуры/примеры берутся из общего
 * справочника `HELPER_DOCS` (lib/formulaHelp.ts), здесь хранится только
 * шаблон вставки и смещение каретки.
 */
const HELPERS: HelperDescriptor[] = [
  { name: 'if', insert: 'if(, , )', cursorOffset: 3 },
  { name: 'concat', insert: 'concat()', cursorOffset: 7 },
  { name: 'format', insert: 'format(, "0.00")', cursorOffset: 7 },
  { name: 'dateFormat', insert: 'dateFormat(, "dd.MM.yyyy")', cursorOffset: 11 },
  { name: 'upper', insert: 'upper()', cursorOffset: 6 },
  { name: 'lower', insert: 'lower()', cursorOffset: 6 },
];

/**
 * Содержимое всплывающей подсказки для функции — рендерится один раз
 * на каждую кнопку палитры. Для пилюль формул в редакторе используется
 * та же разметка, поэтому компонент экспортируется ниже.
 */
function HelperTooltipContent({ doc }: { doc: HelperDoc }) {
  return (
    <div className="space-y-1.5">
      <div className="font-mono text-[12px] font-semibold text-foreground">
        {doc.signature}
      </div>
      <div className="text-[11px] text-muted-foreground">{doc.description}</div>
      {doc.args.length > 0 && (
        <div className="pt-1">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Аргументы
          </div>
          <ul className="space-y-0.5">
            {doc.args.map((a) => (
              <li key={a.name} className="text-[11px]">
                <code className="font-mono text-[11px] text-foreground">{a.name}</code>
                <span className="text-muted-foreground"> — {a.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {doc.examples.length > 0 && (
        <div className="pt-1">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Пример
          </div>
          {doc.examples.map((ex) => (
            <pre
              key={ex}
              className="whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground"
            >
              {ex}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

export { HelperTooltipContent };

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function FormulaBuilder({
  open,
  onOpenChange,
  onInsert,
  existingKeys,
  initialValues,
  testDealId,
}: FormulaBuilderProps) {
  const [label, setLabel] = useState(initialValues?.label ?? '');
  const [tagKey, setTagKey] = useState(initialValues?.tagKey ?? '');
  /** Track whether the user manually edited the tagKey. */
  const [tagKeyDirty, setTagKeyDirty] = useState(false);
  const [expression, setExpression] = useState(initialValues?.expression ?? '');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [localResult, setLocalResult] = useState<LocalValidationResult>(() =>
    validateLocally(initialValues?.expression ?? ''),
  );
  const [remoteResult, setRemoteResult] = useState<LocalValidationResult | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);

  // Reset form whenever the dialog is re-opened with new values.
  useEffect(() => {
    if (!open) return;
    setLabel(initialValues?.label ?? '');
    setTagKey(
      initialValues?.tagKey ?? generateTagKey(initialValues?.label ?? '', existingKeys),
    );
    setTagKeyDirty(false);
    setExpression(initialValues?.expression ?? '');
    setLocalResult(validateLocally(initialValues?.expression ?? ''));
    setRemoteResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialValues?.label, initialValues?.tagKey, initialValues?.expression]);

  // Debounced remote validation (500 ms).
  useEffect(() => {
    if (!expression.trim()) {
      setRemoteResult(null);
      return;
    }
    // Short-circuit when local already failed.
    const local = validateLocally(expression);
    setLocalResult(local);
    if (!local.valid) {
      setRemoteResult(null);
      return;
    }

    let cancelled = false;
    setRemoteLoading(true);
    const timer = setTimeout(() => {
      validateRemote(expression)
        .then((res) => {
          if (!cancelled) {
            setRemoteResult(res);
            setRemoteLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) setRemoteLoading(false);
        });
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [expression]);

  // Regenerate the tagKey suggestion when the label changes, unless
  // the user explicitly edited the key.
  useEffect(() => {
    if (tagKeyDirty) return;
    setTagKey(generateTagKey(label, existingKeys));
  }, [label, existingKeys, tagKeyDirty]);

  /* -------------------------- insertion ------------------------ */

  const insertAtCaret = useCallback(
    (snippet: string, cursorOffset?: number) => {
      const ta = textareaRef.current;
      if (!ta) {
        setExpression((prev) => prev + snippet);
        return;
      }
      const start = ta.selectionStart ?? expression.length;
      const end = ta.selectionEnd ?? expression.length;
      const before = expression.slice(0, start);
      const after = expression.slice(end);
      const next = before + snippet + after;
      setExpression(next);
      // Restore caret after React flushes state.
      const caret = start + (cursorOffset ?? snippet.length);
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(caret, caret);
      });
    },
    [expression],
  );

  const handleFieldSelect = useCallback(
    (token: string) => {
      insertAtCaret(token);
    },
    [insertAtCaret],
  );

  const handleOperator = useCallback(
    (snippet: string) => insertAtCaret(snippet),
    [insertAtCaret],
  );

  const handleHelper = useCallback(
    (h: HelperDescriptor) => insertAtCaret(h.insert, h.cursorOffset),
    [insertAtCaret],
  );

  /* -------------------------- preview -------------------------- */

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewValue, setPreviewValue] = useState<string | null>(null);

  const runPreview = useCallback(async () => {
    if (!testDealId || !expression.trim()) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewValue(null);
    try {
      const res = await formulasApi.evaluate({ expression, dealId: testDealId });
      if (res.error) {
        setPreviewError(res.error);
      } else {
        setPreviewValue(res.value);
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [expression, testDealId]);

  /* -------------------------- derived -------------------------- */

  const activeError =
    !localResult.valid
      ? localResult.error
      : remoteResult && !remoteResult.valid
        ? remoteResult.error
        : null;
  const isValid = localResult.valid && (!remoteResult || remoteResult.valid);
  const canSubmit =
    isValid && label.trim().length > 0 && tagKey.trim().length > 0 && expression.trim().length > 0;
  const dependencies: FormulaDependencies =
    remoteResult?.dependencies ?? { deal: [], contact: [], company: [] };

  const handleSubmit = () => {
    if (!canSubmit) return;
    onInsert({
      tagKey: tagKey.trim(),
      label: label.trim(),
      expression: expression.trim(),
      dependsOn: dependencies,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Конструктор формулы</DialogTitle>
          <DialogDescription>
            Постройте выражение mathjs, используя поля сделки, операторы и функции.
            Результат будет вставлен в шаблон как тег Σ {label || 'label'}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Left column: label, tagKey, expression, palettes */}
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-sm font-medium">Название формулы</label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Например: НДС (20%)"
                className="mt-1"
              />
            </div>

            <div>
              <label className="text-sm font-medium">Ключ тега (tagKey)</label>
              <Input
                value={tagKey}
                onChange={(e) => {
                  setTagKey(e.target.value);
                  setTagKeyDirty(true);
                }}
                placeholder="nds_20"
                className="mt-1 font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Используется как data-formula-key в HTML шаблона.
              </p>
            </div>

            <div>
              <label className="text-sm font-medium">Выражение</label>
              <textarea
                ref={textareaRef}
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                rows={6}
                spellCheck={false}
                className={cn(
                  'mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm',
                  'focus:outline-none focus:ring-2 focus:ring-ring',
                  activeError && 'border-destructive',
                )}
                placeholder="DEAL.OPPORTUNITY * 0.2"
              />
              {/* Validation status */}
              <div className="mt-2 flex items-center gap-2 text-xs">
                {remoteLoading ? (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Проверяем…
                  </span>
                ) : activeError ? (
                  <span className="flex items-center gap-1 text-destructive">
                    <AlertCircle className="h-3 w-3" />
                    {activeError}
                  </span>
                ) : isValid && expression.trim() ? (
                  <span className="flex items-center gap-1 text-emerald-600">
                    <CheckCircle2 className="h-3 w-3" />
                    Формула корректна
                  </span>
                ) : (
                  <span className="text-muted-foreground">Введите выражение</span>
                )}
              </div>
            </div>

            {/* Operators palette */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Операторы</label>
              <div className="mt-1 flex flex-wrap gap-1">
                {OPERATORS.map((op) => {
                  const doc = OPERATOR_DOCS[op.label];
                  return (
                    <RichTooltip
                      key={op.label}
                      content={
                        <div className="space-y-0.5">
                          <div className="font-mono text-[12px] font-semibold">
                            {op.label}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {doc?.summary ?? 'Оператор выражения.'}
                          </div>
                        </div>
                      }
                    >
                      <button
                        type="button"
                        onClick={() => handleOperator(op.insert)}
                        className="h-7 rounded-md border border-input bg-background px-2 font-mono text-xs hover:bg-muted"
                      >
                        {op.label}
                      </button>
                    </RichTooltip>
                  );
                })}
              </div>
            </div>

            {/* Helpers palette */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Функции</label>
              <div className="mt-1 flex flex-wrap gap-1">
                {HELPERS.map((h) => {
                  const doc = HELPER_DOCS[h.name];
                  return (
                    <RichTooltip
                      key={h.name}
                      content={
                        doc ? (
                          <HelperTooltipContent doc={doc} />
                        ) : (
                          <div className="font-mono text-[11px]">{h.name}()</div>
                        )
                      }
                    >
                      <button
                        type="button"
                        onClick={() => handleHelper(h)}
                        className="h-7 rounded-md border border-input bg-background px-2 font-mono text-xs hover:bg-muted"
                      >
                        {h.name}
                      </button>
                    </RichTooltip>
                  );
                })}
              </div>
            </div>

            {/* Preview panel */}
            {testDealId ? (
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Предпросмотр (сделка #{testDealId})
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={runPreview}
                    disabled={previewLoading || !isValid || !expression.trim()}
                  >
                    {previewLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                    <span className="ml-1">Вычислить</span>
                  </Button>
                </div>
                {previewValue != null && (
                  <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-background px-2 py-1 text-xs">
                    {previewValue}
                  </pre>
                )}
                {previewError && (
                  <p className="mt-2 text-xs text-destructive">{previewError}</p>
                )}
              </div>
            ) : null}
          </div>

          {/* Right column: field picker */}
          <div className="flex flex-col">
            <label className="text-sm font-medium">Поля</label>
            <FieldPicker onSelect={handleFieldSelect} className="mt-1" />
            {dependencies &&
              (dependencies.deal.length > 0 ||
                dependencies.contact.length > 0 ||
                dependencies.company.length > 0) && (
                <div className="mt-3 rounded-md border border-border bg-muted/30 p-2 text-xs">
                  <div className="mb-1 font-medium text-muted-foreground">
                    Зависимости:
                  </div>
                  <DepList title="DEAL" items={dependencies.deal} />
                  <DepList title="CONTACT" items={dependencies.contact} />
                  <DepList title="COMPANY" items={dependencies.company} />
                </div>
              )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            Вставить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DepList({ title, items }: { title: string; items: ReadonlyArray<string> }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="font-mono text-[10px] uppercase text-muted-foreground">{title}:</span>
      {items.map((code) => (
        <code key={code} className="rounded bg-background px-1 py-0.5 font-mono text-[10px]">
          {code}
        </code>
      ))}
    </div>
  );
}
