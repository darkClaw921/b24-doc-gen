# resolveSelectValue

Хелпер в generationPipeline.ts. Преобразует выбранную пользователем метку (label) select-поля в подставляемую в документ строку. В режиме valueMode='direct' возвращает саму метку; в режиме 'mapped' ищет в options (JSON-массив {label,value}) опцию по label и возвращает её value (если не найдено — метку). Для не-select полей возвращает значение без изменений. Вызывается из resolveManualFieldValues для каждого поля после вычисления 'выбранной' метки (provided или дефолт). Это единая точка маппинга, общая для генерации, preview и webhook-вызовов.
