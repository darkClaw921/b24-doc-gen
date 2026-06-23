/**
 * formulaHelp — справочные метаданные функций и операторов формул.
 *
 * Зачем существует:
 *  - И FormulaBuilder (палитра функций), и редактор шаблонов
 *    (всплывающие подсказки над пилюлями) показывают пользователю
 *    одни и те же описания. Чтобы не дублировать тексты и
 *    сигнатуры, всё хранится в одном файле.
 *  - При добавлении новой функции в formulaEngine достаточно дописать
 *    запись сюда — UI автоматически подхватит её в подсказке.
 *
 * Структура:
 *  - HELPER_DOCS — словарь по имени функции.
 *  - OPERATOR_DOCS — короткие пояснения для бинарных операторов.
 *  - extractUsedHelpers / extractUsedOperators — синтаксические
 *    помощники, которые по тексту выражения вычисляют, какие функции
 *    и операторы в нём встречаются (для вывода подсказок над пилюлей).
 */

export interface HelperArg {
  name: string;
  description: string;
}

export interface HelperDoc {
  /** Имя функции, как используется в выражении. */
  name: string;
  /** Сигнатура для заголовка подсказки. */
  signature: string;
  /** Краткое одностроковое описание. */
  summary: string;
  /** Развёрнутое описание поведения. */
  description: string;
  /** Параметры (для отрисовки таблицей). */
  args: ReadonlyArray<HelperArg>;
  /** Один-два примера использования. */
  examples: ReadonlyArray<string>;
}

export const HELPER_DOCS: Readonly<Record<string, HelperDoc>> = {
  if: {
    name: 'if',
    signature: 'if(cond, a, b)',
    summary: 'Условный выбор: возвращает a, если cond истинно, иначе b.',
    description:
      'Тернарный оператор. Если cond — истина (число ≠ 0, непустая строка, true), возвращает a, иначе b. Можно вкладывать друг в друга для лестницы условий.',
    args: [
      { name: 'cond', description: 'Логическое выражение или сравнение.' },
      { name: 'a', description: 'Значение, если cond истинно.' },
      { name: 'b', description: 'Значение, если cond ложно.' },
    ],
    examples: [
      'if(DEAL.OPPORTUNITY > 100000, "VIP", "Стандарт")',
      'if(CONTACT.HAS_EMAIL == 1, CONTACT.EMAIL, "—")',
    ],
  },
  concat: {
    name: 'concat',
    signature: 'concat(...args)',
    summary: 'Склеивает все переданные значения в одну строку.',
    description:
      'Принимает любое количество аргументов и приводит их к строке. Удобно для сборки полного имени, адреса или подписи.',
    args: [
      { name: '...args', description: 'Любое число строк или чисел.' },
    ],
    examples: [
      'concat(CONTACT.NAME, " ", CONTACT.LAST_NAME)',
      'concat("№", DEAL.ID, " от ", dateFormat(DEAL.BEGINDATE, "dd.MM.yyyy"))',
    ],
  },
  format: {
    name: 'format',
    signature: 'format(value, pattern)',
    summary: 'Форматирует число строкой по шаблону.',
    description:
      'Преобразует число к строке. Поддерживаются паттерны: 0 (целое), 0.00 (два знака), 0.0% (проценты), money (с пробелами и валютой), usd, eur.',
    args: [
      { name: 'value', description: 'Число или числовое выражение.' },
      { name: 'pattern', description: 'Строка-шаблон форматирования.' },
    ],
    examples: [
      'format(DEAL.OPPORTUNITY, "money")',
      'format(DEAL.OPPORTUNITY * 0.2, "0.00")',
    ],
  },
  dateFormat: {
    name: 'dateFormat',
    signature: 'dateFormat(date, fmt)',
    summary: 'Форматирует дату по шаблону.',
    description:
      'Принимает дату из Bitrix24 (ISO-строка или Date) и возвращает строку в нужном формате. Поддерживаются паттерны iso, date, datetime и любые маски date-fns (например dd.MM.yyyy).',
    args: [
      { name: 'date', description: 'ISO-строка даты или поле типа date.' },
      { name: 'fmt', description: 'Шаблон формата.' },
    ],
    examples: [
      'dateFormat(DEAL.BEGINDATE, "dd.MM.yyyy")',
      'dateFormat(DEAL.CLOSEDATE, "datetime")',
    ],
  },
  today: {
    name: 'today',
    signature: 'today(fmt?)',
    summary: 'Сегодняшняя дата на момент генерации документа.',
    description:
      'Подставляет текущую дату (день, когда формируется документ). Необязательный параметр fmt задаёт формат по тем же правилам, что и dateFormat: iso, date, datetime или любая маска date-fns (например dd.MM.yyyy). По умолчанию dd.MM.yyyy.',
    args: [
      {
        name: 'fmt',
        description: 'Необязательный шаблон формата (как в dateFormat). По умолчанию dd.MM.yyyy.',
      },
    ],
    examples: [
      'today()',
      'today("yyyy-MM-dd")',
      'concat("Дата: ", today())',
    ],
  },
  upper: {
    name: 'upper',
    signature: 'upper(s)',
    summary: 'Переводит строку в ВЕРХНИЙ регистр.',
    description:
      'Возвращает строку, преобразованную к верхнему регистру. Не-строки сначала приводятся к строке.',
    args: [{ name: 's', description: 'Строка или выражение, приводимое к строке.' }],
    examples: ['upper(CONTACT.LAST_NAME)'],
  },
  lower: {
    name: 'lower',
    signature: 'lower(s)',
    summary: 'Переводит строку в нижний регистр.',
    description:
      'Возвращает строку, преобразованную к нижнему регистру. Не-строки сначала приводятся к строке.',
    args: [{ name: 's', description: 'Строка или выражение, приводимое к строке.' }],
    examples: ['lower(CONTACT.EMAIL)'],
  },
  productSum: {
    name: 'productSum',
    signature: 'productSum(field)',
    summary: 'Сумма числового поля по всем товарным позициям сделки.',
    description:
      'Перебирает массив товарных позиций сделки и складывает значения указанного числового поля. Возвращает 0 если товаров нет или поле не числовое.',
    args: [
      {
        name: 'field',
        description:
          'Имя числового поля товарной позиции в кавычках: "PRICE", "QUANTITY", "SUM", "DISCOUNT_SUM", "TAX_RATE".',
      },
    ],
    examples: [
      'productSum("SUM")',
      'productSum("QUANTITY")',
      'productSum("PRICE") - productSum("DISCOUNT_SUM")',
    ],
  },
  productCount: {
    name: 'productCount',
    signature: 'productCount()',
    summary: 'Количество товарных позиций в сделке.',
    description:
      'Возвращает общее число товарных позиций, привязанных к текущей сделке. Возвращает 0, если товаров нет.',
    args: [],
    examples: ['productCount()', 'if(productCount() > 0, "Есть товары", "Нет товаров")'],
  },
  productGet: {
    name: 'productGet',
    signature: 'productGet(index, field)',
    summary: 'Значение поля конкретного товара по порядковому номеру.',
    description:
      'Возвращает значение указанного поля для товара с заданным порядковым номером (нумерация с 1). Если индекс выходит за пределы массива — возвращает пустую строку.',
    args: [
      { name: 'index', description: 'Порядковый номер товара (начиная с 1).' },
      {
        name: 'field',
        description:
          'Имя поля товарной позиции в кавычках: "PRODUCT_NAME", "PRICE", "QUANTITY", "SUM" и т.д.',
      },
    ],
    examples: [
      'productGet(1, "PRODUCT_NAME")',
      'productGet(2, "PRICE")',
      'concat(productGet(1, "PRODUCT_NAME"), " — ", format(productGet(1, "SUM"), "money"))',
    ],
  },
  productImage: {
    name: 'productImage',
    signature: 'productImage(index, type?, photoIndex?)',
    summary: 'Картинка товара по порядковому номеру.',
    description:
      'Возвращает base64-строку изображения товара для вставки в документ. ' +
      'Параметр type задаёт тип картинки: "preview" (анонс, по умолчанию), "detail" (детальная), "more_photo" (доп. фото). ' +
      'Если тип не найден, пробуется fallback: preview → detail → more_photo[0]. ' +
      'photoIndex (с 0) — номер фото в массиве MORE_PHOTO.',
    args: [
      { name: 'index', description: 'Порядковый номер товара (начиная с 1).' },
      { name: 'type', description: 'Тип картинки: "preview" (по умолч.), "detail", "more_photo".' },
      { name: 'photoIndex', description: 'Индекс в массиве MORE_PHOTO (с 0). По умолч. 0.' },
    ],
    examples: [
      'productImage(1)',
      'productImage(1, "detail")',
      'productImage(2, "more_photo", 0)',
    ],
  },
};

