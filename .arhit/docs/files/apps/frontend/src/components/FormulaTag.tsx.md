# apps/frontend/src/components/FormulaTag.tsx

TipTap inline atom node for formula pills inside templates. Attributes: tagKey, label, expression — round-tripped via data-formula-key/label/expression attrs. Inline + atom + selectable; renders as span with bg-blue-100, ring, cursor-pointer + hover:bg-blue-200 to signal click-to-edit. Tooltip carries the expression. parseHTML accepts any span[data-formula-key]. Registers TipTap command insertFormulaTag(attrs) and exports insertFormula(editor, attrs) helper.
