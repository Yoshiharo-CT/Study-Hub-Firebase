<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

switch ($op) {
    case 'listCategories': {
        json_response(['success' => true, 'data' => $pdo->query('SELECT * FROM product_categories WHERE is_active = 1 ORDER BY category_name')->fetchAll()]);
    }

    case 'listProducts': {
        $sql = "SELECT p.*, c.category_name, c.is_taxable
                FROM products_services p JOIN product_categories c ON p.category_id = c.category_id";
        $params = [];
        if ($cat = input('category_id')) { $sql .= ' WHERE p.category_id = :c'; $params[':c'] = (int)$cat; }
        $sql .= ' ORDER BY c.category_name, p.item_name';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        json_response(['success' => true, 'data' => $stmt->fetchAll()]);
    }

    case 'listPaperSizes': {
        json_response(['success' => true, 'data' => $pdo->query('SELECT * FROM paper_sizes WHERE is_active = 1')->fetchAll()]);
    }

    case 'listPrintTypes': {
        json_response(['success' => true, 'data' => $pdo->query('SELECT * FROM print_types WHERE is_active = 1')->fetchAll()]);
    }

    case 'addCategory': {
        require_permission('spaces'); // product/category management sits with managers
        $name = trim((string) input('category_name', ''));
        $desc = trim((string) input('description', ''));
        $taxable = (int) input('is_taxable', 1);
        if ($name === '') json_response(['success' => false, 'message' => 'Category name is required.']);
        $stmt = $pdo->prepare('INSERT INTO product_categories (category_name, description, is_taxable) VALUES (:n,:d,:t)');
        $stmt->execute([':n' => $name, ':d' => $desc, ':t' => $taxable]);
        log_audit($pdo, 'create', 'product_categories', (int)$pdo->lastInsertId(), "Added category $name");
        json_response(['success' => true]);
    }

    case 'addProduct': {
        require_permission('spaces');
        $catId = (int) input('category_id');
        $name = trim((string) input('item_name', ''));
        $price = (float) input('unit_price', 0);
        $stock = (int) input('stock_quantity', 0);
        if ($catId <= 0 || $name === '') json_response(['success' => false, 'message' => 'Category and item name are required.']);
        $stmt = $pdo->prepare('INSERT INTO products_services (category_id, item_name, unit_price, stock_quantity) VALUES (:c,:n,:p,:s)');
        $stmt->execute([':c' => $catId, ':n' => $name, ':p' => $price, ':s' => $stock]);
        log_audit($pdo, 'create', 'products_services', (int)$pdo->lastInsertId(), "Added product $name");
        json_response(['success' => true]);
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
