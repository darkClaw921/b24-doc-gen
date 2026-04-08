-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "themeId" TEXT,
    "templateId" TEXT,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Webhook_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Webhook_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_token_key" ON "Webhook"("token");

-- CreateIndex
CREATE INDEX "Webhook_themeId_idx" ON "Webhook"("themeId");

-- CreateIndex
CREATE INDEX "Webhook_templateId_idx" ON "Webhook"("templateId");
