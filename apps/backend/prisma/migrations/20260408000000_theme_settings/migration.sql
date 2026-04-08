-- Add per-theme generation settings.
-- addToTimeline: post a timeline comment with the document on generate.
-- dealFieldBinding: per-theme override for the UF_CRM_* file field where
-- the generated .docx is attached. NULL means "fall back to AppSettings".
ALTER TABLE "Theme" ADD COLUMN "addToTimeline" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Theme" ADD COLUMN "dealFieldBinding" TEXT;
