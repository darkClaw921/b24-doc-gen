# api

Frontend API client (lib/api.ts). apiRequest<T>(path, opts) helper that prefixes /api, attaches X-B24-* auth headers from getB24AuthHeaders(), parses JSON, throws ApiError on non-2xx. Grouped helpers: installApi (status, install, registerPlacements), usersApi (search), dealApi (fields, data). DTO types: PortalUserDTO, InstallStatusDTO, InstallSettingsDTO.
