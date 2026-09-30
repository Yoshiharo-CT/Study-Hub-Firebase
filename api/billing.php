<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

switch ($op) {
    case 'list': {
        $rows = $pdo->query(
            "SELECT t.*, CONCAT(c.first_name,' ',c.last_name) AS customer_name, p.code AS promo_code
             FROM billing_transactions t
             JOIN customers c ON t.customer_id = c.customer_id
             LEFT JOIN promotions p ON t.promotion_id = p.promotion_id
             ORDER BY t.transaction_date DESC"
        )->fetchAll();
        json_response(['success' => true, 'data' => $rows]);
    }

    case 'get': {
        $id = (int) input('transaction_id');
        $stmt = $pdo->prepare('SELECT * FROM billing_transactions WHERE transaction_id = :id');
        $stmt->execute([':id' => $id]);
        json_response(['success' => true, 'data' => $stmt->fetch()]);
    }

    case 'options': {
        $customerId = (int) input('customer_id');
        if (!$customerId)
            json_response(['success' => false, 'message' => 'Customer is required.']);

        $sessions = $pdo->prepare(
            "SELECT s.session_id, s.check_out_time, s.study_fee + COALESCE(e.extension_total, 0) AS total_amount
             FROM space_sessions s
             LEFT JOIN (
                 SELECT session_id, SUM(additional_amount) AS extension_total
                 FROM session_extensions GROUP BY session_id
             ) e ON e.session_id = s.session_id
             WHERE s.customer_id = :c AND s.check_out_time IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM billing_transactions t
                   WHERE t.session_id = s.session_id AND t.status <> 'cancelled'
               )
             ORDER BY s.check_out_time DESC"
        );
        $sessions->execute([':c' => $customerId]);

        $orders = $pdo->prepare(
            "SELECT o.order_id, o.order_datetime, o.total_amount
             FROM orders o
             WHERE o.customer_id = :c
               AND NOT EXISTS (
                   SELECT 1 FROM billing_transactions t
                   WHERE t.order_id = o.order_id AND t.status <> 'cancelled'
               )
             ORDER BY o.order_datetime DESC"
        );
        $orders->execute([':c' => $customerId]);

        $promotions = $pdo->query(
            "SELECT promotion_id, code, discount_type, discount_value
             FROM promotions WHERE is_active = 1 AND CURDATE() BETWEEN valid_from AND valid_to
             ORDER BY code"
        )->fetchAll();

        json_response([
            'success' => true,
            'sessions' => $sessions->fetchAll(),
            'orders' => $orders->fetchAll(),
            'promotions' => $promotions,
        ]);
    }

    // ---------------- Phase 7.1 — Consolidate charges ----------------
    case 'create': {
        require_permission('billing');
        $customerId = (int) input('customer_id');
        $sessionId = input('session_id') ? (int) input('session_id') : null;
        $orderId = input('order_id') ? (int) input('order_id') : null;
        $promoCode = trim((string) input('promo_code', ''));

        if (!$customerId)
            json_response(['success' => false, 'message' => 'Customer is required.']);
        if (!$sessionId && !$orderId)
            json_response(['success' => false, 'message' => 'Provide a session and/or an order to bill.']);

        try {
            $pdo->beginTransaction();

            $subtotal = 0.0;

            if ($sessionId) {
                $stmt = $pdo->prepare('SELECT * FROM space_sessions WHERE session_id = :id AND customer_id = :c FOR UPDATE');
                $stmt->execute([':id' => $sessionId, ':c' => $customerId]);
                $session = $stmt->fetch();
                if (!$session) {
                    $pdo->rollBack();
                    json_response(['success' => false, 'message' => 'Session does not belong to this customer.']);
                }
                if ($session['check_out_time'] === null) {
                    $pdo->rollBack();
                    json_response(['success' => false, 'message' => 'Session must be checked out before billing.']);
                }
                $billed = $pdo->prepare("SELECT transaction_id FROM billing_transactions WHERE session_id = :id AND status <> 'cancelled' LIMIT 1 FOR UPDATE");
                $billed->execute([':id' => $sessionId]);
                if ($billed->fetch()) {
                    $pdo->rollBack();
                    json_response(['success' => false, 'message' => 'This session has already been billed.']);
                }
                $reservationId = $session['reservation_id'] ? (int) $session['reservation_id'] : null;
                $subtotal += (float) $session['study_fee'];

                $extStmt = $pdo->prepare('SELECT COALESCE(SUM(additional_amount),0) AS total FROM session_extensions WHERE session_id = :id');
                $extStmt->execute([':id' => $sessionId]);
                $subtotal += (float) $extStmt->fetch()['total'];
            }

            if ($orderId) {
                $stmt = $pdo->prepare('SELECT total_amount FROM orders WHERE order_id = :id AND customer_id = :c');
                $stmt->execute([':id' => $orderId, ':c' => $customerId]);
                $order = $stmt->fetch();
                if (!$order) {
                    $pdo->rollBack();
                    json_response(['success' => false, 'message' => 'Order does not belong to this customer.']);
                }
                $billed = $pdo->prepare("SELECT transaction_id FROM billing_transactions WHERE order_id = :id AND status <> 'cancelled' LIMIT 1 FOR UPDATE");
                $billed->execute([':id' => $orderId]);
                if ($billed->fetch()) {
                    $pdo->rollBack();
                    json_response(['success' => false, 'message' => 'This order has already been billed.']);
                }
                $subtotal += (float) $order['total_amount'];
            }

            if (!isset($reservationId))
                $reservationId = null;

            // ---------------- Phase 6.4 — Apply promotion ----------------
            $discount = 0.0;
            $promotionId = null;
            if ($promoCode !== '') {
                $stmt = $pdo->prepare(
                    "SELECT * FROM promotions WHERE code = :c AND is_active = 1 AND CURDATE() BETWEEN valid_from AND valid_to"
                );
                $stmt->execute([':c' => $promoCode]);
                $promo = $stmt->fetch();
                if (!$promo) {
                    $pdo->rollBack();
                    json_response(['success' => false, 'message' => 'Invalid or expired promo code.']);
                }
                $promotionId = (int) $promo['promotion_id'];
                $discount = $promo['discount_type'] === 'percent'
                    ? round($subtotal * (float) $promo['discount_value'] / 100, 2)
                    : min($subtotal, (float) $promo['discount_value']);
            }

            $totalAmount = round(max($subtotal - $discount, 0), 2);

            $stmt = $pdo->prepare(
                "INSERT INTO billing_transactions
                    (customer_id, reservation_id, session_id, order_id, promotion_id, subtotal, discount_amount, total_amount, status)
                 VALUES (:c, :r, :s, :o, :p, :sub, :disc, :tot, 'pending')"
            );
            $stmt->execute([
                ':c' => $customerId,
                ':r' => $reservationId,
                ':s' => $sessionId,
                ':o' => $orderId,
                ':p' => $promotionId,
                ':sub' => $subtotal,
                ':disc' => $discount,
                ':tot' => $totalAmount,
            ]);
            $transactionId = (int) $pdo->lastInsertId();

            notify_all_staff($pdo, "Transaction #$transactionId (₱$totalAmount) is ready for payment.");
            log_audit($pdo, 'create', 'billing_transactions', $transactionId, "Billed ₱$totalAmount (subtotal ₱$subtotal, discount ₱$discount)");
            $pdo->commit();

            json_response([
                'success' => true,
                'transaction_id' => $transactionId,
                'subtotal' => $subtotal,
                'discount_amount' => $discount,
                'total_amount' => $totalAmount,
            ]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            json_response(['success' => false, 'message' => 'Billing failed: ' . $e->getMessage()], 500);
        }
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
