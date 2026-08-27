-- Native mobile API schema compatibility.
-- The standard installer executes only drizzle/migrations. Keep all mobile OAuth,
-- device, token, and idempotency tables in that authoritative forward-only path.

CREATE TABLE IF NOT EXISTS `mobile_devices` (
  `id` varchar(96) NOT NULL,
  `user_id` int NOT NULL,
  `platform` varchar(16) NOT NULL,
  `app_version` varchar(32) NOT NULL,
  `device_name` varchar(128) DEFAULT NULL,
  `push_token_hash` char(64) DEFAULT NULL,
  `push_token_enc` text DEFAULT NULL,
  `push_platform` varchar(16) DEFAULT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `last_seen_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `revoked_reason` varchar(190) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `mobile_devices_user_idx` (`user_id`),
  KEY `mobile_devices_status_idx` (`status`),
  KEY `mobile_devices_last_seen_idx` (`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Older nonstandard mobile source bundles can have mobile_devices without the
-- encrypted token material. Add only that additive column if it is absent.
SET @rp_mobile_push_token_enc_exists := (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'mobile_devices'
     AND column_name = 'push_token_enc'
);
SET @rp_mobile_push_token_enc_sql := IF(
  @rp_mobile_push_token_enc_exists = 0,
  'ALTER TABLE `mobile_devices` ADD COLUMN `push_token_enc` text DEFAULT NULL AFTER `push_token_hash`',
  'SELECT 1'
);
PREPARE rp_mobile_push_token_enc_stmt FROM @rp_mobile_push_token_enc_sql;
EXECUTE rp_mobile_push_token_enc_stmt;
DEALLOCATE PREPARE rp_mobile_push_token_enc_stmt;

CREATE TABLE IF NOT EXISTS `mobile_device_sessions` (
  `id` varchar(64) NOT NULL,
  `token_family_id` varchar(64) NOT NULL,
  `device_id` varchar(96) NOT NULL,
  `user_id` int NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `last_seen_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` timestamp NOT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `revoked_reason` varchar(190) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mobile_device_sessions_family_uq` (`token_family_id`),
  KEY `mobile_device_sessions_user_idx` (`user_id`),
  KEY `mobile_device_sessions_device_idx` (`device_id`),
  KEY `mobile_device_sessions_expires_idx` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `mobile_authorization_codes` (
  `id` varchar(64) NOT NULL,
  `code_hash` char(64) NOT NULL,
  `user_id` int NOT NULL,
  `device_id` varchar(96) NOT NULL,
  `redirect_uri` varchar(512) NOT NULL,
  `code_challenge` varchar(128) NOT NULL,
  `scopes` json NOT NULL,
  `expires_at` timestamp NOT NULL,
  `used_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mobile_authorization_codes_hash_uq` (`code_hash`),
  KEY `mobile_authorization_codes_expires_idx` (`expires_at`),
  KEY `mobile_authorization_codes_user_idx` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `mobile_refresh_tokens` (
  `id` varchar(64) NOT NULL,
  `token_hash` char(64) NOT NULL,
  `session_id` varchar(64) NOT NULL,
  `token_family_id` varchar(64) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `expires_at` timestamp NOT NULL,
  `rotated_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mobile_refresh_tokens_hash_uq` (`token_hash`),
  KEY `mobile_refresh_tokens_session_idx` (`session_id`),
  KEY `mobile_refresh_tokens_family_idx` (`token_family_id`),
  KEY `mobile_refresh_tokens_expires_idx` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `mobile_idempotency_keys` (
  `id` varchar(64) NOT NULL,
  `user_id` int NOT NULL,
  `route` varchar(128) NOT NULL,
  `key_hash` char(64) NOT NULL,
  `request_hash` char(64) NOT NULL,
  `response_json` json NOT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mobile_idempotency_keys_user_key_uq` (`user_id`, `key_hash`),
  KEY `mobile_idempotency_keys_expires_idx` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
