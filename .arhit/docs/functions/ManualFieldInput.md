# ManualFieldInput

Компонент в GeneratePage.tsx, рендерит инпут значения поля при генерации. Для field.type==='select' рендерит <select> с вариантами field.options (option value=label) и пустым вариантом ('— выберите —' для required, 'Не выбрано' иначе); хранит/отдаёт выбранную метку. Для textarea — <textarea>, для number/date/text — <input>. Маппинг метки в реальное значение выполняется на бэкенде (resolveSelectValue).
