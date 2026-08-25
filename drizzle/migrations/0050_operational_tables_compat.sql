-- Fresh-install compatibility: these Tier 3 operational tables were present in
-- the application schema but were not covered by an earlier forward migration.
-- CREATE IF NOT EXISTS preserves existing installations and repairs clean schemas.

CREATE TABLE IF NOT EXISTS `outbound_connections` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(128) NOT NULL,
  `connection_type` varchar(64) NOT NULL DEFAULT 'http',
  `base_url` varchar(512) DEFAULT NULL,
  `auth_type` enum('none','api_key','bearer','basic','oauth2') NOT NULL DEFAULT 'none',
  `credentials_enc` text DEFAULT NULL,
  `headers` json DEFAULT NULL,
  `timeout_ms` int NOT NULL DEFAULT 10000,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `last_tested_at` timestamp NULL DEFAULT NULL,
  `last_test_ok` tinyint(1) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `outbound_call_logs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `connection_id` int NOT NULL,
  `method` varchar(8) NOT NULL,
  `url` varchar(1024) NOT NULL,
  `status_code` smallint DEFAULT NULL,
  `latency_ms` int NOT NULL DEFAULT 0,
  `error` text DEFAULT NULL,
  `triggered_by` varchar(128) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `outbound_call_logs_connection_idx` (`connection_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `system_backups` (
  `id` int NOT NULL AUTO_INCREMENT,
  `filename` varchar(512) NOT NULL,
  `size_bytes` bigint unsigned NOT NULL DEFAULT 0,
  `backup_type` enum('full','database','files','incremental') NOT NULL DEFAULT 'full',
  `status` enum('running','completed','failed','deleted') NOT NULL DEFAULT 'completed',
  `schema_version` varchar(32) DEFAULT NULL,
  `checksum` varchar(128) DEFAULT NULL,
  `storage_path` varchar(1024) DEFAULT NULL,
  `triggered_by` enum('scheduler','manual','pre_upgrade') NOT NULL DEFAULT 'scheduler',
  `triggered_by_user_id` int DEFAULT NULL,
  `error` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `system_backups_status_idx` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
