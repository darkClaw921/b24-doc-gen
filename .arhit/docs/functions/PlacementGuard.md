# PlacementGuard

React wrapper that gates the entire route tree. Renders fallback when SDK unavailable, loads /api/install/status and redirects to /install when not installed, reads ?view= query param to dispatch to /generate, /settings, /templates, /install. Default landing path picked by placement code (CRM_DEAL_DETAIL_TAB->/generate, DEFAULT->/templates).
