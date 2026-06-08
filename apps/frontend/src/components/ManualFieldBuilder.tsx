/**
 * ManualFieldBuilder — modal dialog for creating or editing a manual
 * field that the user fills in at generation time.
 *
 * Mirrors {@link FormulaBuilder}'s prop convention (controlled
 * open/onOpenChange, `existingKeys` for uniqueness, `initialValues` for
 * edit mode) but is far simpler: a manual field has no expression, only
 * metadata — label, key, type, required flag and an optional
 * placeholder hint.
 *
 * Sections:
 *  1. Label — human-readable name. Editing it auto-updates the field
 *     key suggestion (slugified via `generateTagKey`, kept unique
 *     against `existingKeys`) until the admin edits the key manually.
 *  2. Field key — the stable identifier referenced from the document.
 *  3. Type — text | textarea | number | date.
 *  4. Required — checkbox.
 *  5. Placeholder — optional hint shown inside the empty input at
 *     generation time.
 *
 * On "Вставить" the component calls `onInsert(result)` and the caller
 * adds/updates the field in the template's `fields[]` array. Placement
 * is owned by the original `.docx`: the admin types the `{fieldKey}`
 * placeholder into Word and `buildDocxFromTemplate` substitutes the
 * value entered at generation time (no in-editor node is inserted).
 */

import { useEffect, useState } from 'react';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
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
import { generateTagKey } from '@/lib/formulas';
import type { SelectOptionDTO, SelectValueModeDTO, TemplateFieldTypeDTO } from '@/lib/api';

export interface ManualFieldBuilderResult {
  fieldKey: string;
  label: string;
  type: TemplateFieldTypeDTO;
  required: boolean;
  placeholder: string;
  /** Default-value token (e.g. "today" for date fields), or "" for none.
   * For `select` fields this is the label of the pre-selected option. */
  defaultValue: string;
  /** Choices for a `select` field; empty for other types. */
  options: SelectOptionDTO[];
  /** Substitution mode for a `select` field; "direct" for other types. */
  valueMode: SelectValueModeDTO;
}

export interface ManualFieldBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the admin hits "Вставить". The dialog closes after. */
  onInsert: (result: ManualFieldBuilderResult) => void;
  /** Field keys already used in the current template (for uniqueness). */
  existingKeys: ReadonlyArray<string>;
  /** When editing, seed the form with these values. */
  initialValues?: Partial<ManualFieldBuilderResult>;
}

const TYPE_OPTIONS: Array<{ value: TemplateFieldTypeDTO; label: string }> = [
  { value: 'text', label: 'Текст (одна строка)' },
  { value: 'textarea', label: 'Текст (много строк)' },
  { value: 'number', label: 'Число' },
  { value: 'date', label: 'Дата' },
  { value: 'select', label: 'Выпадающий список' },
];

/**
 * Parse a pasted block of text into `select` options — one per non-empty
 * line.
 *
 * When `splitValue` is true (`mapped` mode) each line is split into a label
 * and a value by the FIRST tab or run of 2+ spaces: the part before is the
 * label (shown to the user), the part after is the value (substituted into
 * the document). A line with no such separator becomes a label-only option.
 *
 * When `splitValue` is false (`direct` mode) the whole line is the option —
 * no splitting, so values that contain double spaces stay intact.
 *
 * Example (mapped): `ПАО СК «Росгосстрах»\t600020 г.Владимир, ул.Михайловская`
 * → { label: 'ПАО СК «Росгосстрах»', value: '600020 г.Владимир, ул.Михайловская' }
 */
export function parseBulkOptions(text: string, splitValue: boolean): SelectOptionDTO[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (!splitValue) return { label: line, value: '' };
      const m = /^(.*?)(?:\t+|\s{2,})(.+)$/.exec(line);
      return m
        ? { label: m[1].trim(), value: m[2].trim() }
        : { label: line, value: '' };
    })
    .filter((o) => o.label.length > 0);
}

