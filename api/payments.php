<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

function recompute_transaction_status(PDO $pdo, int $transactionId): void
{
    $stmt = $pdo->prepare('SELECT total_amount FROM billing_transactions WHERE transaction_id = :id FOR UPDATE');
    $stmt->execute([':id' => $transactionId]);
    $tx = $stmt->fetch();
    if (!$tx)
        return;

    $sumStmt = $pdo->prepare("SELECT COALESCE(SUM(amount_paid),0) AS paid FROM payments WHERE transaction_id = :id AND payment_status = 'verified'");
    $sumStmt->execute([':id' => $transactionId]);
    $paid = (float) $sumStmt->fetch()['paid'];

    if ($paid >= (float) $tx['total_amount'] && (float) $tx['total_amount'] > 0) {
        $pdo->prepare("UPDATE billing_transactions SET status = 'paid' WHERE transaction_id = :id")->execute([':id' => $transactionId]);

        // Phase 8.4 — issue an immutable receipt (only once).
        $exists = $pdo->prepare('SELECT receipt_id FROM receipts WHERE transaction_id = :id');
        $exists->execute([':id' => $transactionId]);
        if (!$exists->fetch()) {
            $receiptNumber = 'RCP-' . date('Ymd') . '-' . str_pad((string) $transactionId, 4, '0', STR_PAD_LEFT);
            $pdo->prepare('INSERT INTO receipts (transaction_id, receipt_number, total_paid) VALUES (:t, :n, :p)')
                ->execute([':t' => $transactionId, ':n' => $receiptNumber, ':p' => $paid]);
        }
    } elseif ($paid > 0) {
        $pdo->prepare("UPDATE billing_transactions SET status = 'partially_paid' WHERE transaction_id = :id")->execute([':id' => $transactionId]);
    }
}

