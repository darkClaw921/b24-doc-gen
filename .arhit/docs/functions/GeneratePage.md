# GeneratePage

User-facing deal-scoped page (apps/frontend/src/pages/GeneratePage.tsx) loaded inside the Bitrix24 CRM_DEAL_DETAIL_TAB placement. Three-column layout: themes/templates picker (left), .docx preview (center), actions+fields+formulas (right). dealId comes from getCurrentDealId(); shows a stub when absent.

Preview rendering: selecting a template (and any debounced change to manual-field values) calls templatesApi.preview(id, dealId, fieldValues, signal) which POSTs /templates/:id/preview and returns TemplatePreviewResponseDTO { docxBase64, tags, formulas, fields }. The base64 .docx is decoded to a Uint8Array (base64ToBytes) and rendered client-side via docx-preview renderAsync(bytes, bodyContainer, styleContainer, options). Options: className='gen-docx-preview', inWrapper, ignoreWidth/Height=false (1:1 with Word), breakPages, useBase64URL (inline images), renderHeaders/Footers/Footnotes. A separate hidden styleContainer ref keeps Word CSS isolated from the app UI. Container is cleared (replaceChildren) before each render; a cancelled flag guards against out-of-order debounced renders.

Live field updates: fieldValues are debounced 500ms (useDebouncedValue) and fed into the React Query key, so a pause in typing re-requests the preview; React Query's queryFn AbortSignal cancels superseded requests. placeholderData keeps the previous preview visible during re-fetch to avoid flicker.

Manual fields: ManualFieldInput renders text/textarea/number/date inputs from previewData.fields; defaults applied via initialFieldValue (date 'today'); values formatted via formatFieldValue (date -> dd.MM.yyyy) before generation. missingRequired blocks the Generate button.

Error handling: when the template has no originalDocx the backend returns HTTP 400 -> previewErrorMessage shows a friendly 'load a .docx' message instead of crashing. renderError state surfaces docx-preview failures.

Generate: the 'Сгенерировать документ' button calls generateApi.generate({ templateId, dealId, fieldValues }) and on success shows file/binding/timeline/warnings, then reloadParentWindow() to refresh the CRM card.
