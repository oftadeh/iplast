-- One-time cleanup before going live (HRO, 2026-11-08): everything until now was testing.
-- Removes customers with their orders, invoices, payments, documents, join requests and chats,
-- and the users who are not staff. Catalog, prices, staff and settings stay. Numbering restarts.
DELETE FROM "Conversation";
DELETE FROM "AssistantDraft";
DELETE FROM "Document";
DELETE FROM "Payment";
DELETE FROM "Invoice";
DELETE FROM "Order";
DELETE FROM "JoinRequest";
DELETE FROM "Customer";
DELETE FROM "User" WHERE "staffRole" IS NULL;
DELETE FROM "Setting" WHERE "key" LIKE 'bot.started.%';
SELECT setval(pg_get_serial_sequence('"Customer"', 'code'), 1000, true);
SELECT setval(pg_get_serial_sequence('"Order"', 'number'), 1, false);
SELECT setval(pg_get_serial_sequence('"Invoice"', 'number'), 1, false);
