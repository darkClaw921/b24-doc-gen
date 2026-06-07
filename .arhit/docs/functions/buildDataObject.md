# buildDataObject

Internal helper in docxTemplateEngine.ts. Builds the data object passed to docxtemplater render(). Signature: buildDataObject(formulas, products, fieldValues={}). Order of precedence: manual field values are applied first (data[fieldKey]=value), then formula values (data[tagKey]=value) so formulas WIN on key collision. Products are mapped to data.products array (always set, even when empty) for {#products}...{/products} loops, including image base64 fields. Manual fields substitute via the same {fieldKey} delimiters as formulas.
