-- ReadyPackets conversion pipeline and multi-site SharePoint targets.
--
-- This forward-only migration adds an append-only, self-hosted conversion
-- workflow. It never alters an existing original file, file version, legacy
-- SharePoint log, or deployed SharePoint folder. New processing state is
-- isolated in explicit snapshots, derived artifacts, and durable queue rows.

CREATE TABLE IF NOT EXISTS `sharepoint_connections` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(120) NOT NULL,
  `tenant_id` varchar(190) NOT NULL,
  `client_id` varchar(64) NOT NULL,
  `client_secret_enc` text NOT NULL,
  `site_id` varchar(512) NOT NULL,
  `drive_id` varchar(512) NOT NULL,
  `site_url` varchar(512) DEFAULT NULL,
  `root_folder_path` varchar(240) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `last_tested_at` timestamp NULL DEFAULT NULL,
  `last_test_ok` tinyint(1) DEFAULT NULL,
  `last_error` varchar(800) DEFAULT NULL,
  `created_by_user_id` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sharepoint_connections_name_unique` (`name`),
  KEY `sharepoint_connections_enabled_idx` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sharepoint_target_bindings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(120) NOT NULL,
  `target_role` varchar(24) NOT NULL,
  `connection_id` int NOT NULL,
  `relative_root_path` varchar(240) DEFAULT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `created_by_user_id` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sharepoint_target_bindings_name_unique` (`name`),
  KEY `sharepoint_target_bindings_connection_idx` (`connection_id`),
  KEY `sharepoint_target_bindings_role_enabled_idx` (`target_role`, `enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `order_sharepoint_locations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `target_binding_id` int NOT NULL,
  `customer_name_snapshot` varchar(180) NOT NULL,
  `customer_id_snapshot` varchar(24) NOT NULL,
  `order_number_snapshot` varchar(64) NOT NULL,
  `resolved_path` varchar(1024) NOT NULL,
  `remote_folder_id` varchar(512) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `order_sharepoint_locations_order_target_unique` (`order_id`, `target_binding_id`),
  KEY `order_sharepoint_locations_target_idx` (`target_binding_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `conversion_profiles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(120) NOT NULL,
  `operation` varchar(40) NOT NULL,
  `settings_json` json DEFAULT NULL,
  `revision` int NOT NULL DEFAULT 1,
  `tool_fingerprint` varchar(128) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by_user_id` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `conversion_profiles_name_unique` (`name`),
  KEY `conversion_profiles_operation_active_idx` (`operation`, `active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `conversion_jobs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `source_file_id` int NOT NULL,
  `source_file_version` int NOT NULL,
  `source_storage_key` varchar(128) NOT NULL,
  `source_sha256` char(64) NOT NULL,
  `source_original_name` varchar(255) NOT NULL,
  `source_phase` varchar(64) NOT NULL,
  `conversion_profile_id` int NOT NULL,
  `profile_revision` int NOT NULL,
  `profile_operation` varchar(40) NOT NULL,
  `profile_settings_json` json DEFAULT NULL,
  `tool_fingerprint` varchar(128) NOT NULL,
  `target_bindings_json` json DEFAULT NULL,
  `artifact_file_id` int DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `idempotency_key` char(64) NOT NULL,
  `correlation_id` char(36) NOT NULL,
  `attempts` int NOT NULL DEFAULT 0,
  `run_after` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lease_token` char(36) DEFAULT NULL,
  `lease_expires_at` timestamp NULL DEFAULT NULL,
  `last_error` varchar(800) DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `cancelled_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `conversion_jobs_idempotency_unique` (`idempotency_key`),
  KEY `conversion_jobs_claim_idx` (`status`, `run_after`, `lease_expires_at`),
  KEY `conversion_jobs_source_idx` (`source_file_id`, `source_file_version`),
  KEY `conversion_jobs_order_idx` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `file_derivatives` (
  `id` int NOT NULL AUTO_INCREMENT,
  `source_file_id` int NOT NULL,
  `source_file_version` int NOT NULL,
  `source_storage_key` varchar(128) NOT NULL,
  `source_sha256` char(64) NOT NULL,
  `conversion_profile_id` int NOT NULL,
  `conversion_profile_revision` int NOT NULL,
  `artifact_file_id` int NOT NULL,
  `output_sha256` char(64) NOT NULL,
  `output_mime` varchar(128) NOT NULL,
  `output_extension` varchar(16) NOT NULL,
  `tool_fingerprint` varchar(128) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `file_derivatives_source_profile_unique` (`source_file_id`, `source_file_version`, `conversion_profile_id`, `conversion_profile_revision`),
  KEY `file_derivatives_artifact_idx` (`artifact_file_id`),
  KEY `file_derivatives_source_hash_idx` (`source_sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sharepoint_transfer_jobs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `source_file_id` int NOT NULL,
  `artifact_file_id` int DEFAULT NULL,
  `target_binding_id` int NOT NULL,
  `operation_type` varchar(32) NOT NULL,
  `storage_key_snapshot` varchar(128) NOT NULL,
  `sha256_snapshot` char(64) NOT NULL,
  `file_name_snapshot` varchar(255) NOT NULL,
  `mime_snapshot` varchar(128) NOT NULL,
  `phase_snapshot` varchar(64) NOT NULL,
  `idempotency_key` char(64) NOT NULL,
  `correlation_id` char(36) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT 0,
  `run_after` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lease_token` char(36) DEFAULT NULL,
  `lease_expires_at` timestamp NULL DEFAULT NULL,
  `remote_item_id` varchar(512) DEFAULT NULL,
  `remote_etag` varchar(512) DEFAULT NULL,
  `remote_size_bytes` bigint DEFAULT NULL,
  `last_error` varchar(800) DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `cancelled_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sharepoint_transfer_jobs_idempotency_unique` (`idempotency_key`),
  KEY `sharepoint_transfer_jobs_claim_idx` (`status`, `run_after`, `lease_expires_at`),
  KEY `sharepoint_transfer_jobs_order_idx` (`order_id`),
  KEY `sharepoint_transfer_jobs_target_idx` (`target_binding_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Exact built-in profiles. Administrators may clone and disable these, but the
-- worker accepts only the fixed operation vocabulary represented below.
INSERT INTO `conversion_profiles` (`name`, `operation`, `settings_json`, `revision`, `tool_fingerprint`, `active`)
VALUES
  ('PDF to Word (reflow)', 'pdf_to_docx', JSON_OBJECT('quality', 'best_effort'), 1, 'native-local-v1', 1),
  ('PDF to text', 'pdf_to_text', JSON_OBJECT(), 1, 'native-local-v1', 1),
  ('Word to PDF', 'docx_to_pdf', JSON_OBJECT(), 1, 'native-local-v1', 1),
  ('Word to text', 'docx_to_text', JSON_OBJECT(), 1, 'native-local-v1', 1),
  ('Text to Word', 'text_to_docx', JSON_OBJECT(), 1, 'native-local-v1', 1),
  ('Text to PDF', 'text_to_pdf', JSON_OBJECT(), 1, 'native-local-v1', 1),
  ('PDF compression — balanced', 'pdf_compress_balanced', JSON_OBJECT('preset', 'ebook'), 1, 'native-local-v1', 1),
  ('PDF compression — small', 'pdf_compress_small', JSON_OBJECT('preset', 'screen'), 1, 'native-local-v1', 1),
  ('Audio to WebM/Opus', 'audio_to_webm', JSON_OBJECT('bitrateKbps', 64), 1, 'native-local-v1', 1)
ON DUPLICATE KEY UPDATE `updated_at` = `updated_at`;

-- Existing phase jobs used a name that no processor recognized. Normalize only
-- uncompleted legacy work; historical completed rows remain immutable evidence.
UPDATE `phase_jobs`
SET `job_type` = 'notify_webhooks'
WHERE `job_type` = 'dispatch_webhooks' AND `status` IN ('pending', 'running');
