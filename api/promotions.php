<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

switch ($op) {
    case 'list': {
        json_response(['success' => true, 'data' => $pdo->query('SELECT * FROM promotions ORDER BY valid_to DESC')->fetchAll()]);
    }

    case 'validate': {
        $code = trim((string) input('code', ''));
        $stmt = $pdo->prepare(
            "SELECT * FROM promotions
             WHERE code = :c AND is_active = 1 AND CURDATE() BETWEEN valid_from AND valid_to"
        );
        $stmt->execute([':c' => $code]);
        $promo = $stmt->fetch();
        if (!$promo) {
            json_response(['success' => false, 'message' => 'That promo code is invalid, expired, or inactive.']);
        }
        json_response(['success' => true, 'data' => $promo]);
    }

    case 'add': {
        require_permission('promotions');
        $code = strtoupper(trim((string) input('code', '')));
        $desc = trim((string) input('description', ''));
        $type = (string) input('discount_type', 'percent');
        $value = (float) input('discount_value', 0);
        $from = (string) input('valid_from');
        $to = (string) input('valid_to');
        if ($code === '' || !$from || !$to) {
            json_response(['success' => false, 'message' => 'Code, valid_from, and valid_to are required.']);
        }
        $stmt = $pdo->prepare(
            'INSERT INTO promotions (code, description, discount_type, discount_value, valid_from, valid_to)
             VALUES (:c,:d,:t,:v,:f,:e)'
        );
        $stmt->execute([':c' => $code, ':d' => $desc, ':t' => $type, ':v' => $value, ':f' => $from, ':e' => $to]);
        log_audit($pdo, 'create', 'promotions', (int)$pdo->lastInsertId(), "Added promo $code");
        json_response(['success' => true]);
    }

    // Phase 11.2 — deactivate expired promos (also runs automatically via the WHERE valid_to check above)
    case 'deactivateExpired': {
        require_permission('promotions');
        $stmt = $pdo->prepare("UPDATE promotions SET is_active = 0 WHERE valid_to < CURDATE() AND is_active = 1");
        $stmt->execute();
        json_response(['success' => true, 'deactivated' => $stmt->rowCount()]);
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
