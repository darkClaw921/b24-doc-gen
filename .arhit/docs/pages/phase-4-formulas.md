# Phase 4 — Formulas and tags

Phase 4 introduces the formula system that powers dynamic values inside document templates.

## Backend

- services/formulaEngine.ts — sandboxed mathjs engine (validateExpression / evaluateExpression / extractDependencies).
- routes/formulas.ts — POST /api/formulas/validate and POST /api/formulas/evaluate.
- routes/deal.ts — new GET /api/crm/fields returning deal/contact/company field schemas at once; new caches for contact/company fields.
- services/b24Client.ts — added getContactFields/getCompanyFields.

## Frontend

- components/FormulaTag.tsx — TipTap Node extension (inline atom) for formula pills.
- components/FieldPicker.tsx — three-tab picker fed by crmApi.allFields.
- components/FormulaBuilder.tsx — modal dialog orchestrating label/tagKey/expression with live validation and preview.
- lib/formulas.ts — validateLocally, validateRemote, generateTagKey helpers.
- lib/api.ts — crmApi and formulasApi groups.
- components/Editor/TiptapEditor.tsx — registers FormulaTag in buildTiptapExtensions.
- components/Editor/Toolbar.tsx — optional Σ button calling onInsertFormula.
- pages/TemplateEditorPage.tsx — wires FormulaBuilder, holds formulasByKey map, extractFormulasFromEditor walker, sends formulas[] in PUT /api/templates/:id.

## Data flow

1. Admin clicks the Σ toolbar button → FormulaBuilder opens.
2. Admin types an expression; validateLocally runs synchronously, validateRemote is debounced (500 ms) and hits POST /api/formulas/validate.
3. Admin picks fields through FieldPicker → tokens like DEAL.OPPORTUNITY are spliced into the textarea at the caret.
4. On 'Вставить', onInsert delivers {tagKey, label, expression, dependsOn} to TemplateEditorPage which inserts a FormulaTag node into TipTap and stores the metadata in formulasByKey.
5. On Save, extractFormulasFromEditor walks editor.state.doc.descendants, collects formulaTag nodes, and PUT /api/templates/:id persists the array.