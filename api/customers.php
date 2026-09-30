<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

switch ($op) {
    case 'list': {
        $rows = $pdo->query(
            "SELECT c.*, u.username, u.account_status
             FROM customers c LEFT JOIN users u ON c.user_id = u.user_id
             ORDER BY c.customer_id DESC"
        )->fetchAll();
        json_response(['success' => true, 'data' => $rows]);
    }

    case 'get': {
        $id = (int) input('customer_id');
        $stmt = $pdo->prepare('SELECT * FROM customers WHERE customer_id = :id');
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();
        json_response(['success' => (bool) $row, 'data' => $row]);
    }

    // Manual add by staff (front desk logging a customer without a login)
    case 'add': {
        $first = trim((string) input('first_name', ''));
        $last = trim((string) input('last_name', ''));
        $phone = trim((string) input('phone_number', ''));
        $email = trim((string) input('email', ''));
        if ($first === '' || $last === '' || $phone === '' || $email === '') {
            json_response(['success' => false, 'message' => 'All fields are required.']);
        }
        $dupe = $pdo->prepare('SELECT customer_id FROM customers WHERE email = :e OR phone_number = :p');
        $dupe->execute([':e' => $email, ':p' => $phone]);
        if ($dupe->fetch()) {
            json_response(['success' => false, 'message' => 'A customer with that email or phone already exists.']);
        }
        $stmt = $pdo->prepare(
            'INSERT INTO customers (first_name, last_name, phone_number, email) VALUES (:f, :l, :p, :e)'
        );
        $stmt->execute([':f' => $first, ':l' => $last, ':p' => $phone, ':e' => $email]);
        $id = (int) $pdo->lastInsertId();
        log_audit($pdo, 'create', 'customers', $id, "Added customer $first $last");
        json_response(['success' => true, 'customer_id' => $id]);
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
