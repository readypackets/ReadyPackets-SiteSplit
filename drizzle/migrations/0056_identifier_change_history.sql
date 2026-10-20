-- Administrator-approved customer and order ID changes are append-only.
-- Retired values are globally unique so they can never be reissued.

CREATE TABLE IF NOT EXISTS customer_id_change_history (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  previous_customer_id VARCHAR(24) NOT NULL,
  new_customer_id VARCHAR(24) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  changed_by_user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY customer_id_change_history_previous_unique (previous_customer_id),
  KEY customer_id_change_history_user_created_idx (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_id_change_history (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  previous_order_number VARCHAR(64) NOT NULL,
  new_order_number VARCHAR(64) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  changed_by_user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY order_id_change_history_previous_unique (previous_order_number),
  KEY order_id_change_history_order_created_idx (order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
