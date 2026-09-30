<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

switch ($op) {
    // ---------------- Phase 10.1 — Dashboard ----------------
    case 'dashboard': {
        $occupied = (int) $pdo->query("SELECT COUNT(*) c FROM study_spaces WHERE status = 'occupied'")->fetch()['c'];
        $available = (int) $pdo->query("SELECT COUNT(*) c FROM study_spaces WHERE status = 'available'")->fetch()['c'];
        $activeSessions = (int) $pdo->query('SELECT COUNT(*) c FROM space_sessions WHERE check_out_time IS NULL')->fetch()['c'];
        $pendingToday = (int) $pdo->query(
            "SELECT COUNT(*) c FROM reservations WHERE status = 'pending' AND reservation_date = CURDATE()"
        )->fetch()['c'];
        $waitingWalkins = (int) $pdo->query("SELECT COUNT(*) c FROM walkin_queue WHERE status = 'waiting'")->fetch()['c'];
        $todayRevenue = (float) ($pdo->query(
            "SELECT COALESCE(SUM(amount_paid),0) t FROM payments WHERE payment_status='verified' AND DATE(payment_date)=CURDATE()"
        )->fetch()['t']);

        json_response(['success' => true, 'data' => [
            'occupied' => $occupied,
            'available' => $available,
            'active_sessions' => $activeSessions,
            'pending_reservations_today' => $pendingToday,
            'waiting_walkins' => $waitingWalkins,
            'today_revenue' => $todayRevenue,
        ]]);
    }

    case 'spaceAvailability': {
        json_response(['success' => true, 'data' => $pdo->query('SELECT * FROM v_study_space_availability')->fetchAll()]);
    }

    case 'dailyRevenue': {
        json_response(['success' => true, 'data' => $pdo->query('SELECT * FROM v_daily_revenue ORDER BY revenue_date DESC LIMIT 30')->fetchAll()]);
    }

    case 'activeSessionsView': {
        json_response(['success' => true, 'data' => $pdo->query('SELECT * FROM v_active_sessions')->fetchAll()]);
    }

    // ---------------- Phase 10.5 — Audit review ----------------
    case 'auditLog': {
        require_permission('reports');
        $where = [];
        $params = [];
        if ($userId = input('user_id')) { $where[] = 'user_id = :u'; $params[':u'] = (int)$userId; }
        if ($table = input('table_name')) { $where[] = 'table_name = :t'; $params[':t'] = $table; }
        if ($from = input('date_from')) { $where[] = 'created_at >= :from'; $params[':from'] = $from . ' 00:00:00'; }
        if ($to = input('date_to')) { $where[] = 'created_at <= :to'; $params[':to'] = $to . ' 23:59:59'; }
        $sql = 'SELECT * FROM audit_log';
        if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
        $sql .= ' ORDER BY created_at DESC LIMIT 300';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        json_response(['success' => true, 'data' => $stmt->fetchAll()]);
    }

    // ---------------- Phase 11.1 — End of day ----------------
    case 'endOfDay': {
        require_permission('reports');
        $date = (string) input('date', date('Y-m-d'));

        $stmt = $pdo->prepare("SELECT COALESCE(SUM(amount_paid),0) t FROM payments WHERE payment_status='verified' AND DATE(payment_date)=:d");
        $stmt->execute([':d' => $date]);
        $revenue = (float) $stmt->fetch()['t'];

        $stmt = $pdo->prepare('SELECT COUNT(*) c FROM space_sessions WHERE DATE(check_in_time) = :d');
        $stmt->execute([':d' => $date]);
        $sessionsCount = (int) $stmt->fetch()['c'];

        $stmt = $pdo->prepare('SELECT COUNT(*) c FROM space_sessions WHERE DATE(check_in_time) = :d AND reservation_id IS NULL');
        $stmt->execute([':d' => $date]);
        $walkinsCount = (int) $stmt->fetch()['c'];

        $stmt = $pdo->prepare('SELECT COUNT(*) c FROM space_sessions WHERE DATE(check_in_time) = :d AND reservation_id IS NOT NULL');
        $stmt->execute([':d' => $date]);
        $reservedCount = (int) $stmt->fetch()['c'];

        $topProducts = $pdo->prepare(
            "SELECT p.item_name, SUM(oi.quantity) AS qty, SUM(oi.subtotal) AS revenue
             FROM order_items oi JOIN products_services p ON oi.product_id = p.product_id
             JOIN orders o ON oi.order_id = o.order_id
             WHERE DATE(o.order_datetime) = :d
             GROUP BY p.product_id ORDER BY qty DESC LIMIT 5"
        );
        $topProducts->execute([':d' => $date]);

        $outstanding = $pdo->query(
            "SELECT transaction_id, customer_id, total_amount, status FROM billing_transactions WHERE status = 'partially_paid'"
        )->fetchAll();

        json_response(['success' => true, 'data' => [
            'date' => $date,
            'revenue' => $revenue,
            'sessions_count' => $sessionsCount,
            'walkins_count' => $walkinsCount,
            'reserved_count' => $reservedCount,
            'top_products' => $topProducts->fetchAll(),
            'outstanding_balances' => $outstanding,
        ]]);
    }

    // ---------------- Phase 11.2 — Nightly maintenance helper: auto no-show ----------------
    case 'markOverdueNoShows': {
        require_permission('reports');
        // Any confirmed reservation whose end_time has already passed today (or an earlier date) with no session.
        $stmt = $pdo->query(
            "SELECT r.reservation_id, r.space_id FROM reservations r
             LEFT JOIN space_sessions s ON s.reservation_id = r.reservation_id
             WHERE r.status = 'confirmed' AND s.session_id IS NULL
               AND TIMESTAMP(r.reservation_date, r.end_time) < NOW()"
        );
        $rows = $stmt->fetchAll();
        foreach ($rows as $r) {
            $pdo->prepare("UPDATE reservations SET status = 'no_show' WHERE reservation_id = :id")->execute([':id' => $r['reservation_id']]);
            $pdo->prepare("UPDATE study_spaces SET status = 'available' WHERE space_id = :id AND status = 'reserved'")->execute([':id' => $r['space_id']]);
            log_audit($pdo, 'update', 'reservations', (int)$r['reservation_id'], 'Auto-marked no-show (nightly maintenance)');
        }
        json_response(['success' => true, 'marked' => count($rows)]);
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
