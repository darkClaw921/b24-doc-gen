# apps/frontend/src/components/ui/RichTooltip.tsx

Лёгкая всплывающая подсказка в стиле Google Sheets без зависимости от @radix-ui/react-tooltip. Оборачивает children в span (inline-flex), при mouseenter/focus с задержкой 250мс показывает богатое содержимое (ReactNode) через createPortal в document.body. useLayoutEffect переизмеряет реальный размер и корректирует позицию: центрирование по горизонтали, клэмп по краям viewport, флип сверху↔снизу. Props: content, children, delay, side ('top'|'bottom'), className, asBlock. Используется FormulaBuilder (палитры функций/операторов).
