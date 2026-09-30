-- Run once against an existing Study Hub database.
ALTER TABLE `billing_transactions` DROP COLUMN `tax_amount`;
ALTER TABLE `product_categories` DROP COLUMN `is_taxable`;
DROP TABLE IF EXISTS `tax_settings`;