# users

Backend users proxy route. GET /api/users?search=&start= calls user.get with FILTER.NAME=%search% (Bitrix24 wildcard), SORT/ORDER by LAST_NAME, optional pagination start. Normalizes raw rows into PortalUser[] {id, name, lastName, fullName, email, active}.
