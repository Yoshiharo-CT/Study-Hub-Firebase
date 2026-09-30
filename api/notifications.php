<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
$who = require_login();

$op = get_operation();

switch ($op) {
    case 'list': {
        $type = $who['type']; // 'staff' or 'customer'
        $id = $type === 'staff' ? $who['staff_id'] : $who['customer_id'];
        $stmt = $pdo->prepare(
            'SELECT * FROM notifications WHERE recipient_type = :t AND recipient_id = :id ORDER BY created_at DESC LIMIT 50'
        );
        $stmt->execute([':t' => $type, ':id' => $id]);
        json_response(['success' => true, 'data' => $stmt->fetchAll()]);
    }

    case 'markRead': {
        $id = (int) input('notification_id');
        $pdo->prepare('UPDATE notifications SET is_read = 1 WHERE notification_id = :id')->execute([':id' => $id]);
        json_response(['success' => true]);
    }

    case 'markAllRead': {
        $type = $who['type'];
        $id = $type === 'staff' ? $who['staff_id'] : $who['customer_id'];
        $pdo->prepare('UPDATE notifications SET is_read = 1 WHERE recipient_type = :t AND recipient_id = :id')
            ->execute([':t' => $type, ':id' => $id]);
        json_response(['success' => true]);
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
