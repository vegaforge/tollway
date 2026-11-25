-- Tollway channel commitment store, migration 0002 (#38).
--
-- Adds the fields ChannelManager.recover records: the ledger after which a
-- funder close lets the funder refund, and the amount and transaction of that
-- refund. Apply after 0001, with search_path set to the same schema. Each
-- statement is safe to run again.
--
-- The ledger is a ledger number, never a timestamp. The amount is
-- NUMERIC(39, 0), like every other amount in 0001.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS close_effective_at_ledger INTEGER;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS recovered_amount NUMERIC(39, 0);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT;
