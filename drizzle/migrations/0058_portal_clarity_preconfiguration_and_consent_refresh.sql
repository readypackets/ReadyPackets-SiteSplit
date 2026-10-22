-- Portal-specific Microsoft Clarity preconfiguration.
-- The public project identifier is intentionally inert: this migration neither
-- enables the provider nor makes Analytics consent available. An MFA-protected
-- administrator must complete both explicit enablement steps in the Portal.
-- Refresh consent so no historical approval silently covers this new provider
-- configuration and scope. Existing operator-provided provider values win.
INSERT INTO site_settings (setting_key, setting_value, value_type, category, description, is_secret, updated_at)
VALUES
  ('privacy.cookie_consent_version', '2026.10.22', 'string', 'privacy', 'Version of the cookie consent notice after Portal-specific, consent-gated Microsoft Clarity configuration.', 0, NOW()),
  ('privacy.analytics_clarity_project_id', 'z1vdbjl7z3', 'string', 'privacy', 'Portal Microsoft Clarity project identifier. This browser-visible value is write-only in administration and remains inert until explicitly enabled.', 1, NOW())
ON DUPLICATE KEY UPDATE
  setting_value = CASE
    WHEN setting_key = 'privacy.cookie_consent_version' THEN VALUES(setting_value)
    WHEN setting_key = 'privacy.analytics_clarity_project_id'
      AND (setting_value IS NULL OR TRIM(setting_value) = '') THEN VALUES(setting_value)
    ELSE setting_value
  END,
  value_type = VALUES(value_type),
  category = VALUES(category),
  description = VALUES(description),
  is_secret = VALUES(is_secret),
  updated_at = NOW();
