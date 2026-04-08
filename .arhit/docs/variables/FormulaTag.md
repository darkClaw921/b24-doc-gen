# FormulaTag

TipTap Node extension 'formulaTag' — inline atom node used to embed formula placeholders in templates. Attributes tagKey/label/expression round-trip through data-formula-key/label/expression HTML attributes. parseHTML matches any span[data-formula-key]; renderHTML returns a styled pill ('Σ label') with title=expression. Registers TipTap command insertFormulaTag(attrs) and exports helper insertFormula(editor, attrs). Atom + non-draggable so admins can place and remove but cannot accidentally step inside it.