export interface OperatorDoc {
  symbol: string;
  summary: string;
}

export const OPERATOR_DOCS: Readonly<Record<string, OperatorDoc>> = {
  '+': { symbol: '+', summary: 'Сложение чисел или конкатенация строк.' },
  '-': { symbol: '-', summary: 'Вычитание.' },
  '*': { symbol: '*', summary: 'Умножение.' },
  '/': { symbol: '/', summary: 'Деление.' },
  '(': { symbol: '(', summary: 'Открывающая скобка — приоритет вычислений.' },
  ')': { symbol: ')', summary: 'Закрывающая скобка.' },
  ',': { symbol: ',', summary: 'Разделитель аргументов функции.' },
  '==': { symbol: '==', summary: 'Сравнение «равно».' },
  '!=': { symbol: '!=', summary: 'Сравнение «не равно».' },
  '>': { symbol: '>', summary: 'Сравнение «больше».' },
  '<': { symbol: '<', summary: 'Сравнение «меньше».' },
  '>=': { symbol: '>=', summary: 'Сравнение «больше или равно».' },
  '<=': { symbol: '<=', summary: 'Сравнение «меньше или равно».' },
};

/**
 * По выражению формулы возвращает список встретившихся имён функций
 * (только тех, что описаны в HELPER_DOCS). Используется для подсказки
 * над пилюлей формулы — чтобы показать справку по функциям, которые
 * автор использовал в expression.
 */
export function extractUsedHelpers(expression: string): HelperDoc[] {
  if (!expression) return [];
  const seen = new Set<string>();
  const out: HelperDoc[] = [];
  // Совпадение «имя функции, за которым следует открывающая скобка».
  const re = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const doc = HELPER_DOCS[name];
    if (doc) out.push(doc);
  }
  return out;
}
