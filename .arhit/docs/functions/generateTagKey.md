# generateTagKey

Slugifies a human-readable label into a template-unique formula key. Transliterates Cyrillic via an internal CYR_MAP, lowercases, replaces non-[a-z0-9_] runs with underscore, collapses repeats. Falls back to 'formula' when the slug is empty. Appends _2, _3, … until the resulting key is not present in the 'existing' argument.
