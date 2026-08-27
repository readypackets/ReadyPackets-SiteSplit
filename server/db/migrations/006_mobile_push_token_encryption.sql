-- Encrypted device-token material is accessible only to the self-hosted push
-- dispatcher. The existing hash remains the non-reversible deduplication key.
ALTER TABLE mobile_devices ADD COLUMN push_token_enc TEXT NULL AFTER push_token_hash;
