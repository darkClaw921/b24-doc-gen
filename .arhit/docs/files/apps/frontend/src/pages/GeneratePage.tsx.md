# apps/frontend/src/pages/GeneratePage.tsx

Page Фазы 5 для deal-scoped генерации. Три колонки: темы+шаблоны слева (themesApi.list + templatesApi.list по selectedThemeId), preview в центре (templatesApi.preview + dangerouslySetInnerHTML с PREVIEW_STYLES CSS-инъекцией), действия справа (generateApi.generate). useEffect после рендера preview добавляет native title атрибут к span[data-formula-key] с label/expression/value. Без dealId показывает stub. Использует getCurrentDealId из lib/b24. Результат генерации: fileName, downloadUrl, binding (status UF_CRM), timeline (comment), warnings[].
