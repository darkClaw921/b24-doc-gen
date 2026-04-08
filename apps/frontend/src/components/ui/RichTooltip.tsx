/**
 * RichTooltip — лёгкая всплывающая подсказка в стиле Google Sheets.
 *
 * Зачем существует:
 *  - В проекте нет зависимости @radix-ui/react-tooltip, а нативного
 *    атрибута `title` недостаточно: нужно отрисовать богатое содержимое
 *    (заголовок, описание, список аргументов, пример).
 *  - Компонент использует только React + createPortal и не требует
 *    добавления новых пакетов.
 *
 * Как работает:
 *  - Оборачивает произвольный `children` (обычно одна кнопка/иконка) в
 *    inline-flex span. На этот span навешиваются обработчики hover/focus.
 *  - При наведении со стандартной задержкой 300 мс позиционирует
 *    подсказку поверх viewport через portal в `document.body`. После
 *    первого рендера переизмеряет реальный размер тултипа и при
 *    необходимости отзеркаливает его относительно триггера, чтобы
 *    влезть в viewport.
 *  - Содержимое подсказки передаётся через проп `content: ReactNode`,
 *    что позволяет использовать любую разметку — от простой строки до
 *    сложной таблицы аргументов.
 *
 * Это утилитарный примитив, его используют:
 *  - `FormulaBuilder` — для подсказок над кнопками функций/операторов.
 *  - `TemplateEditorPage` (через `EditorFormulaTooltip`) — для подсказок
 *    над вставленными в TipTap пилюлями формул.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface RichTooltipProps {
  /** Содержимое подсказки. */
  content: ReactNode;
  /** Триггер: кнопка/иконка/любой инлайн-элемент. */
  children: ReactNode;
  /** Задержка появления, мс. По умолчанию 250. */
  delay?: number;
  /** С какой стороны от триггера показывать. По умолчанию 'top'. */
  side?: 'top' | 'bottom';
  /** Дополнительные классы для самого тултипа. */
  className?: string;
  /** Если true — оборачивающий span получает inline-block (для блочных триггеров). */
  asBlock?: boolean;
}

export function RichTooltip({
  content,
  children,
  delay = 250,
  side = 'top',
  className,
  asBlock = false,
}: RichTooltipProps) {
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Initial best-effort position; useLayoutEffect ниже доуточнит.
      setPos({
        top: side === 'top' ? rect.top - 8 : rect.bottom + 8,
        left: rect.left + rect.width / 2,
      });
      setOpen(true);
    }, delay);
  }, [delay, side]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, []);

  useEffect(() => () => clearTimer(), []);

  // Перемеряем реальный размер тултипа и корректируем позицию, чтобы:
  //  - центрировать его относительно триггера по горизонтали;
  //  - не вылезать за края viewport;
  //  - отзеркалить вертикально, если не помещается сверху/снизу.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = wrapperRef.current;
    const tip = tooltipRef.current;
    if (!trigger || !tip) return;
    const trigRect = trigger.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const margin = 8;

    let top =
      side === 'top'
        ? trigRect.top - tipRect.height - margin
        : trigRect.bottom + margin;
    let left = trigRect.left + trigRect.width / 2 - tipRect.width / 2;

    // Зеркалирование, если не помещается.
    if (side === 'top' && top < 8) {
      top = trigRect.bottom + margin;
    } else if (side === 'bottom' && top + tipRect.height > window.innerHeight - 8) {
      top = trigRect.top - tipRect.height - margin;
    }
    // Горизонтальный клэмп.
    if (left < 8) left = 8;
    if (left + tipRect.width > window.innerWidth - 8) {
      left = window.innerWidth - tipRect.width - 8;
    }
    if (top < 8) top = 8;

    setPos((prev) => {
      if (prev && Math.abs(prev.top - top) < 0.5 && Math.abs(prev.left - left) < 0.5) {
        return prev;
      }
      return { top, left };
    });
  }, [open, side, content]);

  return (
    <>
      <span
        ref={wrapperRef}
        className={asBlock ? 'inline-block' : 'inline-flex'}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {open && pos
        ? createPortal(
            <div
              ref={tooltipRef}
              role="tooltip"
              className={cn(
                'pointer-events-none fixed z-[1000] max-w-sm rounded-md border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-lg',
                'animate-in fade-in-0 zoom-in-95',
                className,
              )}
              style={{ top: pos.top, left: pos.left }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default RichTooltip;