switch ($op) {
    case 'methods': {
        json_response(['success' => true, 'data' => $pdo->query('SELECT * FROM payment_methods WHERE is_active = 1')->fetchAll()]);
    }

    case 'list': {
        json_response(['success' => true, 'data' => $pdo->query('SELECT * FROM v_payment_records ORDER BY payment_date DESC')->fetchAll()]);
    }

    case 'transactions': {
        $customerId = (int) input('customer_id');
        if (!$customerId)
            json_response(['success' => false, 'message' => 'Customer is required.']);
        $stmt = $pdo->prepare(
            "SELECT t.transaction_id, t.total_amount,
                    t.total_amount - COALESCE(SUM(CASE WHEN p.payment_status IN ('pending','verified') THEN p.amount_paid ELSE 0 END), 0) AS balance_due
             FROM billing_transactions t
             LEFT JOIN payments p ON p.transaction_id = t.transaction_id
             WHERE t.customer_id = :c AND t.status IN ('pending','partially_paid')
             GROUP BY t.transaction_id, t.total_amount
             HAVING balance_due > 0
             ORDER BY t.transaction_date DESC"
        );
        $stmt->execute([':c' => $customerId]);
        json_response(['success' => true, 'data' => $stmt->fetchAll()]);
    }

    // ---------------- Phase 8.1 — Customer chooses payment method ----------------
    case 'record': {
        require_permission('payments');
        $customerId = (int) input('customer_id');
        $transactionId = (int) input('transaction_id');
        $methodId = (int) input('payment_method_id');
        $amount = (float) input('amount_paid', 0);

        if (!$customerId || !$transactionId || !$methodId || $amount <= 0) {
            json_response(['success' => false, 'message' => 'Customer, transaction, method, and a positive amount are required.']);
        }

        try {
            $pdo->beginTransaction();
            $stmt = $pdo->prepare('SELECT customer_id, status, total_amount FROM billing_transactions WHERE transaction_id = :id FOR UPDATE');
            $stmt->execute([':id' => $transactionId]);
            $tx = $stmt->fetch();
            if (!$tx || (int) $tx['customer_id'] !== $customerId) {
                $pdo->rollBack();
                json_response(['success' => false, 'message' => 'Transaction does not belong to this customer.']);
            }
            if ($tx['status'] === 'paid') {
                $pdo->rollBack();
                json_response(['success' => false, 'message' => 'This transaction is already fully paid.']);
            }

            $sumStmt = $pdo->prepare("SELECT COALESCE(SUM(amount_paid), 0) FROM payments WHERE transaction_id = :id AND payment_status IN ('pending','verified')");
            $sumStmt->execute([':id' => $transactionId]);
            $balanceDue = (float) $tx['total_amount'] - (float) $sumStmt->fetchColumn();
            if ($amount > $balanceDue) {
                $pdo->rollBack();
                json_response(['success' => false, 'message' => 'Payment exceeds the remaining balance of ₱' . number_format(max($balanceDue, 0), 2) . '.']);
            }

            $stmt = $pdo->prepare(
                "INSERT INTO payments (customer_id, transaction_id, payment_method_id, amount_paid, payment_status)
                 VALUES (:c, :t, :m, :a, 'pending')"
            );
            $stmt->execute([':c' => $customerId, ':t' => $transactionId, ':m' => $methodId, ':a' => $amount]);
            $paymentId = (int) $pdo->lastInsertId();
            $reference = 'PAY-' . date('Ymd') . '-' . str_pad((string) $paymentId, 6, '0', STR_PAD_LEFT);
            $pdo->prepare('UPDATE payments SET reference_number = :r WHERE payment_id = :id')
                ->execute([':r' => $reference, ':id' => $paymentId]);

            notify_all_staff($pdo, "Payment #$paymentId (₱$amount) for transaction #$transactionId needs verification.");
            log_audit($pdo, 'create', 'payments', $paymentId, "Recorded payment ₱$amount for transaction #$transactionId");
            $pdo->commit();
            json_response(['success' => true, 'payment_id' => $paymentId, 'reference_number' => $reference]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction())
                $pdo->rollBack();
            json_response(['success' => false, 'message' => 'Payment failed: ' . $e->getMessage()], 500);
        }
    }

    // ---------------- Phase 8.2 — Cashier verifies payment ----------------
    case 'verify': {
        require_permission('payments');
        $paymentId = (int) input('payment_id');
        $staff = current_staff();

        try {
            $pdo->beginTransaction();
            $stmt = $pdo->prepare('SELECT * FROM payments WHERE payment_id = :id FOR UPDATE');
            $stmt->execute([':id' => $paymentId]);
            $payment = $stmt->fetch();
            if (!$payment) {
                $pdo->rollBack();
                json_response(['success' => false, 'message' => 'Payment not found.']);
            }
            if ($payment['payment_status'] !== 'pending') {
                $pdo->rollBack();
                json_response(['success' => false, 'message' => 'Payment already ' . $payment['payment_status'] . '.']);
            }

            $pdo->prepare("UPDATE payments SET payment_status = 'verified', verified_by = :s WHERE payment_id = :id")
                ->execute([':s' => $staff['staff_id'], ':id' => $paymentId]);

            if ($payment['transaction_id']) {
                recompute_transaction_status($pdo, (int) $payment['transaction_id']);
                create_notification($pdo, 'customer', (int) $payment['customer_id'], "Your payment of ₱{$payment['amount_paid']} has been verified.");
            }

            log_audit($pdo, 'update', 'payments', $paymentId, 'Payment verified');
            $pdo->commit();
            json_response(['success' => true]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            json_response(['success' => false, 'message' => 'Verification failed: ' . $e->getMessage()], 500);
        }
    }

    case 'reject': {
        require_permission('payments');
        $paymentId = (int) input('payment_id');
        $pdo->prepare("UPDATE payments SET payment_status = 'rejected' WHERE payment_id = :id AND payment_status = 'pending'")
            ->execute([':id' => $paymentId]);
        log_audit($pdo, 'update', 'payments', $paymentId, 'Payment rejected');
        json_response(['success' => true]);
    }

    case 'receipt': {
        $transactionId = (int) input('transaction_id');
        $stmt = $pdo->prepare('SELECT * FROM receipts WHERE transaction_id = :id');
        $stmt->execute([':id' => $transactionId]);
        $row = $stmt->fetch();
        json_response(['success' => (bool) $row, 'data' => $row]);
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
