/**
 * SelectOptionsEditor — the reusable editor for a `select` field's value
 * mapping: the substitution-mode selector, the per-row option list and
 * the "paste a list" bulk-add box.
 *
 * Extracted from {@link ManualFieldBuilder} so the exact same UI can be
 * reused when an admin defines a reusable preset in the Settings page
 * (see `fieldPresetsApi`). The component is fully controlled — it owns no
 * option state, only the scratch text of the bulk-paste box.
 *
 * Props:
 *  - `valueMode` / `onValueModeChange` — `direct` substitutes the chosen
 *    label as-is; `mapped` substitutes the option's paired value.
 *  - `options` / `onOptionsChange` — the `{ label, value }[]` list.
 *  - `showModeSelector` — hide the mode dropdown when the parent renders
 *    its own (defaults to true).
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { parseBulkOptions, mergeParsedOptions } from '@/lib/selectOptions';
import type { SelectOptionDTO, SelectValueModeDTO } from '@/lib/api';

export { parseBulkOptions } from '@/lib/selectOptions';

export interface SelectOptionsEditorProps {
  valueMode: SelectValueModeDTO;
  onValueModeChange: (mode: SelectValueModeDTO) => void;
  options: SelectOptionDTO[];
  onOptionsChange: (options: SelectOptionDTO[]) => void;
  /** Render the substitution-mode dropdown (default true). */
  showModeSelector?: boolean;
}

export function SelectOptionsEditor({
  valueMode,
  onValueModeChange,
  options,
  onOptionsChange,
  showModeSelector = true,
}: SelectOptionsEditorProps) {
  // Scratch text for the "paste a list" bulk-add box.
  const [bulkText, setBulkText] = useState('');

  const addOption = () => onOptionsChange([...options, { label: '', value: '' }]);
  const removeOption = (index: number) =>
    onOptionsChange(options.filter((_, i) => i !== index));
  const updateOption = (index: number, patch: Partial<SelectOptionDTO>) =>
    onOptionsChange(options.map((o, i) => (i === index ? { ...o, ...patch } : o)));

  /** Parse the bulk-paste box and append new options (dedup by label). */
  const addBulkOptions = () => {
    const parsed = parseBulkOptions(bulkText, valueMode === 'mapped');
    if (parsed.length === 0) return;
    onOptionsChange(mergeParsedOptions(options, parsed));
    setBulkText('');
  };

  return (
    <div className="space-y-3 rounded-md border border-input bg-muted/30 p-3">
      {showModeSelector && (
        <div>
          <label className="mb-1 block text-sm font-medium">Режим подстановки</label>
          <select
            value={valueMode}
            onChange={(e) => onValueModeChange(e.target.value as SelectValueModeDTO)}
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
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-sm font-medium">Варианты</label>
          <Button type="button" variant="outline" size="sm" onClick={addOption}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Добавить
          </Button>
        </div>
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">Нет вариантов — добавьте первый.</p>
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
  );
}

export default SelectOptionsEditor;
