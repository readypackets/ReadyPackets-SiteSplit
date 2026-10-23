-- Native mobile identity hardening and self-hosted notification baseline.
--
-- OAuth grants persist their scope across refresh rotation. Provider push-token
-- columns are removed because the self-hosted baseline uses authenticated
-- in-app updates and does not collect third-party messaging identifiers.

SET @rp_mobile_scopes_exists := (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'mobile_device_sessions'
     AND column_name = 'scopes'
);
SET @rp_mobile_scopes_add_sql := IF(
  @rp_mobile_scopes_exists = 0,
  'ALTER TABLE `mobile_device_sessions` ADD COLUMN `scopes` JSON NULL AFTER `user_id`',
  'SELECT 1'
);
PREPARE rp_mobile_scopes_add_stmt FROM @rp_mobile_scopes_add_sql;
EXECUTE rp_mobile_scopes_add_stmt;
DEALLOCATE PREPARE rp_mobile_scopes_add_stmt;

UPDATE `mobile_device_sessions`
   SET `scopes` = JSON_ARRAY('mobile:read', 'mobile:write')
 WHERE `scopes` IS NULL;

ALTER TABLE `mobile_device_sessions`
  MODIFY COLUMN `scopes` JSON NOT NULL;

SET @rp_mobile_push_hash_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'mobile_devices' AND column_name = 'push_token_hash'
);
SET @rp_mobile_push_hash_drop_sql := IF(
  @rp_mobile_push_hash_exists = 1,
  'ALTER TABLE `mobile_devices` DROP COLUMN `push_token_hash`',
  'SELECT 1'
);
PREPARE rp_mobile_push_hash_drop_stmt FROM @rp_mobile_push_hash_drop_sql;
EXECUTE rp_mobile_push_hash_drop_stmt;
DEALLOCATE PREPARE rp_mobile_push_hash_drop_stmt;

SET @rp_mobile_push_enc_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'mobile_devices' AND column_name = 'push_token_enc'
);
SET @rp_mobile_push_enc_drop_sql := IF(
  @rp_mobile_push_enc_exists = 1,
  'ALTER TABLE `mobile_devices` DROP COLUMN `push_token_enc`',
  'SELECT 1'
);
PREPARE rp_mobile_push_enc_drop_stmt FROM @rp_mobile_push_enc_drop_sql;
EXECUTE rp_mobile_push_enc_drop_stmt;
DEALLOCATE PREPARE rp_mobile_push_enc_drop_stmt;

SET @rp_mobile_push_platform_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'mobile_devices' AND column_name = 'push_platform'
);
SET @rp_mobile_push_platform_drop_sql := IF(
  @rp_mobile_push_platform_exists = 1,
  'ALTER TABLE `mobile_devices` DROP COLUMN `push_platform`',
  'SELECT 1'
);
PREPARE rp_mobile_push_platform_drop_stmt FROM @rp_mobile_push_platform_drop_sql;
EXECUTE rp_mobile_push_platform_drop_stmt;
DEALLOCATE PREPARE rp_mobile_push_platform_drop_stmt;
