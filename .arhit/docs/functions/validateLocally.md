# validateLocally

Synchronous client-side sanity check for formula expressions. Catches empty/whitespace, length > 4000, unbalanced parentheses, unclosed string literals (single and double quotes with backslash escaping). Used by FormulaBuilder for immediate feedback before the debounced remote validator fires. Returns LocalValidationResult { valid, error?, remote: false }.
