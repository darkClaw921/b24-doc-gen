# formulas.ts

Formula validation route (POST /api/formulas/validate) now includes trial evaluation with stub context (empty DEAL/CONTACT/COMPANY objects and empty PRODUCTS array) after AST validation passes. This catches runtime errors in product helper calls during validation.
