# TemplateDTO

DTO шаблона. Поля: id, name, themeId, contentHtml, formulas[], fields[], hasOriginalDocx, originalDocxBase64? (base64 .docx, только при withDocx), docxPlaceholders? (теги из scanDocxPlaceholders, только при withDocx и наличии .docx — драйвит панель тегов в редакторе), createdAt, updatedAt. Определён в apps/frontend/src/lib/api.ts и apps/backend/src/routes/templates.ts; backend toTemplateDto() сканирует .docx при withDocx.
