<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';
require_staff_login();

$op = get_operation();

switch ($op) {
    case 'list': {
        $rows = $pdo->query(
            "SELECT s.staff_id, s.first_name, s.last_name, s.phone_number, s.role_id,
                    r.role_name, u.username, u.account_status
             FROM staff s
             JOIN staff_roles r ON s.role_id = r.role_id
             LEFT JOIN users u ON s.user_id = u.user_id
             ORDER BY s.staff_id"
        )->fetchAll();
        json_response(['success' => true, 'data' => $rows]);
    }

    case 'roles': {
        $rows = $pdo->query('SELECT * FROM staff_roles WHERE is_active = 1 ORDER BY role_name')->fetchAll();
        json_response(['success' => true, 'data' => $rows]);
    }

    // Phase 0.2 — Owner/Manager registers staff
    case 'add': {
        require_permission('staff');
        $first = trim((string) input('first_name', ''));
        $last = trim((string) input('last_name', ''));
        $phone = trim((string) input('phone_number', ''));
        $roleId = (int) input('role_id');
        $username = trim((string) input('username', ''));
        $password = (string) input('password', '');

        if ($first === '' || $last === '' || $phone === '' || $roleId <= 0 || $username === '' || strlen($password) < 6) {
            json_response(['success' => false, 'message' => 'Fill in all fields (password must be at least 6 characters).']);
        }
        $dupe = $pdo->prepare('SELECT user_id FROM users WHERE username = :u');
        $dupe->execute([':u' => $username]);
        if ($dupe->fetch()) {
            json_response(['success' => false, 'message' => 'That username is already taken.']);
        }

        try {
            $pdo->beginTransaction();
            $hash = password_hash($password, PASSWORD_DEFAULT);
            $stmt = $pdo->prepare("INSERT INTO users (username, password_hash, account_type, account_status) VALUES (:u, :p, 'staff', 'active')");
            $stmt->execute([':u' => $username, ':p' => $hash]);
            $userId = (int) $pdo->lastInsertId();

            $stmt = $pdo->prepare('INSERT INTO staff (user_id, role_id, first_name, last_name, phone_number) VALUES (:uid, :rid, :f, :l, :ph)');
            $stmt->execute([':uid' => $userId, ':rid' => $roleId, ':f' => $first, ':l' => $last, ':ph' => $phone]);
            $staffId = (int) $pdo->lastInsertId();

            log_audit($pdo, 'create', 'staff', $staffId, "Added staff $first $last");
            $pdo->commit();
            json_response(['success' => true, 'staff_id' => $staffId]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            json_response(['success' => false, 'message' => 'Failed to add staff: ' . $e->getMessage()], 500);
        }
    }

    // Phase 10.2 — suspend/reactivate a staff account
    case 'setStatus': {
        require_permission('staff');
        $staffId = (int) input('staff_id');
        $status = (string) input('account_status');
        if (!in_array($status, ['active', 'inactive', 'suspended'], true)) {
            json_response(['success' => false, 'message' => 'Invalid status.']);
        }
        $stmt = $pdo->prepare('SELECT user_id FROM staff WHERE staff_id = :id');
        $stmt->execute([':id' => $staffId]);
        $row = $stmt->fetch();
        if (!$row || !$row['user_id']) {
            json_response(['success' => false, 'message' => 'Staff account not found.']);
        }
        $pdo->prepare('UPDATE users SET account_status = :s WHERE user_id = :uid')
            ->execute([':s' => $status, ':uid' => $row['user_id']]);
        log_audit($pdo, 'update', 'users', (int)$row['user_id'], "Set staff #$staffId status to $status");
        json_response(['success' => true]);
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
