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
 * inserts/updates a ManualFieldTag node plus the field metadata.
 */

import { useEffect, useState } from 'react';
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
import type { TemplateFieldTypeDTO } from '@/lib/api';

export interface ManualFieldBuilderResult {
  fieldKey: string;
  label: string;
  type: TemplateFieldTypeDTO;
  required: boolean;
  placeholder: string;
  /** Default-value token (e.g. "today" for date fields), or "" for none. */
  defaultValue: string;
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
    setKeyDirty(Boolean(initialValues?.fieldKey));
    setError(null);
  }, [open, initialValues]);

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
    onInsert({
      fieldKey: trimmedKey,
      label: trimmedLabel,
      type,
      required,
      placeholder: placeholder.trim(),
      // For date this is a token ("today"); for other types it is a
      // literal value the user can edit at generation time.
      defaultValue: defaultValue.trim(),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Изменить поле' : 'Поле для ручного заполнения'}
          </DialogTitle>
          <DialogDescription>
            Это поле пользователь заполнит вручную при генерации документа.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
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
                setType(e.target.value as TemplateFieldTypeDTO);
                // The meaning of defaultValue differs per type (token vs
                // literal), so reset it when the type changes.
                setDefaultValue('');
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

          <div>
            <label className="mb-1 block text-sm font-medium">
              Значение по умолчанию
            </label>
            {type === 'date' ? (
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
