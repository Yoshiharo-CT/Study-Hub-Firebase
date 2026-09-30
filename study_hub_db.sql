-- ============================================================
-- Study Hub — FULL SCHEMA (v2)
-- Base: the study_hub_db.sql you uploaded (kept intact below,
-- table-for-table) PLUS everything Phase 0–11 of the flow doc
-- needs that wasn't in the original dump yet:
--
--   NEW TABLES   : notifications, audit_log, walkin_queue,
--                  space_maintenance, promotions
--   NEW COLUMNS  : space_sessions.wifi_password
--                  billing_transactions.subtotal / discount_amount /
--                  promotion_id
--                  payments.notes
--   NEW VIEWS    : v_daily_revenue, v_active_sessions
--   NEW USER     : Import this file fresh (it DROPs+recreates
--                  every table) — do not import on top of the
--                  old dump, it will conflict on the ALTERs below.
-- ============================================================

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET FOREIGN_KEY_CHECKS = 0;
START TRANSACTION;
SET time_zone = "+00:00";
SET NAMES utf8mb4;

DROP TABLE IF EXISTS `printing_jobs`, `order_items`, `orders`, `session_extensions`,
  `space_sessions`, `reservations`, `space_maintenance`, `walkin_queue`,
  `payments`, `billing_transactions`, `notifications`, `audit_log`,
  `study_spaces`, `products_services`, `staff`, `customers`,
  `space_types`, `product_categories`, `staff_roles`, `payment_methods`,
  `paper_sizes`, `print_types`, `promotions`, `users`;

