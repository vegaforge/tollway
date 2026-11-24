-- Tollway channel commitment store, migration 0001 (#177).
--
-- Apply once to an empty schema, with search_path set to the schema that will
-- hold the tables (for example: SET search_path TO tollway;). Pass the same
-- schema name to createPostgresCommitmentStore so its queries find the tables.
--
-- Amounts are NUMERIC(39, 0): exact integers up to 39 digits, which holds every
-- value up to 2^127 - 1, the largest Soroban i128 amount. Timestamps are TEXT
-- holding the ISO-8601 string the manager wrote, so they read back byte for byte.
-- The id column uses collation "C" so the database orders channels the same way
-- the store's JavaScript code does.

CREATE TABLE channels (
  id                          TEXT PRIMARY KEY COLLATE "C",
  counterparty                TEXT NOT NULL,
  asset                       TEXT NOT NULL,
  deposit                     NUMERIC(39, 0) NOT NULL CHECK (deposit >= 0),
  committed                   NUMERIC(39, 0) NOT NULL,
  sequence                    INTEGER NOT NULL CHECK (sequence >= -1),
  status                      TEXT NOT NULL CHECK (status IN (
                                'open', 'closing', 'closed', 'recovering', 'recovered',
                                'settlement-mismatched')),
  network                     TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  open_tx_hash                TEXT NOT NULL,
  opened_at                   TEXT NOT NULL,
  last_commit_at              TEXT,
  settlement_tx_hash          TEXT,
  returned_remainder          NUMERIC(39, 0),
  close_attempt_id            TEXT,
  close_attempt_ledger        INTEGER,
  close_attempt_started_at    TEXT,
  settlement_expected_amount  NUMERIC(39, 0),
  settlement_observed_amount  NUMERIC(39, 0),
  -- The committed total can never pass the deposit.
  CHECK (committed >= 0 AND committed <= deposit)
);

-- Listing queries: filter by status, or by counterparty and asset, then page by id.
CREATE INDEX channels_status_idx ON channels (status, id);
CREATE INDEX channels_counterparty_asset_idx ON channels (counterparty, asset, id);

-- One row per commitment. The primary key is the database-level backstop
-- against a duplicate sequence, even if a bug skipped the compare-and-set.
CREATE TABLE commitments (
  channel_id         TEXT NOT NULL REFERENCES channels (id),
  sequence           INTEGER NOT NULL CHECK (sequence >= 0),
  cumulative_amount  NUMERIC(39, 0) NOT NULL CHECK (cumulative_amount >= 0),
  commitment         TEXT NOT NULL,
  PRIMARY KEY (channel_id, sequence)
);
