-- Bind approved SAML accounts to an opaque keyed subject index after their first
-- successful assertion. Raw SAML NameID/object identifiers are never stored.

SET @rp_saml_subject_index_exists := (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'users'
     AND column_name = 'saml_subject_index'
);
SET @rp_saml_subject_index_add_sql := IF(
  @rp_saml_subject_index_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `saml_subject_index` VARCHAR(64) NULL AFTER `saml_login_enabled`',
  'SELECT 1'
);
PREPARE rp_saml_subject_index_add_stmt FROM @rp_saml_subject_index_add_sql;
EXECUTE rp_saml_subject_index_add_stmt;
DEALLOCATE PREPARE rp_saml_subject_index_add_stmt;

SET @rp_saml_subject_config_id_exists := (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'users'
     AND column_name = 'saml_subject_config_id'
);
SET @rp_saml_subject_config_id_add_sql := IF(
  @rp_saml_subject_config_id_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `saml_subject_config_id` INT NULL AFTER `saml_subject_index`',
  'SELECT 1'
);
PREPARE rp_saml_subject_config_id_add_stmt FROM @rp_saml_subject_config_id_add_sql;
EXECUTE rp_saml_subject_config_id_add_stmt;
DEALLOCATE PREPARE rp_saml_subject_config_id_add_stmt;

SET @rp_users_saml_subject_unique_exists := (
  SELECT COUNT(*)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'users'
     AND index_name = 'users_saml_subject_unique'
);
SET @rp_users_saml_subject_unique_add_sql := IF(
  @rp_users_saml_subject_unique_exists = 0,
  'ALTER TABLE `users` ADD UNIQUE INDEX `users_saml_subject_unique` (`saml_subject_config_id`, `saml_subject_index`)',
  'SELECT 1'
);
PREPARE rp_users_saml_subject_unique_add_stmt FROM @rp_users_saml_subject_unique_add_sql;
EXECUTE rp_users_saml_subject_unique_add_stmt;
DEALLOCATE PREPARE rp_users_saml_subject_unique_add_stmt;
