-- Canonical Tier 3 feature-table compatibility migration.
--
-- The listed tables are present in server/db/schema.ts and actively queried by
-- administration routes, but were not represented in the authoritative
-- drizzle/migrations ledger. Create them idempotently so fresh and upgraded
-- environments cannot start with later runtime query failures.

CREATE TABLE IF NOT EXISTS `subscription_plans` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(128) NOT NULL,
  `slug` varchar(64) NOT NULL,
  `description` text DEFAULT NULL,
  `price_cents` int NOT NULL DEFAULT 0,
  `interval_days` int NOT NULL DEFAULT 30,
  `features` json DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `subscription_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `plan_id` int NOT NULL,
  `status` enum('active','paused','cancelled','expired') NOT NULL DEFAULT 'active',
  `current_period_start` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `current_period_end` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `cancelled_at` timestamp NULL DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `billing_events` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `order_id` int DEFAULT NULL,
  `event_type` varchar(64) NOT NULL,
  `amount_cents` int NOT NULL DEFAULT 0,
  `currency` char(3) NOT NULL DEFAULT 'USD',
  `provider` varchar(32) NOT NULL DEFAULT 'stripe',
  `provider_event_id` varchar(255) DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `crm_contacts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `first_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `company` varchar(200) DEFAULT NULL,
  `email_enc` text DEFAULT NULL,
  `email_index` varchar(64) DEFAULT NULL,
  `phone_enc` text DEFAULT NULL,
  `source` varchar(64) DEFAULT NULL,
  `status` enum('lead','prospect','customer','churned','blocked') NOT NULL DEFAULT 'lead',
  `owner_user_id` int DEFAULT NULL,
  `tags` json DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `crm_notes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `contact_id` int NOT NULL,
  `author_user_id` int NOT NULL,
  `body` text NOT NULL,
  `note_type` enum('call','email','meeting','note','task') NOT NULL DEFAULT 'note',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `crm_tags` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(64) NOT NULL,
  `color` varchar(16) NOT NULL DEFAULT '#6b7280',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_sessions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `session_type` varchar(64) NOT NULL DEFAULT 'chat',
  `model` varchar(128) NOT NULL,
  `title` varchar(255) DEFAULT NULL,
  `status` enum('active','completed','archived') NOT NULL DEFAULT 'active',
  `token_count` int NOT NULL DEFAULT 0,
  `cost_micro_usd` int NOT NULL DEFAULT 0,
  `metadata` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_messages` (
  `id` int NOT NULL AUTO_INCREMENT,
  `session_id` int NOT NULL,
  `role` enum('system','user','assistant','tool') NOT NULL,
  `content` mediumtext NOT NULL,
  `token_count` int NOT NULL DEFAULT 0,
  `finish_reason` varchar(32) DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_response_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `session_id` int DEFAULT NULL,
  `message_id` int DEFAULT NULL,
  `model` varchar(128) NOT NULL,
  `prompt_tokens` int NOT NULL DEFAULT 0,
  `completion_tokens` int NOT NULL DEFAULT 0,
  `latency_ms` int NOT NULL DEFAULT 0,
  `finish_reason` varchar(32) DEFAULT NULL,
  `error` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `api_key_rate_limits` (
  `id` int NOT NULL AUTO_INCREMENT,
  `api_key_id` int NOT NULL,
  `window_seconds` int NOT NULL DEFAULT 60,
  `max_requests` int NOT NULL DEFAULT 100,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `api_request_logs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `api_key_id` int DEFAULT NULL,
  `method` varchar(8) NOT NULL,
  `path` varchar(512) NOT NULL,
  `status_code` smallint NOT NULL,
  `latency_ms` int NOT NULL DEFAULT 0,
  `ip_address` varchar(64) DEFAULT NULL,
  `user_agent` varchar(512) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `api_action_logs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `api_key_id` int DEFAULT NULL,
  `action` varchar(128) NOT NULL,
  `entity_type` varchar(64) DEFAULT NULL,
  `entity_id` int DEFAULT NULL,
  `result` varchar(32) NOT NULL DEFAULT 'success',
  `detail` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `availability_slots` (
  `id` int NOT NULL AUTO_INCREMENT,
  `owner_user_id` int NOT NULL,
  `slot_type` varchar(64) NOT NULL DEFAULT 'consultation',
  `starts_at` timestamp NOT NULL,
  `ends_at` timestamp NOT NULL,
  `duration_minutes` int NOT NULL DEFAULT 30,
  `max_bookings` int NOT NULL DEFAULT 1,
  `current_bookings` int NOT NULL DEFAULT 0,
  `is_available` tinyint(1) NOT NULL DEFAULT 1,
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `meeting_bookings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `slot_id` int NOT NULL,
  `customer_user_id` int NOT NULL,
  `order_id` int DEFAULT NULL,
  `status` enum('pending','confirmed','cancelled','completed','no_show') NOT NULL DEFAULT 'pending',
  `notes` text DEFAULT NULL,
  `confirmation_token` varchar(128) DEFAULT NULL,
  `confirmed_at` timestamp NULL DEFAULT NULL,
  `cancelled_at` timestamp NULL DEFAULT NULL,
  `cancel_reason` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pwa_ab_variants` (
  `id` int NOT NULL AUTO_INCREMENT,
  `experiment_key` varchar(128) NOT NULL,
  `variant_key` varchar(64) NOT NULL,
  `description` text DEFAULT NULL,
  `weight` int NOT NULL DEFAULT 50,
  `is_control` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pwa_ab_events` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `experiment_key` varchar(128) NOT NULL,
  `variant_key` varchar(64) NOT NULL,
  `user_id` int DEFAULT NULL,
  `session_id` varchar(128) DEFAULT NULL,
  `event_type` varchar(64) NOT NULL DEFAULT 'impression',
  `metadata` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `admin_nav_preferences` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `pinned_items` json DEFAULT NULL,
  `collapsed_sections` json DEFAULT NULL,
  `default_view` varchar(64) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pinned_quick_add` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `action_key` varchar(64) NOT NULL,
  `label` varchar(128) NOT NULL,
  `href` varchar(512) NOT NULL,
  `sort_order` int NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `support_permissions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `can_view_all_tickets` tinyint(1) NOT NULL DEFAULT 0,
  `can_close_tickets` tinyint(1) NOT NULL DEFAULT 0,
  `can_assign_tickets` tinyint(1) NOT NULL DEFAULT 0,
  `can_view_customer_pii` tinyint(1) NOT NULL DEFAULT 0,
  `can_issue_refunds` tinyint(1) NOT NULL DEFAULT 0,
  `ticket_categories` json DEFAULT NULL,
  `granted_by_user_id` int NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `feature_toggle_schedules` (
  `id` int NOT NULL AUTO_INCREMENT,
  `flag_key` varchar(128) NOT NULL,
  `scheduled_value` tinyint(1) NOT NULL,
  `scheduled_at` timestamp NOT NULL,
  `executed_at` timestamp NULL DEFAULT NULL,
  `created_by_user_id` int DEFAULT NULL,
  `note` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `email_automation_rate_limits` (
  `id` int NOT NULL AUTO_INCREMENT,
  `automation_id` int NOT NULL,
  `user_id` int NOT NULL,
  `sent_count` int NOT NULL DEFAULT 0,
  `window_start` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
