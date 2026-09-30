<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

function generate_wifi_password(): string
{
    return 'SH-' . strtoupper(bin2hex(random_bytes(3)));
}

/** Serves the oldest waiting walk-in whose requested space_type matches $spaceTypeId, if any. */
function serve_next_walkin(PDO $pdo, int $spaceId, int $spaceTypeId): void
{
    $stmt = $pdo->prepare(
        "SELECT * FROM walkin_queue WHERE space_type_id = :t AND status = 'waiting'
         ORDER BY queued_at ASC LIMIT 1 FOR UPDATE"
    );
    $stmt->execute([':t' => $spaceTypeId]);
    $entry = $stmt->fetch();
    if (!$entry)
        return;

    $pdo->prepare("UPDATE walkin_queue SET status = 'served', served_at = NOW() WHERE queue_id = :id")
        ->execute([':id' => $entry['queue_id']]);

    $wifi = generate_wifi_password();
    $pdo->prepare(
        "INSERT INTO space_sessions (customer_id, space_id, reservation_id, check_in_time, wifi_password, study_fee)
         VALUES (:c, :s, NULL, NOW(), :w, 0)"
    )->execute([':c' => $entry['customer_id'], ':s' => $spaceId, ':w' => $wifi]);

    $pdo->prepare("UPDATE study_spaces SET status = 'occupied' WHERE space_id = :id")->execute([':id' => $spaceId]);

    create_notification($pdo, 'customer', (int) $entry['customer_id'], 'A space just opened up for you — please check in at the front desk.');
    log_audit($pdo, 'update', 'walkin_queue', (int) $entry['queue_id'], "Served from queue into space #$spaceId");
}

