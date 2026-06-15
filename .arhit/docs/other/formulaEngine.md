# formulaEngine

Песочница mathjs для формул шаблонов. Поддерживает 4 namespace-сущности в выражениях: DEAL.*, CONTACT.*, COMPANY.* и ASSIGNED.* (поля ответственного пользователя сделки). ENTITY_SYMBOLS=['DEAL','CONTACT','COMPANY','ASSIGNED']. collectDeps извлекает зависимости в FormulaDependencies {deal,contact,company,assigned,products?}. evaluateExpression подставляет каждую сущность через withMissingFieldDefaults (отсутствующие поля → ''). Заблокированы динамические примитивы mathjs (import/createUnit/simplify и т.д.).
