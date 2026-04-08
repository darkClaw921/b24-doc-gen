import { Routes, Route } from 'react-router-dom';
import { InstallPage } from '@/pages/InstallPage';
import { TemplatesPage } from '@/pages/TemplatesPage';
import { TemplateEditorPage } from '@/pages/TemplateEditorPage';
import { GeneratePage } from '@/pages/GeneratePage';
import { SettingsPage } from '@/pages/SettingsPage';
import { PlacementGuard } from '@/components/PlacementGuard';
import { OAuthSync } from '@/components/OAuthSync';
import { Toaster } from '@/components/ui/toaster';

/**
 * Top-level application component.
 *
 * The whole route tree is wrapped in `<PlacementGuard>` which:
 *
 *   1. Verifies the Bitrix24 SDK is initialized (otherwise renders
 *      a "open me from Bitrix24" stub).
 *   2. Checks `/api/install/status` and redirects to `/install` if
 *      the application has not been installed yet.
 *   3. Reads the `?view=` query parameter and redirects to the
 *      matching React Router path. This lets us register a single
 *      iframe handler URL with Bitrix24 (the same URL is used for
 *      every placement) and dispatch on the client.
 *
 * The placement-aware default landing path is decided by the guard
 * (CRM_DEAL_DETAIL_TAB → /generate, DEFAULT → /templates).
 */
export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <PlacementGuard>
        <OAuthSync />
        <Routes>
          <Route path="/install" element={<InstallPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/templates/:id/edit" element={<TemplateEditorPage />} />
          <Route path="/generate" element={<GeneratePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<TemplatesPage />} />
        </Routes>
      </PlacementGuard>
      <Toaster />
    </div>
  );
}