DROP VIEW IF EXISTS `v_customer_reservations`, `v_customer_sessions`,
  `v_payment_records`, `v_study_space_availability`, `v_daily_revenue`,
  `v_active_sessions`;

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
CREATE TABLE `users` (
  `user_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` varchar(100) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `account_type` enum('customer','staff') NOT NULL,
  `account_status` enum('active','inactive','suspended') NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `users` (`user_id`, `username`, `password_hash`, `account_type`, `account_status`, `created_at`, `updated_at`) VALUES
(1, 'juan.delacruz', '$2y$10$PnYHhSnG7odiSBULLlEmRO8saZdttD7BnInxBRmgHMWksgRMMCGkm', 'customer', 'active', NOW(), NOW()),
(2, 'maria.santos', '$2y$10$6HsxzXpeaMh/eGN/2OV7/.Pb50bsqUWnub/SrFfSYUhr7WWIfFaQK', 'customer', 'active', NOW(), NOW()),
(3, 'pedro.reyes', '$2y$10$gyWuNlt9kamNFMPh/7YxP.yg7R10mve72h6fW5BgdpeijF6GKl6BK', 'customer', 'active', NOW(), NOW()),
(4, 'ana.garcia', '$2y$10$5ZSPOGE0gD/UR6OOrgv57.zPGciIR4xFYjfv3z4a/.jg0RFk894T6', 'customer', 'active', NOW(), NOW()),
(5, 'carlo.mendoza', '$2y$10$t/chyzCAEoj8SPM9w8f.WOOMNi5kc.dJTlPf9y6sBeWslrhD73DqW', 'staff', 'active', NOW(), NOW()),
(6, 'liza.torres', '$2y$10$1otKMByoMbM/vki2vOSN2O78PhK0DZoipSf9a7.DlPyW0kcoPummS', 'staff', 'active', NOW(), NOW()),
(7, 'mark.villanueva', '$2y$10$yrbB7uifBcZpFdsnm5QO8eF.EWs2eK0eMXHnR9aE3/bdLbWZ2jDWC', 'staff', 'active', NOW(), NOW()),
(8, 'rica.fernandez', '$2y$10$LiPFyn2jOZD0WoyEzuGMIeSNlbB.TLcmsSvi5VJZc4xQN5.L0UfT6', 'staff', 'active', NOW(), NOW()),
(9, 'admin', '$2y$10$f2u3KDsgi1EioUHeABfmAOrrijSiROlkstJVPOiJFdIrCSOyfwiSC', 'staff', 'active', NOW(), NOW());
ALTER TABLE `users` AUTO_INCREMENT = 10;

-- ------------------------------------------------------------
-- staff_roles
-- ------------------------------------------------------------
CREATE TABLE `staff_roles` (
  `role_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `role_name` varchar(50) NOT NULL,
  `description` varchar(255) NOT NULL,
  `permissions` varchar(255) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`role_id`),
  UNIQUE KEY `role_name` (`role_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `staff_roles` (`role_id`, `role_name`, `description`, `permissions`, `is_active`) VALUES
(1, 'Owner/Manager', 'Manages the overall Study Hub operations.', 'dashboard,customers,spaces,reservations,sessions,orders,billing,payments,staff,walkins,promotions,maintenance,notifications,reports', 1),
(2, 'Staff', 'Manages daily customer and study space operations.', 'dashboard,customers,spaces,reservations,sessions,orders,walkins,notifications', 1),
(3, 'Cashier', 'Manages customer payments and transaction records.', 'dashboard,orders,billing,payments,notifications', 1),
(4, 'Assistant Manager', 'Assists in overseeing daily Study Hub operations.', 'dashboard,customers,spaces,reservations,sessions,orders,billing,payments,staff,walkins,promotions,maintenance,notifications,reports', 1);
ALTER TABLE `staff_roles` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- staff
-- ------------------------------------------------------------
CREATE TABLE `staff` (
  `staff_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int(10) UNSIGNED DEFAULT NULL,
  `role_id` int(10) UNSIGNED NOT NULL,
  `first_name` varchar(50) NOT NULL,
  `last_name` varchar(50) NOT NULL,
  `phone_number` varchar(20) NOT NULL,
  PRIMARY KEY (`staff_id`),
  UNIQUE KEY `user_id` (`user_id`),
  KEY `fk_staff_role` (`role_id`),
  CONSTRAINT `fk_staff_role` FOREIGN KEY (`role_id`) REFERENCES `staff_roles` (`role_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_staff_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `staff` (`staff_id`, `user_id`, `role_id`, `first_name`, `last_name`, `phone_number`) VALUES
(1, 5, 2, 'Carlo', 'Mendoza', '09211234567'),
(2, 6, 2, 'Liza', 'Torres', '09221234567'),
(3, 7, 3, 'Mark', 'Villanueva', '09231234567'),
(4, 8, 3, 'Rica', 'Fernandez', '09241234567'),
(5, 9, 1, 'System', 'Admin', '0000000000');
ALTER TABLE `staff` AUTO_INCREMENT = 6;

-- ------------------------------------------------------------
-- customers
-- ------------------------------------------------------------
CREATE TABLE `customers` (
  `customer_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int(10) UNSIGNED DEFAULT NULL,
  `first_name` varchar(50) NOT NULL,
  `last_name` varchar(50) NOT NULL,
  `phone_number` varchar(20) NOT NULL,
  `email` varchar(100) NOT NULL,
  PRIMARY KEY (`customer_id`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `user_id` (`user_id`),
  CONSTRAINT `fk_customers_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `customers` (`customer_id`, `user_id`, `first_name`, `last_name`, `phone_number`, `email`) VALUES
(1, 1, 'Juan', 'Dela Cruz', '09171234567', 'juan.delacruz@email.com'),
(2, 2, 'Maria', 'Santos', '09181234567', 'maria.santos@email.com'),
(3, 3, 'Pedro', 'Reyes', '09191234567', 'pedro.reyes@email.com'),
(4, 4, 'Ana', 'Garcia', '09201234567', 'ana.garcia@email.com');
ALTER TABLE `customers` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- space_types / study_spaces
-- ------------------------------------------------------------
CREATE TABLE `space_types` (
  `space_type_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `type_name` varchar(50) NOT NULL,
  `base_rate` decimal(10,2) NOT NULL DEFAULT 0.00,
  `default_capacity` int(10) UNSIGNED NOT NULL,
  `description` varchar(255) NOT NULL,
  PRIMARY KEY (`space_type_id`),
  UNIQUE KEY `type_name` (`type_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `space_types` (`space_type_id`, `type_name`, `base_rate`, `default_capacity`, `description`) VALUES
(1, 'Individual Desk', 30.00, 1, 'Individual study space.'),
(2, 'Small Couch', 50.00, 2, 'Small couch study space.'),
(3, 'Round Table', 60.00, 4, 'Round table suitable for small groups.'),
(4, 'Big Table', 80.00, 8, 'Large table suitable for bigger groups.'),
(5, 'Private Room Corner', 100.00, 6, 'Small private study room or corner.');
ALTER TABLE `space_types` AUTO_INCREMENT = 6;

CREATE TABLE `study_spaces` (
  `space_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `space_type_id` int(10) UNSIGNED NOT NULL,
  `space_name` varchar(50) NOT NULL,
  `status` enum('available','occupied','reserved','maintenance','inactive') NOT NULL DEFAULT 'available',
  `capacity` int(10) UNSIGNED NOT NULL,
  PRIMARY KEY (`space_id`),
  UNIQUE KEY `space_name` (`space_name`),
  KEY `fk_study_spaces_type` (`space_type_id`),
  CONSTRAINT `fk_study_spaces_type` FOREIGN KEY (`space_type_id`) REFERENCES `space_types` (`space_type_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `study_spaces` (`space_id`, `space_type_id`, `space_name`, `status`, `capacity`) VALUES
(1, 1, 'Desk A1', 'available', 1),
(2, 2, 'Couch B1', 'available', 2),
(3, 3, 'Round Table C1', 'available', 4),
(4, 4, 'Big Table D1', 'available', 8);
ALTER TABLE `study_spaces` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- NEW: space_maintenance (Phase 10.3 / 11.2)
-- ------------------------------------------------------------
CREATE TABLE `space_maintenance` (
  `maintenance_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `space_id` int(10) UNSIGNED NOT NULL,
  `start_datetime` datetime NOT NULL,
  `end_datetime` datetime NOT NULL,
  `reason` varchar(255) DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `status` enum('scheduled','active','completed','cancelled') NOT NULL DEFAULT 'scheduled',
  PRIMARY KEY (`maintenance_id`),
  KEY `fk_maint_space` (`space_id`),
  KEY `fk_maint_staff` (`created_by`),
  CONSTRAINT `fk_maint_space` FOREIGN KEY (`space_id`) REFERENCES `study_spaces` (`space_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_maint_staff` FOREIGN KEY (`created_by`) REFERENCES `staff` (`staff_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------
-- reservations
-- ------------------------------------------------------------
CREATE TABLE `reservations` (
  `reservation_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `space_id` int(10) UNSIGNED NOT NULL,
  `reservation_date` date NOT NULL,
  `start_time` time NOT NULL,
  `end_time` time NOT NULL,
  `number_of_people` int(10) UNSIGNED NOT NULL,
  `status` enum('pending','confirmed','cancelled','completed','no_show') NOT NULL DEFAULT 'pending',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`reservation_id`),
  KEY `idx_reservations_customer` (`customer_id`),
  KEY `idx_reservations_space_date` (`space_id`,`reservation_date`),
  CONSTRAINT `chk_reservation_time` CHECK (`end_time` > `start_time`),
  CONSTRAINT `chk_reservation_people` CHECK (`number_of_people` > 0),
  CONSTRAINT `fk_reservations_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`customer_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_reservations_space` FOREIGN KEY (`space_id`) REFERENCES `study_spaces` (`space_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `reservations` (`reservation_id`, `customer_id`, `space_id`, `reservation_date`, `start_time`, `end_time`, `number_of_people`, `status`) VALUES
(1, 1, 1, '2026-10-01', '09:00:00', '12:00:00', 1, 'confirmed'),
(2, 2, 2, '2026-10-01', '13:00:00', '15:00:00', 2, 'confirmed'),
(3, 3, 3, '2026-10-02', '10:00:00', '13:00:00', 4, 'pending'),
(4, 4, 4, '2026-10-03', '14:00:00', '18:00:00', 6, 'completed');
ALTER TABLE `reservations` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- space_sessions  (+ NEW wifi_password column)
-- ------------------------------------------------------------
CREATE TABLE `space_sessions` (
  `session_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `space_id` int(10) UNSIGNED NOT NULL,
  `reservation_id` int(10) UNSIGNED DEFAULT NULL,
  `check_in_time` datetime NOT NULL,
  `wifi_password` varchar(20) DEFAULT NULL,
  `check_out_time` datetime DEFAULT NULL,
  `study_fee` decimal(10,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (`session_id`),
  UNIQUE KEY `reservation_id` (`reservation_id`),
  KEY `idx_sessions_customer` (`customer_id`),
  KEY `idx_sessions_space` (`space_id`),
  CONSTRAINT `fk_sessions_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`customer_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_sessions_reservation` FOREIGN KEY (`reservation_id`) REFERENCES `reservations` (`reservation_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_sessions_space` FOREIGN KEY (`space_id`) REFERENCES `study_spaces` (`space_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `space_sessions` (`session_id`, `customer_id`, `space_id`, `reservation_id`, `check_in_time`, `wifi_password`, `check_out_time`, `study_fee`) VALUES
(1, 1, 1, 1, '2026-10-01 09:05:00', 'SH-9F31KQ', '2026-10-01 11:55:00', 30.00),
(2, 2, 2, 2, '2026-10-01 13:10:00', 'SH-2A77LM', '2026-10-01 14:50:00', 50.00),
(3, 3, 3, NULL, '2026-09-25 10:00:00', 'SH-QW58ZT', '2026-09-25 12:00:00', 60.00),
(4, 4, 4, 4, '2026-10-03 14:00:00', 'SH-88XKPD', '2026-10-03 17:50:00', 80.00);
ALTER TABLE `space_sessions` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- session_extensions
-- ------------------------------------------------------------
CREATE TABLE `session_extensions` (
  `extension_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` int(10) UNSIGNED NOT NULL,
  `extension_start` datetime NOT NULL,
  `extension_end` datetime NOT NULL,
  `additional_amount` decimal(10,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (`extension_id`),
  KEY `idx_extensions_session` (`session_id`),
  CONSTRAINT `fk_extensions_session` FOREIGN KEY (`session_id`) REFERENCES `space_sessions` (`session_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `session_extensions` (`extension_id`, `session_id`, `extension_start`, `extension_end`, `additional_amount`) VALUES
(1, 1, '2026-10-01 11:55:00', '2026-10-01 12:55:00', 15.00),
(2, 2, '2026-10-01 14:50:00', '2026-10-01 15:20:00', 10.00),
(3, 3, '2026-09-25 12:00:00', '2026-09-25 13:00:00', 20.00),
(4, 4, '2026-10-03 17:50:00', '2026-10-03 18:30:00', 25.00);
ALTER TABLE `session_extensions` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- NEW: walkin_queue (Phase 4.2)
-- ------------------------------------------------------------
CREATE TABLE `walkin_queue` (
  `queue_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `space_type_id` int(10) UNSIGNED NOT NULL,
  `queued_at` datetime NOT NULL DEFAULT current_timestamp(),
  `served_at` datetime DEFAULT NULL,
  `status` enum('waiting','served','cancelled') NOT NULL DEFAULT 'waiting',
  PRIMARY KEY (`queue_id`),
  KEY `fk_walkin_customer` (`customer_id`),
  KEY `fk_walkin_type` (`space_type_id`),
  CONSTRAINT `fk_walkin_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`customer_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_walkin_type` FOREIGN KEY (`space_type_id`) REFERENCES `space_types` (`space_type_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------
-- product_categories / products_services
-- ------------------------------------------------------------
CREATE TABLE `product_categories` (
  `category_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_name` varchar(50) NOT NULL,
  `description` varchar(255) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`category_id`),
  UNIQUE KEY `category_name` (`category_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `product_categories` (`category_id`, `category_name`, `description`, `is_active`) VALUES
(1, 'Food', 'Food products offered by the Study Hub.', 1),
(2, 'Drinks', 'Drinks and beverages offered by the Study Hub.', 1),
(3, 'Printing', 'Printing-related services.', 1),
(4, 'Other Services', 'Other additional services offered by the Study Hub.', 1);
ALTER TABLE `product_categories` AUTO_INCREMENT = 5;

CREATE TABLE `products_services` (
  `product_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_id` int(10) UNSIGNED NOT NULL,
  `item_name` varchar(100) NOT NULL,
  `unit_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `stock_quantity` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`product_id`),
  KEY `idx_products_category` (`category_id`),
  CONSTRAINT `fk_products_category` FOREIGN KEY (`category_id`) REFERENCES `product_categories` (`category_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `products_services` (`product_id`, `category_id`, `item_name`, `unit_price`, `stock_quantity`) VALUES
(1, 1, 'French Fries', 50.00, 100),
(2, 2, 'Bottled Water', 20.00, 100),
(3, 3, 'Black and White Printing', 5.00, 1000),
(4, 3, 'Color Printing', 10.00, 1000),
(5, 2, 'Iced Coffee', 60.00, 100),
(6, 4, 'Locker Rental', 25.00, 20);
ALTER TABLE `products_services` AUTO_INCREMENT = 7;

-- ------------------------------------------------------------
-- paper_sizes / print_types / printing_jobs
-- ------------------------------------------------------------
CREATE TABLE `paper_sizes` (
  `paper_size_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `size_name` varchar(20) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`paper_size_id`),
  UNIQUE KEY `size_name` (`size_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `paper_sizes` (`paper_size_id`, `size_name`, `is_active`) VALUES
(1, 'A4', 1), (2, 'Letter', 1), (3, 'Legal', 1), (4, 'Short Bond', 1);
ALTER TABLE `paper_sizes` AUTO_INCREMENT = 5;

CREATE TABLE `print_types` (
  `print_type_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `type_name` varchar(20) NOT NULL,
  `label` varchar(50) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`print_type_id`),
  UNIQUE KEY `type_name` (`type_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `print_types` (`print_type_id`, `type_name`, `label`, `is_active`) VALUES
(1, 'black_white', 'Black & White', 1), (2, 'color', 'Color', 1);
ALTER TABLE `print_types` AUTO_INCREMENT = 3;

-- ------------------------------------------------------------
-- orders / order_items / printing_jobs
-- ------------------------------------------------------------
CREATE TABLE `orders` (
  `order_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `staff_id` int(10) UNSIGNED NOT NULL,
  `session_id` int(10) UNSIGNED DEFAULT NULL,
  `order_datetime` datetime NOT NULL DEFAULT current_timestamp(),
  `total_amount` decimal(10,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (`order_id`),
  KEY `idx_orders_customer` (`customer_id`),
  KEY `idx_orders_staff` (`staff_id`),
  KEY `idx_orders_session` (`session_id`),
  CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`customer_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_orders_staff` FOREIGN KEY (`staff_id`) REFERENCES `staff` (`staff_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_orders_session` FOREIGN KEY (`session_id`) REFERENCES `space_sessions` (`session_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `orders` (`order_id`, `customer_id`, `staff_id`, `session_id`, `order_datetime`, `total_amount`) VALUES
(1, 1, 2, 1, '2026-10-01 09:30:00', 60.00),
(2, 2, 3, 2, '2026-10-01 13:20:00', 70.00),
(3, 3, 2, 3, '2026-09-25 10:15:00', 85.00),
(4, 4, 3, 4, '2026-10-03 14:30:00', 65.00);
ALTER TABLE `orders` AUTO_INCREMENT = 5;

CREATE TABLE `order_items` (
  `order_item_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` int(10) UNSIGNED NOT NULL,
  `product_id` int(10) UNSIGNED NOT NULL,
  `quantity` int(10) UNSIGNED NOT NULL,
  `subtotal` decimal(10,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (`order_item_id`),
  KEY `idx_order_items_order` (`order_id`),
  KEY `idx_order_items_product` (`product_id`),
  CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`order_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_order_items_product` FOREIGN KEY (`product_id`) REFERENCES `products_services` (`product_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `order_items` (`order_item_id`, `order_id`, `product_id`, `quantity`, `subtotal`) VALUES
(1, 1, 1, 1, 50.00), (2, 1, 3, 2, 10.00), (3, 2, 2, 2, 40.00), (4, 2, 4, 3, 30.00),
(5, 3, 3, 5, 25.00), (6, 3, 5, 1, 60.00), (7, 4, 4, 4, 40.00), (8, 4, 6, 1, 25.00);
ALTER TABLE `order_items` AUTO_INCREMENT = 9;

CREATE TABLE `printing_jobs` (
  `print_job_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_item_id` int(10) UNSIGNED NOT NULL,
  `paper_size_id` int(10) UNSIGNED NOT NULL,
  `print_type_id` int(10) UNSIGNED NOT NULL,
  `page_count` int(10) UNSIGNED NOT NULL,
  PRIMARY KEY (`print_job_id`),
  UNIQUE KEY `order_item_id` (`order_item_id`),
  KEY `idx_printing_jobs_paper_size` (`paper_size_id`),
  KEY `idx_printing_jobs_print_type` (`print_type_id`),
  CONSTRAINT `fk_printing_jobs_order_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`order_item_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_printing_jobs_paper_size` FOREIGN KEY (`paper_size_id`) REFERENCES `paper_sizes` (`paper_size_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_printing_jobs_print_type` FOREIGN KEY (`print_type_id`) REFERENCES `print_types` (`print_type_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `printing_jobs` (`print_job_id`, `order_item_id`, `paper_size_id`, `print_type_id`, `page_count`) VALUES
(1, 2, 1, 1, 2), (2, 4, 1, 2, 3), (3, 5, 4, 1, 5), (4, 7, 1, 2, 4);
ALTER TABLE `printing_jobs` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- NEW: promotions (Phase 6.4)
-- ------------------------------------------------------------
CREATE TABLE `promotions` (
  `promotion_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` varchar(30) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `discount_type` enum('percent','fixed') NOT NULL DEFAULT 'percent',
  `discount_value` decimal(10,2) NOT NULL DEFAULT 0.00,
  `valid_from` date NOT NULL,
  `valid_to` date NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`promotion_id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `promotions` (`promotion_id`, `code`, `description`, `discount_type`, `discount_value`, `valid_from`, `valid_to`, `is_active`) VALUES
(1, 'WELCOME10', '10% off for new/returning customers.', 'percent', 10.00, '2026-01-01', '2026-12-31', 1),
(2, 'STUDY50', '₱50 flat off.', 'fixed', 50.00, '2026-01-01', '2026-12-31', 1);
ALTER TABLE `promotions` AUTO_INCREMENT = 3;

-- ------------------------------------------------------------
-- payment_methods
-- ------------------------------------------------------------
CREATE TABLE `payment_methods` (
  `payment_method_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `method_name` varchar(50) NOT NULL,
  `description` varchar(255) NOT NULL,
  `is_online` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`payment_method_id`),
  UNIQUE KEY `method_name` (`method_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `payment_methods` (`payment_method_id`, `method_name`, `description`, `is_online`, `is_active`) VALUES
(1, 'Cash', 'Cash payment made at the Study Hub.', 0, 1),
(2, 'GCash', 'GCash payment used for online and walk-in transactions.', 1, 1),
(3, 'Bank Transfer', 'Direct bank transfer payment.', 1, 1),
(4, 'Credit/Debit Card', 'Card payment processed via POS terminal.', 0, 1);
ALTER TABLE `payment_methods` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- billing_transactions (+ subtotal / discount_amount / promotion_id)
-- ------------------------------------------------------------
CREATE TABLE `billing_transactions` (
  `transaction_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `reservation_id` int(10) UNSIGNED DEFAULT NULL,
  `session_id` int(10) UNSIGNED DEFAULT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `promotion_id` int(10) UNSIGNED DEFAULT NULL,
  `transaction_date` datetime NOT NULL DEFAULT current_timestamp(),
  `subtotal` decimal(10,2) NOT NULL DEFAULT 0.00,
  `discount_amount` decimal(10,2) NOT NULL DEFAULT 0.00,
  `total_amount` decimal(10,2) NOT NULL DEFAULT 0.00,
  `status` enum('pending','partially_paid','paid','cancelled') NOT NULL DEFAULT 'pending',
  PRIMARY KEY (`transaction_id`),
  KEY `idx_transactions_customer` (`customer_id`),
  KEY `idx_transactions_reservation` (`reservation_id`),
  KEY `idx_transactions_session` (`session_id`),
  KEY `idx_transactions_order` (`order_id`),
  KEY `fk_transactions_promotion` (`promotion_id`),
  CONSTRAINT `fk_transactions_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`customer_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_transactions_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`order_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_transactions_reservation` FOREIGN KEY (`reservation_id`) REFERENCES `reservations` (`reservation_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_transactions_session` FOREIGN KEY (`session_id`) REFERENCES `space_sessions` (`session_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_transactions_promotion` FOREIGN KEY (`promotion_id`) REFERENCES `promotions` (`promotion_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `billing_transactions` (`transaction_id`, `customer_id`, `reservation_id`, `session_id`, `order_id`, `promotion_id`, `transaction_date`, `subtotal`, `discount_amount`, `total_amount`, `status`) VALUES
(1, 1, 1, 1, 1, NULL, '2026-10-01 12:00:00', 105.00, 0.00, 105.00, 'paid'),
(2, 2, 2, 2, 2, NULL, '2026-10-01 15:00:00', 130.00, 0.00, 130.00, 'paid'),
(3, 3, NULL, 3, 3, NULL, '2026-09-25 12:15:00', 165.00, 0.00, 165.00, 'partially_paid'),
(4, 4, 4, 4, 4, NULL, '2026-10-03 18:00:00', 170.00, 0.00, 170.00, 'pending');
ALTER TABLE `billing_transactions` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- payments (+ NEW notes column)
-- ------------------------------------------------------------
CREATE TABLE `payments` (
  `payment_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `transaction_id` int(10) UNSIGNED DEFAULT NULL,
  `reference_number` varchar(100) DEFAULT NULL,
  `payment_status` enum('pending','verified','rejected','refunded') NOT NULL DEFAULT 'pending',
  `payment_method_id` int(10) UNSIGNED NOT NULL,
  `verified_by` int(10) UNSIGNED DEFAULT NULL,
  `amount_paid` decimal(10,2) NOT NULL DEFAULT 0.00,
  `payment_date` datetime NOT NULL DEFAULT current_timestamp(),
  `notes` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`payment_id`),
  KEY `idx_payments_customer` (`customer_id`),
  KEY `idx_payments_transaction` (`transaction_id`),
  KEY `idx_payments_method` (`payment_method_id`),
  KEY `idx_payments_verified_by` (`verified_by`),
  CONSTRAINT `fk_payments_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`customer_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_payments_method` FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods` (`payment_method_id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_payments_transaction` FOREIGN KEY (`transaction_id`) REFERENCES `billing_transactions` (`transaction_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_payments_verified_by` FOREIGN KEY (`verified_by`) REFERENCES `staff` (`staff_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `payments` (`payment_id`, `customer_id`, `transaction_id`, `reference_number`, `payment_status`, `payment_method_id`, `verified_by`, `amount_paid`, `payment_date`) VALUES
(1, 1, 1, 'GC-0001', 'verified', 2, 5, 105.00, '2026-10-01 12:05:00'),
(2, 2, 2, NULL, 'verified', 1, 5, 130.00, '2026-10-01 15:05:00'),
(3, 3, 3, 'BT-0003', 'pending', 3, NULL, 100.00, '2026-09-25 12:20:00'),
(4, 4, 4, 'CC-0004', 'pending', 4, NULL, 0.00, '2026-10-03 18:05:00');
ALTER TABLE `payments` AUTO_INCREMENT = 5;

-- ------------------------------------------------------------
-- NEW: receipts (Phase 8.4)
-- ------------------------------------------------------------
CREATE TABLE `receipts` (
  `receipt_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `transaction_id` int(10) UNSIGNED NOT NULL,
  `receipt_number` varchar(40) NOT NULL,
  `total_paid` decimal(10,2) NOT NULL DEFAULT 0.00,
  `issued_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`receipt_id`),
  UNIQUE KEY `receipt_number` (`receipt_number`),
  KEY `fk_receipts_transaction` (`transaction_id`),
  CONSTRAINT `fk_receipts_transaction` FOREIGN KEY (`transaction_id`) REFERENCES `billing_transactions` (`transaction_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------
-- NEW: notifications (Phase 3.1, 3.2, 4.2, 7.1)
-- ------------------------------------------------------------
CREATE TABLE `notifications` (
  `notification_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `recipient_type` enum('customer','staff') NOT NULL,
  `recipient_id` int(10) UNSIGNED NOT NULL,
  `message` varchar(255) NOT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`notification_id`),
  KEY `idx_notifications_recipient` (`recipient_type`,`recipient_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------
-- NEW: audit_log (Phase 10.5)
-- ------------------------------------------------------------
CREATE TABLE `audit_log` (
  `audit_id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int(10) UNSIGNED DEFAULT NULL,
  `actor_label` varchar(120) DEFAULT NULL,
  `action` varchar(50) NOT NULL,
  `table_name` varchar(50) NOT NULL,
  `record_id` int(10) UNSIGNED DEFAULT NULL,
  `details` varchar(500) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`audit_id`),
  KEY `idx_audit_user` (`user_id`),
  KEY `idx_audit_table` (`table_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------
-- Views (original 4 + 2 new for reporting)
-- ------------------------------------------------------------
CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_customer_reservations` AS
SELECT r.reservation_id, r.customer_id, CONCAT(c.first_name,' ',c.last_name) AS customer_name,
       ss.space_name, st.type_name AS space_type, r.reservation_date, r.start_time, r.end_time,
       r.number_of_people, r.status
FROM ((reservations r JOIN customers c ON r.customer_id=c.customer_id)
      JOIN study_spaces ss ON r.space_id=ss.space_id)
      JOIN space_types st ON ss.space_type_id=st.space_type_id;

CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_customer_sessions` AS
SELECT s.session_id, s.customer_id, CONCAT(c.first_name,' ',c.last_name) AS customer_name,
       ss.space_name, s.reservation_id, s.check_in_time, s.check_out_time, s.study_fee
FROM (space_sessions s JOIN customers c ON s.customer_id=c.customer_id)
      JOIN study_spaces ss ON s.space_id=ss.space_id;

CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_payment_records` AS
SELECT p.payment_id, p.customer_id, CONCAT(c.first_name,' ',c.last_name) AS customer_name,
       p.transaction_id, pm.method_name AS payment_method, p.reference_number, p.payment_status,
       p.amount_paid, p.payment_date, p.verified_by,
       CASE WHEN st.staff_id IS NULL THEN NULL ELSE CONCAT(st.first_name,' ',st.last_name) END AS verified_by_name
FROM ((payments p JOIN customers c ON p.customer_id=c.customer_id)
      JOIN payment_methods pm ON p.payment_method_id=pm.payment_method_id)
      LEFT JOIN staff st ON p.verified_by=st.staff_id;

CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_study_space_availability` AS
SELECT ss.space_id, ss.space_name, st.type_name, ss.capacity, ss.status, st.base_rate
FROM study_spaces ss JOIN space_types st ON ss.space_type_id=st.space_type_id;

CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_daily_revenue` AS
SELECT DATE(payment_date) AS revenue_date, SUM(amount_paid) AS total_collected, COUNT(*) AS payment_count
FROM payments WHERE payment_status='verified' GROUP BY DATE(payment_date);

CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_active_sessions` AS
SELECT s.session_id, CONCAT(c.first_name,' ',c.last_name) AS customer_name, ss.space_name,
       s.check_in_time, s.wifi_password
FROM (space_sessions s JOIN customers c ON s.customer_id=c.customer_id)
      JOIN study_spaces ss ON s.space_id=ss.space_id
WHERE s.check_out_time IS NULL;

SET FOREIGN_KEY_CHECKS = 1;
COMMIT;
