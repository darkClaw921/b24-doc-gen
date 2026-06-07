# registerTemplateRoutes

registerTemplateRoutes(app) регистрирует CRUD-роуты шаблонов и multipart-работу с .docx в apps/backend/src/routes/templates.ts. Все mutation-роуты гейтятся preHandler requireAdmin.

Роут PUT /api/templates/:id/docx (Phase 1) — multipart-замена оригинального .docx отредактированным файлом из браузерного редактора. Зеркалит POST /api/templates/upload, но является обновлением, а не созданием:
- preHandler requireAdmin; гард request.b24Auth.
- Сначала prisma.template.findUnique({ where: { id } }) — если шаблона нет, reply.notFound(404).
- Гард request.isMultipart(); request.file({ limits: { fileSize: 20*1024*1024 } }) — лимит 20MB.
- Валидация .docx: /\.docx$/i.test(filename) || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'.
- filePart.toBuffer(); проверка filePart.file.truncated -> reply.payloadTooLarge.
- contentHtml пересчитывается через parseDocxToHtml (legacy/поиск); DocxParseError -> reply.badRequest.
- Теги сканируются через scanDocxPlaceholders(buffer) — non-fatal try/catch, при ошибке push warning.
- prisma.template.update({ where: { id }, data: { originalDocx: buffer, contentHtml: html.length>0?html:'<p></p>' }, include: { formulas: true, fields: true } }).
- Ответ reply.send({ template: toTemplateDto(row, false), warnings, docxPlaceholders }) с кодом 200 (обновление, не 201).
- Сигнатура app.put<{ Params: GetTemplateParams }> для типобезопасного request.params.id.
Фундамент для Phase 2 (встройка DocxEditor во фронтенд).
