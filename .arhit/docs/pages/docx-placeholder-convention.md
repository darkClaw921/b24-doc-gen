# Конвенция плейсхолдеров .docx шаблонов

## Обзор

Система использует библиотеку docxtemplater для подстановки значений в .docx файлы.
Плейсхолдеры размещаются непосредственно в тексте Word-документа и заменяются реальными значениями при генерации.

## Типы плейсхолдеров

### 1. Простые значения (формулы)

**Синтаксис:** `{tagKey}` — одинарные фигурные скобки.

Каждый tagKey соответствует ключу из FormulaEvaluationResult. При генерации плейсхолдер заменяется вычисленным значением формулы (поле `value`).

**Примеры:**
- `{DEAL_TITLE}` — название сделки
- `{CONTACT_NAME}` — имя контакта
- `{COMPANY_TITLE}` — название компании
- `{TOTAL_SUM}` — итоговая сумма (результат формулы)
- `{CONTRACT_NUMBER}` — номер договора

**Маппинг из FormulaEvaluationResult:**
- Берётся `formulas[tagKey].value` (строковое представление)
- Если `formulas[tagKey].error` — подставляется пустая строка или текст ошибки (configurable)

### 2. Циклы товарных позиций (product loops)

**Синтаксис:** `{#products}...{/products}` — loop-секция docxtemplater.

Между открывающим и закрывающим тегами размещаются поля товарной позиции. Секция дублируется для каждого элемента массива products.

**Доступные поля внутри цикла (из ProductRow):**

| Плейсхолдер | Тип | Описание |
|---|---|---|
| `{PRODUCT_NAME}` | string | Название товара |
| `{PRICE}` | number | Цена за единицу |
| `{QUANTITY}` | number | Количество |
| `{SUM}` | number | Итого по строке |
| `{DISCOUNT_SUM}` | number | Сумма скидки |
| `{TAX_RATE}` | number | Ставка налога (%) |
| `{MEASURE_NAME}` | string | Единица измерения |
| `{PRODUCT_ID}` | number | ID товара в каталоге |
| `{ID}` | number | ID строки в сделке |
| `{SORT}` | number | Порядок сортировки |

**Пример в шаблоне:**
```
Товарные позиции:
{#products}
  {PRODUCT_NAME} — {QUANTITY} x {PRICE} = {SUM}
{/products}
```

**Пример в таблице Word:**

| № | Наименование | Кол-во | Цена | Сумма |
|---|---|---|---|---|
| {#products}{SORT} | {PRODUCT_NAME} | {QUANTITY} | {PRICE} | {SUM}{/products} |

### 3. Изображения

**Синтаксис:** используется модуль docxtemplater-image-module-free.

Изображения определяются по значению: если значение формулы начинается с `data:image/`, оно интерпретируется как base64-изображение и вставляется inline в документ.

**Для формульных изображений:**
- Плейсхолдер: `{%IMAGE_TAG}` — префикс `%` указывает на изображение
- Значение: base64 data URI из FormulaEvaluationResult.value

**Для изображений товаров (внутри {#products}):**
- `{%PREVIEW_PICTURE_BASE64}` — превью товара
- `{%DETAIL_PICTURE_BASE64}` — детальное изображение
- Значения берутся из соответствующих полей ProductRow

**Размеры изображений:**
- Задаются через конфигурацию image-module (getSize callback)
- По умолчанию: ограничение максимальным размером с сохранением пропорций

## Маппинг данных в docxtemplater

При вызове `docxtemplater.render(data)` объект data формируется следующим образом:

```typescript
interface DocxTemplateData {
  // Все формулы — плоский объект tagKey -> value
  [tagKey: string]: string | number | boolean;
  
  // Массив товарных позиций для циклов
  products: Array<{
    PRODUCT_NAME: string;
    PRICE: number;
    QUANTITY: number;
    SUM: number;
    DISCOUNT_SUM: number;
    TAX_RATE: number;
    MEASURE_NAME: string;
    PRODUCT_ID: number;
    ID: number;
    SORT: number;
    PREVIEW_PICTURE_BASE64?: string;
    DETAIL_PICTURE_BASE64?: string;
  }>;
}
```

**Алгоритм построения data:**
1. Итерируем `formulas: Record<string, FormulaEvaluationResult>`
2. Для каждого результата: `data[result.tagKey] = result.value`
3. Если значение начинается с `data:image/` — оставляем как есть (image-module обработает)
4. Добавляем `data.products = ProductRow[]` из контекста сделки

## Важные замечания

- Docxtemplater использует одинарные `{}`, а не двойные `{{}}` (как в Mustache)
- Плейсхолдеры должны быть единым run в Word XML — не разрывать форматированием
- При вставке плейсхолдера в Word рекомендуется набирать его целиком без изменения форматирования
- Неразрешённые плейсхолдеры по умолчанию заменяются пустой строкой (nullGetter)
- Для отладки можно включить строгий режим, чтобы неразрешённые плейсхолдеры вызывали ошибку