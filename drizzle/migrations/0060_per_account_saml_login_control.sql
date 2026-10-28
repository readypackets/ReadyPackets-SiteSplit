-- Per-account SAML sign-in control.
--
-- Existing accounts retain their current SAML eligibility. An administrator may
-- explicitly disable SAML for one account when moving it to local-only login.

SET @rp_saml_login_enabled_exists := (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'users'
     AND column_name = 'saml_login_enabled'
);
SET @rp_saml_login_enabled_add_sql := IF(
  @rp_saml_login_enabled_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `saml_login_enabled` BOOLEAN NOT NULL DEFAULT TRUE AFTER `login_method`',
  'SELECT 1'
);
PREPARE rp_saml_login_enabled_add_stmt FROM @rp_saml_login_enabled_add_sql;
EXECUTE rp_saml_login_enabled_add_stmt;
DEALLOCATE PREPARE rp_saml_login_enabled_add_stmt;
