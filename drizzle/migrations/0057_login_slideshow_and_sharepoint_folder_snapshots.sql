-- Bounded login slideshow copy uses local asset keys only. New order snapshots
-- preserve external SharePoint paths when users, customer IDs, or titles change.

ALTER TABLE login_page_config
  ADD COLUMN slideshow_slides JSON NULL AFTER accent_color;

ALTER TABLE orders
  ADD COLUMN sharepoint_customer_folder_enc TEXT NULL AFTER project_name_enc,
  ADD COLUMN sharepoint_order_folder_enc TEXT NULL AFTER sharepoint_customer_folder_enc;
