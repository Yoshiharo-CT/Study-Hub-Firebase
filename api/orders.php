<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

switch ($op) {
    case 'list': {
        $rows = $pdo->query(
            "SELECT o.*, CONCAT(c.first_name,' ',c.last_name) AS customer_name,
                    CONCAT(s.first_name,' ',s.last_name) AS staff_name
             FROM orders o
             JOIN customers c ON o.customer_id = c.customer_id
             JOIN staff s ON o.staff_id = s.staff_id
             ORDER BY o.order_datetime DESC"
        )->fetchAll();
        json_response(['success' => true, 'data' => $rows]);
    }

    case 'getItems': {
        $orderId = (int) input('order_id');
        $stmt = $pdo->prepare(
            "SELECT oi.*, p.item_name,
                    pj.paper_size_id, ps.size_name, pj.print_type_id, pt.label AS print_label, pj.page_count
             FROM order_items oi
             JOIN products_services p ON oi.product_id = p.product_id
             LEFT JOIN printing_jobs pj ON pj.order_item_id = oi.order_item_id
             LEFT JOIN paper_sizes ps ON pj.paper_size_id = ps.paper_size_id
             LEFT JOIN print_types pt ON pj.print_type_id = pt.print_type_id
             WHERE oi.order_id = :id"
        );
        $stmt->execute([':id' => $orderId]);
        json_response(['success' => true, 'data' => $stmt->fetchAll()]);
    }

    case 'activeSession': {
        $customerId = (int) input('customer_id');
        if (!$customerId)
            json_response(['success' => false, 'message' => 'Customer is required.']);
        $stmt = $pdo->prepare(
            "SELECT s.session_id, s.check_in_time, sp.space_name
             FROM space_sessions s
             JOIN study_spaces sp ON sp.space_id = s.space_id
             WHERE s.customer_id = :c AND s.check_out_time IS NULL
             ORDER BY s.check_in_time DESC LIMIT 1"
        );
        $stmt->execute([':c' => $customerId]);
        json_response(['success' => true, 'data' => $stmt->fetch() ?: null]);
    }

    // ---------------- Phase 6.3 — Ordering products / services ----------------
    // Expects: customer_id, staff_id, session_id (optional), items = JSON array of
    // { product_id, quantity, printing?: { paper_size_id, print_type_id, page_count } }
    case 'create': {
        require_permission('orders');
        $customerId = (int) input('customer_id');
        $staffId = (int) input('staff_id');
        $items = json_decode((string) input('items', '[]'), true);

        if (!$customerId || !$staffId || !is_array($items) || count($items) === 0) {
            json_response(['success' => false, 'message' => 'Customer, staff, and at least one item are required.']);
        }

        try {
            $pdo->beginTransaction();

            $sessionStmt = $pdo->prepare(
                'SELECT session_id FROM space_sessions
                 WHERE customer_id = :c AND check_out_time IS NULL
                 ORDER BY check_in_time DESC LIMIT 1 FOR UPDATE'
            );
            $sessionStmt->execute([':c' => $customerId]);
            $sessionId = $sessionStmt->fetchColumn();
            $sessionId = $sessionId === false ? null : (int) $sessionId;

            $stmt = $pdo->prepare(
                "INSERT INTO orders (customer_id, staff_id, session_id, order_datetime, total_amount)
                 VALUES (:c, :s, :sess, NOW(), 0)"
            );
            $stmt->execute([':c' => $customerId, ':s' => $staffId, ':sess' => $sessionId]);
            $orderId = (int) $pdo->lastInsertId();

            $total = 0.0;
            $prodStmt = $pdo->prepare('SELECT * FROM products_services WHERE product_id = :id FOR UPDATE');
            $itemStmt = $pdo->prepare('INSERT INTO order_items (order_id, product_id, quantity, subtotal) VALUES (:o,:p,:q,:s)');
            $printStmt = $pdo->prepare(
                'INSERT INTO printing_jobs (order_item_id, paper_size_id, print_type_id, page_count) VALUES (:oi,:ps,:pt,:pc)'
            );
            $stockStmt = $pdo->prepare('UPDATE products_services SET stock_quantity = stock_quantity - :q WHERE product_id = :id');

            foreach ($items as $item) {
                $productId = (int) ($item['product_id'] ?? 0);
                $qty = max(1, (int) ($item['quantity'] ?? 1));
                $prodStmt->execute([':id' => $productId]);
                $product = $prodStmt->fetch();
                if (!$product) {
                    $pdo->rollBack();
                    json_response(['success' => false, 'message' => "Product #$productId not found."]);
                }
                if ($product['stock_quantity'] < $qty) {
                    $pdo->rollBack();
                    json_response(['success' => false, 'message' => 'Not enough stock for ' . $product['item_name'] . '.']);
                }

                $subtotal = round((float) $product['unit_price'] * $qty, 2);
                $itemStmt->execute([':o' => $orderId, ':p' => $productId, ':q' => $qty, ':s' => $subtotal]);
                $orderItemId = (int) $pdo->lastInsertId();
                $total += $subtotal;

                $stockStmt->execute([':q' => $qty, ':id' => $productId]);

                if (!empty($item['printing'])) {
                    $pr = $item['printing'];
                    $printStmt->execute([
                        ':oi' => $orderItemId,
                        ':ps' => (int) ($pr['paper_size_id'] ?? 0),
                        ':pt' => (int) ($pr['print_type_id'] ?? 0),
                        ':pc' => (int) ($pr['page_count'] ?? 1),
                    ]);
                }
            }

            $pdo->prepare('UPDATE orders SET total_amount = :t WHERE order_id = :id')->execute([':t' => $total, ':id' => $orderId]);

            log_audit($pdo, 'create', 'orders', $orderId, "Order placed, total ₱$total");
            $pdo->commit();
            json_response(['success' => true, 'order_id' => $orderId, 'total_amount' => $total]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            json_response(['success' => false, 'message' => 'Order failed: ' . $e->getMessage()], 500);
        }
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
