# Theme

Prisma model: id, name, order, addToTimeline (default true), dealFieldBinding (nullable), templates relation, createdAt, updatedAt. Per-theme settings: addToTimeline gates whether the generate route posts a timeline comment with the .docx attachment; dealFieldBinding overrides the global AppSettings.dealFieldBinding for templates inside this theme. NULL on dealFieldBinding falls back to AppSettings (or 'no binding' if that's also null).
