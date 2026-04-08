# apps/frontend/src/components/WebhookManagerDialog.tsx

React-модалка управления webhook-триггерами для Theme или Template.

## Props
- scope: 'theme'|'template'
- targetId: string|null (themeId или templateId в зависимости от scope)
- targetName?: string|null (для отображения в заголовке)
- onClose(): () => void

## Поведение
1. Загрузка полного списка webhook'ов через useQuery(['webhooks'], webhooksApi.list). Клиентская фильтрация по scope+targetId — список короткий, а кеш queryKey единый для всех диалогов.
2. Кнопка «Создать новый» → мутация webhooksApi.create({scope, themeId|templateId}). После успеха — invalidate ['webhooks'].
3. Для каждого webhook'а:
   - readonly Input с полным URL.
   - Кнопка «Скопировать»: async navigator.clipboard.writeText с fallback на document.execCommand('copy') внутри hidden <textarea> (нужно для iframe-политик Bitrix24 где Clipboard API может быть заблокирован). Toast через useToast() на успех/ошибку.
   - Checkbox enabled → webhooksApi.patch(id, {enabled}).
   - Кнопка удаления с window.confirm → webhooksApi.remove(id).
4. Help-блок с пошаговой инструкцией: куда вставить URL в робот «Исходящий вебхук» (метод POST, Bitrix автоматически добавит application_token/access_token/document_id).

## Visibility
Admin-only функциональность обеспечивается на уровне точек входа (dropdown ThemeSidebar под isAdmin, блок карточек TemplatesPage под isAdmin) — сам диалог не дублирует AdminOnly wrapper.

## Зависимости
- lib/api.ts → webhooksApi
- components/ui/dialog.tsx, input.tsx, button.tsx
- components/ui/use-toast.ts
