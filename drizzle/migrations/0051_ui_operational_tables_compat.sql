-- Fresh-install and legacy-schema compatibility for operational UI features.
-- These tables are declared in the application schema and are created idempotently
-- so that an incomplete historical migration ledger cannot leave the portal
-- running with Security Centre or Site Settings query failures.

CREATE TABLE IF NOT EXISTS `site_settings` (
  `setting_key` varchar(96) NOT NULL,
  `setting_value` text DEFAULT NULL,
  `value_type` varchar(16) NOT NULL DEFAULT 'string',
  `category` varchar(48) NOT NULL DEFAULT 'general',
  `description` varchar(255) DEFAULT NULL,
  `is_secret` tinyint(1) NOT NULL DEFAULT 0,
  `updated_by_user_id` int DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`),
  KEY `site_settings_category_idx` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `inbound_webhook_listeners` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(128) NOT NULL,
  `slug` varchar(64) NOT NULL,
  `secret_hash` varchar(128) DEFAULT NULL,
  `event_type` varchar(128) DEFAULT NULL,
  `handler` varchar(128) NOT NULL DEFAULT 'log',
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `created_by_user_id` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `inbound_webhook_listeners_slug_idx` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `inbound_webhook_events` (
  `id` int NOT NULL AUTO_INCREMENT,
  `listener_id` int NOT NULL,
  `source_ip` varchar(64) DEFAULT NULL,
  `headers` json DEFAULT NULL,
  `payload` mediumtext DEFAULT NULL,
  `signature_valid` tinyint(1) DEFAULT NULL,
  `processed` tinyint(1) NOT NULL DEFAULT 0,
  `error` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `inbound_webhook_events_listener_idx` (`listener_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `portal_wizard_slides` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `subtitle` text DEFAULT NULL,
  `body_markdown` text DEFAULT NULL,
  `image_url` varchar(512) DEFAULT NULL,
  `cta_label` varchar(128) DEFAULT NULL,
  `cta_href` varchar(512) DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `target_audience` enum('all','new','returning') NOT NULL DEFAULT 'all',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `portal_wizard_slides_active_idx` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
