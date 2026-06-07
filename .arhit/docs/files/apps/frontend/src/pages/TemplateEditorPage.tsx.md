# apps/frontend/src/pages/TemplateEditorPage.tsx

Admin editor for a single template (route /templates/:id/edit). Left pane is an EDITABLE in-browser .docx editor via <DocxEditor> from @eigenpal/docx-editor-react (replaced the former read-only docx-preview/renderAsync). Right pane is the unchanged 'Теги шаблона' panel (FormulaBuilder/ManualFieldBuilder, lib/templateTags.ts computeTagStatus).

Editor integration:
- imports DocxEditor + DocxEditorRef from '@eigenpal/docx-editor-react' and the package's styles.css.
- documentBuffer derived via useMemo from template.originalDocxBase64 -> base64ToBytes(b64).buffer (cast to ArrayBuffer to narrow ArrayBufferLike). null while base64 missing -> loading spinner.
- props: ref=editorRef (useRef<DocxEditorRef>), mode='editing', showToolbar, showRuler, documentName=name, onChange=()=>setDocDirty(true), onError=setEditorError.
- CSS isolation: editor wrapped in a container with class 'docx-editor-host' + Tailwind 'isolate [contain:layout_paint]' so Word-like styles stay scoped to the left pane.
- 'no .docx' state shows a placeholder message instead of the editor.

State: docDirty (document edited since load), editorError, isSavingDocx; isSaving = isSavingDocx || saveMutation.isPending drives the Save button. formulasByKey/fieldsByKey unchanged.

handleSave (async sequential flow, single button):
 1. If docDirty: const buf = await editorRef.current.save() (Promise<ArrayBuffer|null>, null-guarded) -> new Blob([buf], {type: docx mime}) -> templatesApi.saveDocx(id, blob). On success: queryClient.setQueryData(['template',id,'withDocx'], merge response.template + preserved originalDocxBase64 + new docxPlaceholders) and invalidateQueries to reconcile; setDocDirty(false); effectiveTags = sorted new docxPlaceholders.
 2. window.confirm for unbound tags computed from effectiveTags (AFTER re-scan, since tag set may have changed).
 3. saveMutation.mutate({name, themeId, formulas, fields}) -> PUT /api/templates/:id; order derived from effectiveTags. Skipped if step 1 threw.
saveMutation.onSuccess merges the withDocx:false update DTO into the cache while preserving originalDocxBase64/docxPlaceholders/hasOriginalDocx so the editor and tags panel keep their data.

Dependencies: @eigenpal/docx-editor-react, lib/api.ts (templatesApi.get withDocx / saveDocx / update), lib/templateTags.ts, FormulaBuilder, ManualFieldBuilder, FieldPicker. docx-preview is NO LONGER used here (still used by GeneratePage).
