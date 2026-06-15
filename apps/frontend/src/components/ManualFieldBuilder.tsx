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
 *  3. Type — text | textarea | number | date | select. For `select`
 *     the admin can pick a reusable preset (defined in Settings via
 *     `fieldPresetsApi`) to seed the options + value mapping, or edit
 *     them inline via the shared `SelectOptionsEditor`.
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
import { useQuery } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
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
import { SelectOptionsEditor } from '@/components/SelectOptionsEditor';
import {
  fieldPresetsApi,
  type SelectOptionDTO,
  type SelectValueModeDTO,
  type TemplateFieldTypeDTO,
} from '@/lib/api';

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
  // Currently applied preset id (or '' when the list is custom/manual).
  const [presetId, setPresetId] = useState('');
  // Once the admin edits the key by hand we stop auto-suggesting it.
  const [keyDirty, setKeyDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = Boolean(initialValues);

  // Reusable select presets defined by an admin in Settings. Loaded only
  // while the dialog is open so the picker stays fresh.
  const presetsQuery = useQuery({
    queryKey: ['field-presets'],
    queryFn: () => fieldPresetsApi.list(),
    enabled: open,
    staleTime: 60 * 1000,
  });
  const presets = presetsQuery.data?.presets ?? [];

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
    setPresetId('');
    setKeyDirty(Boolean(initialValues?.fieldKey));
    setError(null);
  }, [open, initialValues]);

  /** Apply a saved preset: seed options + valueMode from it. */
  const applyPreset = (id: string) => {
    setPresetId(id);
    if (!id) return;
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setValueMode(preset.valueMode);
    setOptions(preset.options.map((o) => ({ ...o })));
    // The preset only seeds the option list; the pre-selected default may
    // no longer be valid, so reset it.
    setDefaultValue('');
  };

  // Editing the options manually detaches the field from its preset.
  const handleOptionsChange = (next: SelectOptionDTO[]) => {
    setOptions(next);
    setPresetId('');
  };
  const handleValueModeChange = (mode: SelectValueModeDTO) => {
    setValueMode(mode);
    setPresetId('');
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
            <div className="space-y-3">
              {/* Reusable preset picker — saved in Settings, reused here. */}
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Сохранённый список
                </label>
                <select
                  value={presetId}
                  onChange={(e) => applyPreset(e.target.value)}
                  disabled={presetsQuery.isLoading || presets.length === 0}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                >
                  <option value="">
                    {presetsQuery.isLoading
                      ? 'Загрузка списков…'
                      : presets.length === 0
                        ? 'Нет сохранённых списков'
                        : '— Свой список —'}
                  </option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.options.length})
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Выберите готовый список из настроек, чтобы не вводить варианты
                  заново. Можно отредактировать варианты ниже — список станет
                  «своим».
                </p>
              </div>

              <SelectOptionsEditor
                valueMode={valueMode}
                onValueModeChange={handleValueModeChange}
                options={options}
                onOptionsChange={handleOptionsChange}
              />
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
