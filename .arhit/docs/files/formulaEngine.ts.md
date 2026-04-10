# formulaEngine.ts

Formula engine now includes 4 product helpers: productCount() returns number of product rows, productSum(field) sums a numeric field across all rows, productGet(index, field) accesses a single row field (1-based), productImage(index) returns base64 image. collectDeps detects these helpers via FunctionNode AST traversal and sets deps.products=true. All helpers are in KNOWN_NON_ENTITY_SYMBOLS.
