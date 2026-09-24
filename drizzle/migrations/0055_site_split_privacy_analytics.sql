-- Site-split analytics settings. All providers remain disabled by default.
-- Bump the consent record version so an existing browser must make a fresh,
-- informed analytics choice after the dual-host architecture is deployed.
-- Existing administrator availability choices for the Analytics/Marketing
-- preference categories are preserved; this release does not silently turn a
-- category on or off.
INSERT INTO site_settings (setting_key, setting_value, value_type, category, description, is_secret, updated_at)
VALUES
  ('privacy.cookie_consent_version', '2026.09.24', 'string', 'privacy', 'Version of the cookie notice and preference record after the public-site and portal split.', 0, NOW()),
  ('privacy.analytics_clarity_enabled', 'false', 'boolean', 'privacy', 'Enables Microsoft Clarity only after an affirmative ReadyPackets analytics preference.', 0, NOW()),
  ('privacy.analytics_clarity_project_id', NULL, 'string', 'privacy', 'Microsoft Clarity project identifier. This value is write-only in administration.', 1, NOW()),
  ('privacy.analytics_posthog_enabled', 'false', 'boolean', 'privacy', 'Enables PostHog only after an affirmative ReadyPackets analytics preference.', 0, NOW()),
  ('privacy.analytics_posthog_project_key', NULL, 'string', 'privacy', 'PostHog browser project API key. This value is write-only in administration.', 1, NOW()),
  ('privacy.analytics_posthog_host', 'https://us.i.posthog.com', 'string', 'privacy', 'Approved PostHog ingestion region.', 0, NOW()),
  ('privacy.analytics_cross_site_enabled', 'false', 'boolean', 'privacy', 'Allows optional analytics continuity between the public site and portal after consent.', 0, NOW())
ON DUPLICATE KEY UPDATE
  setting_value = IF(setting_key = 'privacy.cookie_consent_version', VALUES(setting_value), setting_value),
  value_type = VALUES(value_type),
  category = VALUES(category),
  description = VALUES(description),
  is_secret = VALUES(is_secret),
  updated_at = NOW();
