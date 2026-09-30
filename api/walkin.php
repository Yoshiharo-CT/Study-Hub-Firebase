<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

switch ($op) {
    case 'list': {
        $rows = $pdo->query(
            "SELECT w.*, CONCAT(c.first_name,' ',c.last_name) AS customer_name, st.type_name
             FROM walkin_queue w
             JOIN customers c ON w.customer_id = c.customer_id
             JOIN space_types st ON w.space_type_id = st.space_type_id
             ORDER BY (w.status='waiting') DESC, w.queued_at ASC"
        )->fetchAll();
        json_response(['success' => true, 'data' => $rows]);
    }

    case 'add': {
        require_permission('walkins');
        $customerId = (int) input('customer_id');
        $spaceTypeId = (int) input('space_type_id');
        if (!$customerId || !$spaceTypeId) {
            json_response(['success' => false, 'message' => 'Customer and desired space type are required.']);
        }
        $stmt = $pdo->prepare("INSERT INTO walkin_queue (customer_id, space_type_id, status) VALUES (:c, :t, 'waiting')");
        $stmt->execute([':c' => $customerId, ':t' => $spaceTypeId]);
        $id = (int) $pdo->lastInsertId();
        log_audit($pdo, 'create', 'walkin_queue', $id, 'Added to walk-in queue');
        json_response(['success' => true, 'queue_id' => $id]);
    }

    case 'cancel': {
        require_permission('walkins');
        $id = (int) input('queue_id');
        $pdo->prepare("UPDATE walkin_queue SET status = 'cancelled' WHERE queue_id = :id AND status = 'waiting'")
            ->execute([':id' => $id]);
        log_audit($pdo, 'update', 'walkin_queue', $id, 'Removed from queue');
        json_response(['success' => true]);
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
