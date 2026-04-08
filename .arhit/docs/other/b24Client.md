# b24Client

Server-side wrapper around the Bitrix24 REST API. Class B24Client(portal, accessToken) provides callMethod, callBatch, and typed helpers (getDeal, getDealFields, getContact, getCompany, getDealContacts, addTimelineComment, listUsers, uploadDiskFile, listDealUserFields, addDealUserField, updateDeal). B24Error wraps upstream failures with code/status. Batch parameters are serialized PHP-style for compatibility with Bitrix24 batch endpoint.