export function ManualFieldBuilder({
  open,
  onOpenChange,
  onInsert,
  existingKeys,
  initialValues,
}: ManualFieldBuilderProps) {
  const [label, setLabel] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [type, setType] = useState<TemplateFieldTypeDTO>('text');
  const [required, setRequired] = useState(false);
  const [placeholder, setPlaceholder] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  // `select`-only state: the list of choices and how they map to the
  // substituted value.
  const [options, setOptions] = useState<SelectOptionDTO[]>([]);
  const [valueMode, setValueMode] = useState<SelectValueModeDTO>('direct');
  // Scratch text for the "paste a list" bulk-add box.
  const [bulkText, setBulkText] = useState('');
  // Once the admin edits the key by hand we stop auto-suggesting it.
  const [keyDirty, setKeyDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = Boolean(initialValues);

  // Re-seed the form every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setLabel(initialValues?.label ?? '');
    setFieldKey(initialValues?.fieldKey ?? '');
    setType(initialValues?.type ?? 'text');
    setRequired(initialValues?.required ?? false);
    setPlaceholder(initialValues?.placeholder ?? '');
    setDefaultValue(initialValues?.defaultValue ?? '');
    setOptions(initialValues?.options ?? []);
    setValueMode(initialValues?.valueMode ?? 'direct');
    setBulkText('');
    setKeyDirty(Boolean(initialValues?.fieldKey));
    setError(null);
  }, [open, initialValues]);

  /* ---- select-option editing helpers ---- */
  const addOption = () => setOptions((prev) => [...prev, { label: '', value: '' }]);
  const removeOption = (index: number) =>
    setOptions((prev) => prev.filter((_, i) => i !== index));
  const updateOption = (index: number, patch: Partial<SelectOptionDTO>) =>
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  /** Parse the bulk-paste box and append new options (dedup by label). */
  const addBulkOptions = () => {
    const parsed = parseBulkOptions(bulkText, valueMode === 'mapped');
    if (parsed.length === 0) return;
    setOptions((prev) => {
      // Drop empty placeholder rows (e.g. the seed row from switching to
      // `select`); the bulk paste always yields ≥1 real option.
      const kept = prev.filter((o) => o.label.trim().length > 0);
      const seen = new Set(kept.map((o) => o.label.trim()));
      const merged = [...kept];
      for (const o of parsed) {
        if (seen.has(o.label)) continue;
        seen.add(o.label);
        merged.push(o);
      }
      return merged;
    });
    setBulkText('');
  };

  const handleLabelChange = (value: string) => {
    setLabel(value);
    if (!keyDirty) {
      setFieldKey(generateTagKey(value, existingKeys));
    }
  };

  const handleKeyChange = (value: string) => {
    setKeyDirty(true);
    // Keep the key in the same slug shape the backend expects.
    setFieldKey(value.replace(/[^a-zA-Z0-9_]/g, '_'));
  };

  const handleSubmit = () => {
    const trimmedLabel = label.trim();
    const trimmedKey = fieldKey.trim();
    if (!trimmedLabel) {
      setError('Введите название поля');
      return;
    }
    if (!trimmedKey) {
      setError('Введите ключ поля');
      return;
    }
    if (existingKeys.includes(trimmedKey)) {
      setError(`Ключ "${trimmedKey}" уже используется в этом шаблоне`);
      return;
    }
    // For `select` fields: keep only options with a non-empty label and
    // require at least one.
    let cleanOptions: SelectOptionDTO[] = [];
    if (type === 'select') {
      cleanOptions = options
        .map((o) => ({ label: o.label.trim(), value: o.value.trim() }))
        .filter((o) => o.label.length > 0);
      if (cleanOptions.length === 0) {
        setError('Добавьте хотя бы один вариант списка');
        return;
      }
    }
    // Keep the default only if it still matches one of the options.
    const trimmedDefault = defaultValue.trim();
    const resolvedDefault =
      type === 'select'
        ? cleanOptions.some((o) => o.label === trimmedDefault)
          ? trimmedDefault
          : ''
        : trimmedDefault;
    onInsert({
      fieldKey: trimmedKey,
      label: trimmedLabel,
      type,
      required,
      placeholder: placeholder.trim(),
      // For date this is a token ("today"); for select the label of the
      // pre-selected option; for other types a literal value the user can
      // edit at generation time.
      defaultValue: resolvedDefault,
      options: cleanOptions,
      valueMode: type === 'select' ? valueMode : 'direct',
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-md flex-col">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Изменить поле' : 'Поле для ручного заполнения'}
          </DialogTitle>
          <DialogDescription>
            Это поле пользователь заполнит вручную при генерации документа.
          </DialogDescription>
        </DialogHeader>

        <div className="-mr-2 min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Название</label>
            <Input
              value={label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="Например: Номер договора"
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Ключ поля</label>
            <Input
              value={fieldKey}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder="nomer_dogovora"
              className="font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Латиница, цифры и «_». Используется внутри шаблона.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Тип</label>
            <select
              value={type}
              onChange={(e) => {
                const nextType = e.target.value as TemplateFieldTypeDTO;
                setType(nextType);
                // The meaning of defaultValue differs per type (token vs
                // literal vs option label), so reset it when the type changes.
                setDefaultValue('');
                // Seed an empty option row when switching to `select` so the
                // admin has something to start editing.
                if (nextType === 'select') {
                  setOptions((prev) => (prev.length > 0 ? prev : [{ label: '', value: '' }]));
                  setValueMode('direct');
                }
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {type === 'select' && (
            <div className="space-y-3 rounded-md border border-input bg-muted/30 p-3">
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Режим подстановки
                </label>
                <select
                  value={valueMode}
                  onChange={(e) => setValueMode(e.target.value as SelectValueModeDTO)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="direct">Подставлять выбранное значение</option>
                  <option value="mapped">Сопоставить со значением</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {valueMode === 'mapped'
                    ? 'Пользователь выбирает вариант, а в документ подставляется сопоставленное ему значение.'
                    : 'В документ подставляется ровно тот вариант, который выбрал пользователь.'}
                </p>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-sm font-medium">Варианты</label>
                  <Button type="button" variant="outline" size="sm" onClick={addOption}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Добавить
                  </Button>
                </div>
                {options.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Нет вариантов — добавьте первый.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {valueMode === 'mapped' && (
                      <div className="flex gap-2 px-0.5 text-[11px] text-muted-foreground">
                        <span className="flex-1">Что видит пользователь</span>
                        <span className="flex-1">Что подставится</span>
                        <span className="w-8 shrink-0" />
                      </div>
                    )}
                    {options.map((opt, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Input
                          value={opt.label}
                          onChange={(e) => updateOption(idx, { label: e.target.value })}
                          placeholder="Вариант"
                          className="flex-1"
                        />
                        {valueMode === 'mapped' && (
                          <Input
                            value={opt.value}
                            onChange={(e) => updateOption(idx, { value: e.target.value })}
                            placeholder="Значение"
                            className="flex-1"
                          />
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeOption(idx)}
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                          aria-label="Удалить вариант"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-3 border-t border-input pt-3">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Вставить списком
                  </label>
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    rows={3}
                    placeholder={
                      valueMode === 'mapped'
                        ? 'Название    Значение\n(по строке на вариант)'
                        : 'Вариант 1\nВариант 2\nВариант 3'
                    }
                    className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="mt-1 flex items-start justify-between gap-2">
                    <p className="text-[11px] text-muted-foreground">
                      Каждая строка — вариант.
                      {valueMode === 'mapped'
                        ? ' Название и значение разделяйте Tab или 2+ пробелами.'
                        : ''}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addBulkOptions}
                      disabled={bulkText.trim().length === 0}
                    >
                      Разобрать
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-sm font-medium">
              Значение по умолчанию
            </label>
            {type === 'select' ? (
              <select
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Не задано</option>
                {options
                  .filter((o) => o.label.trim().length > 0)
                  .map((o, idx) => (
                    <option key={idx} value={o.label.trim()}>
                      {o.label.trim()}
                    </option>
                  ))}
              </select>
            ) : type === 'date' ? (
              <select
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Не задано</option>
                <option value="today">Сегодня (текущая дата)</option>
              </select>
            ) : type === 'textarea' ? (
              <textarea
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                rows={2}
                placeholder="Необязательно"
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            ) : (
              <Input
                type={type === 'number' ? 'number' : 'text'}
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                placeholder="Необязательно"
              />
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Подставится при генерации; пользователь сможет изменить.
            </p>
          </div>

          {type !== 'select' && (
            <div>
              <label className="mb-1 block text-sm font-medium">
                Подсказка (placeholder)
              </label>
              <Input
                value={placeholder}
                onChange={(e) => setPlaceholder(e.target.value)}
                placeholder="Необязательно"
              />
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
            />
            Обязательное поле
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button onClick={handleSubmit}>
            {isEditing ? 'Сохранить' : 'Вставить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ManualFieldBuilder;
