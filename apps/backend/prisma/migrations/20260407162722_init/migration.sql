-- CreateTable
CREATE TABLE "AppSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "portalDomain" TEXT NOT NULL,
    "adminUserIds" TEXT NOT NULL,
    "dealFieldBinding" TEXT,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Theme" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "contentHtml" TEXT NOT NULL,
    "originalDocx" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Template_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Formula" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "tagKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expression" TEXT NOT NULL,
    "dependsOn" TEXT NOT NULL,
    CONSTRAINT "Formula_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Template_themeId_idx" ON "Template"("themeId");

-- CreateIndex
CREATE INDEX "Formula_templateId_idx" ON "Formula"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "Formula_templateId_tagKey_key" ON "Formula"("templateId", "tagKey");