switch ($op) {
    case 'listActive': {
        $rows = $pdo->query(
            "SELECT s.session_id, s.customer_id, CONCAT(c.first_name,' ',c.last_name) AS customer_name,
                    s.space_id, sp.space_name, st.base_rate, s.reservation_id,
                    s.check_in_time, s.wifi_password,
                    ROUND(TIMESTAMPDIFF(SECOND, s.check_in_time, NOW()) / 3600 * st.base_rate, 2) AS fee_so_far
             FROM space_sessions s
             JOIN customers c ON s.customer_id = c.customer_id
             JOIN study_spaces sp ON s.space_id = sp.space_id
             JOIN space_types st ON sp.space_type_id = st.space_type_id
             WHERE s.check_out_time IS NULL
             ORDER BY s.check_in_time"
        )->fetchAll();
        json_response(['success' => true, 'data' => $rows]);
    }

    case 'checkInReservation': {
        $customerId = (int) input('customer_id');
        $spaceId = (int) input('space_id');
        if (!$customerId || !$spaceId)
            json_response(['success' => true, 'data' => null]);
        $stmt = $pdo->prepare(
            "SELECT reservation_id FROM reservations
             WHERE customer_id = :c AND space_id = :s AND status = 'confirmed'
               AND reservation_date = CURDATE() AND start_time <= CURTIME() AND end_time >= CURTIME()
             ORDER BY start_time LIMIT 1"
        );
        $stmt->execute([':c' => $customerId, ':s' => $spaceId]);
        json_response(['success' => true, 'data' => $stmt->fetchColumn() ?: null]);
    }

    case 'list': {
        $rows = $pdo->query('SELECT * FROM v_customer_sessions ORDER BY check_in_time DESC')->fetchAll();
        json_response(['success' => true, 'data' => $rows]);
    }

    // ---------------- Phase 4.1 (walk-in) / 5.1 (reserved) — Check-in ----------------
    case 'checkIn': {
        require_permission('sessions');
        $customerId = (int) input('customer_id');
        $spaceId = (int) input('space_id');

        if (!$customerId || !$spaceId) {
            json_response(['success' => false, 'message' => 'Customer and space are required.']);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare('SELECT * FROM study_spaces WHERE space_id = :id FOR UPDATE');
            $stmt->execute([':id' => $spaceId]);
            $space = $stmt->fetch();
            if (!$space) {
                $pdo->rollBack();
                json_response(['success' => false, 'message' => 'Space not found.']);
            }
            if (!in_array($space['status'], ['available', 'reserved'], true)) {
                $pdo->rollBack();
                json_response(['success' => false, 'message' => 'That space is currently ' . $space['status'] . '.']);
            }

            $stmt = $pdo->prepare(
                "SELECT reservation_id FROM reservations
                 WHERE customer_id = :c AND space_id = :s AND status = 'confirmed'
                   AND reservation_date = CURDATE() AND start_time <= CURTIME() AND end_time >= CURTIME()
                 ORDER BY start_time LIMIT 1 FOR UPDATE"
            );
            $stmt->execute([':c' => $customerId, ':s' => $spaceId]);
            $reservationId = $stmt->fetchColumn();
            $reservationId = $reservationId === false ? null : (int) $reservationId;

            $wifi = generate_wifi_password();
            $stmt = $pdo->prepare(
                'INSERT INTO space_sessions (customer_id, space_id, reservation_id, check_in_time, wifi_password, study_fee)
                 VALUES (:c, :s, :r, NOW(), :w, 0)'
            );
            $stmt->execute([':c' => $customerId, ':s' => $spaceId, ':r' => $reservationId, ':w' => $wifi]);
            $sessionId = (int) $pdo->lastInsertId();

            $pdo->prepare("UPDATE study_spaces SET status = 'occupied' WHERE space_id = :id")->execute([':id' => $spaceId]);
            if ($reservationId) {
                $pdo->prepare("UPDATE reservations SET status = 'completed' WHERE reservation_id = :id")->execute([':id' => $reservationId]);
            }

            log_audit($pdo, 'create', 'space_sessions', $sessionId, "Checked in customer #$customerId to space #$spaceId");
            $pdo->commit();
            json_response(['success' => true, 'session_id' => $sessionId, 'wifi_password' => $wifi]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            json_response(['success' => false, 'message' => 'Check-in failed: ' . $e->getMessage()], 500);
        }
    }

    // ---------------- Phase 6.2 — Session extension ----------------
    case 'extendSession': {
        require_permission('sessions');
        $sessionId = (int) input('session_id');
        $extraMinutes = (int) input('extra_minutes', 60);

        $stmt = $pdo->prepare(
            'SELECT s.*, st.base_rate FROM space_sessions s
             JOIN study_spaces sp ON s.space_id = sp.space_id
             JOIN space_types st ON sp.space_type_id = st.space_type_id
             WHERE s.session_id = :id'
        );
        $stmt->execute([':id' => $sessionId]);
        $session = $stmt->fetch();
        if (!$session || $session['check_out_time'] !== null) {
            json_response(['success' => false, 'message' => 'Active session not found.']);
        }

        $extStart = date('Y-m-d H:i:s');
        $extEnd = date('Y-m-d H:i:s', strtotime($extStart) + $extraMinutes * 60);
        $amount = round(($extraMinutes / 60) * (float) $session['base_rate'], 2);

        $stmt = $pdo->prepare(
            'INSERT INTO session_extensions (session_id, extension_start, extension_end, additional_amount)
             VALUES (:s, :st, :e, :a)'
        );
        $stmt->execute([':s' => $sessionId, ':st' => $extStart, ':e' => $extEnd, ':a' => $amount]);
        log_audit($pdo, 'create', 'session_extensions', (int) $pdo->lastInsertId(), "Extended session #$sessionId by $extraMinutes min (+₱$amount)");
        json_response(['success' => true, 'additional_amount' => $amount]);
    }

    // ---------------- Phase 9.1 — Check-out ----------------
    case 'checkOut': {
        require_permission('sessions');
        $sessionId = (int) input('session_id');

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                'SELECT s.*, sp.space_type_id, st.base_rate FROM space_sessions s
                 JOIN study_spaces sp ON s.space_id = sp.space_id
                 JOIN space_types st ON sp.space_type_id = st.space_type_id
                 WHERE s.session_id = :id FOR UPDATE'
            );
            $stmt->execute([':id' => $sessionId]);
            $session = $stmt->fetch();
            if (!$session) {
                $pdo->rollBack();
                json_response(['success' => false, 'message' => 'Session not found.']);
            }
            if ($session['check_out_time'] !== null) {
                $pdo->rollBack();
                json_response(['success' => false, 'message' => 'Session already checked out.']);
            }

            $hours = (strtotime('now') - strtotime($session['check_in_time'])) / 3600;
            $fee = round(max($hours, 0) * (float) $session['base_rate'], 2);

            $pdo->prepare('UPDATE space_sessions SET check_out_time = NOW(), study_fee = :f WHERE session_id = :id')
                ->execute([':f' => $fee, ':id' => $sessionId]);
            $pdo->prepare("UPDATE study_spaces SET status = 'available' WHERE space_id = :id")->execute([':id' => $session['space_id']]);

            // Phase 9.1 — serve the next walk-in for this space type, if any.
            serve_next_walkin($pdo, (int) $session['space_id'], (int) $session['space_type_id']);

            log_audit($pdo, 'update', 'space_sessions', $sessionId, "Checked out, study_fee=$fee");
            $pdo->commit();
            json_response(['success' => true, 'study_fee' => $fee]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            json_response(['success' => false, 'message' => 'Check-out failed: ' . $e->getMessage()], 500);
        }
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
