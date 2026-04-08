/**
 * FieldPicker — a three-tabbed picker for CRM fields.
 *
 * Used inside `FormulaBuilder` to let admins drop a field reference
 * (`DEAL.OPPORTUNITY`, `CONTACT.NAME`, `COMPANY.UF_CRM_INN`, …) into
 * the expression editor without memorising internal codes.
 *
 * Data flow:
 *  - Loads the field schemas for all three entities (Deal, Contact,
 *    Company) from `GET /api/crm/fields` via TanStack Query. The
 *    response is cached per portal on the backend for 5 min.
 *  - Displays three tabs (Сделка / Контакт / Компания) populated from
 *    the query result. A search box on top filters by code or title
 *    inside the active tab.
 *  - Clicking a field invokes `onSelect(token)` with the fully
 *    qualified identifier (`DEAL.CODE`) — the caller is free to
 *    append it to the formula expression.
 *
 * UI primitives:
 *  - Tabs from `components/ui/tabs.tsx` (radix-based).
 *  - Input from `components/ui/input.tsx`.
 *
 * This component is dumb about selection state — it is a command
 * palette, not a multi-select. `FormulaBuilder` owns the expression
 * string and decides where to insert the token.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, AlertCircle } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { crmApi, type CrmFieldDTO, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

export type FieldPickerEntity = 'DEAL' | 'CONTACT' | 'COMPANY';

export interface FieldPickerProps {
  /**
   * Called with the fully qualified token (`DEAL.OPPORTUNITY`) the
   * user picked. The parent is responsible for inserting it.
   */
  onSelect: (token: string, field: CrmFieldDTO, entity: FieldPickerEntity) => void;
  /** Optional extra CSS class for the wrapper. */
  className?: string;
  /** Initial active tab. Defaults to DEAL. */
  defaultEntity?: FieldPickerEntity;
}

const ENTITY_LABELS: Record<FieldPickerEntity, string> = {
  DEAL: 'Сделка',
  CONTACT: 'Контакт',
  COMPANY: 'Компания',
};

export function FieldPicker({
  onSelect,
  className,
  defaultEntity = 'DEAL',
}: FieldPickerProps) {
  const [activeEntity, setActiveEntity] = useState<FieldPickerEntity>(defaultEntity);
  const [search, setSearch] = useState('');

  const fieldsQuery = useQuery({
    queryKey: ['crm', 'fields'],
    queryFn: () => crmApi.allFields(),
    staleTime: 5 * 60 * 1000,
  });

  const currentFields: CrmFieldDTO[] = useMemo(() => {
    if (!fieldsQuery.data) return [];
    if (activeEntity === 'DEAL') return fieldsQuery.data.deal;
    if (activeEntity === 'CONTACT') return fieldsQuery.data.contact;
    return fieldsQuery.data.company;
  }, [fieldsQuery.data, activeEntity]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const items = [...currentFields].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    if (!q) return items;
    return items.filter(
      (f) =>
        f.code.toLowerCase().includes(q) ||
        f.title.toLowerCase().includes(q),
    );
  }, [currentFields, search]);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Tabs
        value={activeEntity}
        onValueChange={(v) => setActiveEntity(v as FieldPickerEntity)}
      >
        <TabsList>
          {(Object.keys(ENTITY_LABELS) as FieldPickerEntity[]).map((key) => (
            <TabsTrigger key={key} value={key}>
              {ENTITY_LABELS[key]}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="mt-3 flex items-center gap-2 rounded-md border border-input bg-background px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по коду или названию"
            className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>

        {(Object.keys(ENTITY_LABELS) as FieldPickerEntity[]).map((key) => (
          <TabsContent key={key} value={key} className="mt-3">
            <FieldList
              loading={fieldsQuery.isLoading}
              error={fieldsQuery.error}
              fields={activeEntity === key ? filtered : []}
              entity={key}
              onSelect={onSelect}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

interface FieldListProps {
  loading: boolean;
  error: unknown;
  fields: CrmFieldDTO[];
  entity: FieldPickerEntity;
  onSelect: (token: string, field: CrmFieldDTO, entity: FieldPickerEntity) => void;
}

function FieldList({ loading, error, fields, entity, onSelect }: FieldListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загружаем поля…
      </div>
    );
  }
  if (error) {
    const msg = error instanceof ApiError ? error.message : 'Не удалось загрузить поля';
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{msg}</span>
      </div>
    );
  }
  if (fields.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
        Нет полей по запросу
      </div>
    );
  }

  return (
    <ul className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
      {fields.map((f) => {
        const token = `${entity}.${f.code}`;
        return (
          <li key={f.code}>
            <button
              type="button"
              onClick={() => onSelect(token, f, entity)}
              className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="text-sm font-medium text-foreground">{f.title}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1 py-0.5 font-mono">{token}</code>
                <span>{formatType(f)}</span>
                {f.isRequired && <span className="text-destructive">*</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Human-readable rendering of the Bitrix24 field type descriptor. */
function formatType(field: CrmFieldDTO): string {
  const t = field.type ?? 'string';
  const suffix = field.isMultiple ? ' [массив]' : '';
  return t + suffix;
}
