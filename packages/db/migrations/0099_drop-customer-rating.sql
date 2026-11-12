-- Removes the customer rating ("דירוג", 2026-11-12): the 1-to-5 score on the
-- customers screen, kept in customer_scores and set through
-- set_customer_score (migration 0074). Bubble never had a rating, and the app
-- now matches it. The customers screen has no rating column, and "הצע סידור"
-- ranks customers by their own history and family habit alone. That is
-- exactly how it already ranked every customer who had no rating, so its
-- suggestions change only for customers who had one.
--
-- DELETES every rating entered. Nothing else reads the table or calls the
-- function.
--
-- ORDER: apply this only AFTER the web app that no longer reads the table is
-- live. A build from before it still reads customer_scores: its customers
-- screen would say the ratings failed to load, and its "הצע סידור" would
-- fail.
--
-- Safe to run again.

drop function if exists public.set_customer_score(uuid, numeric);
drop table if exists public.customer_scores;
