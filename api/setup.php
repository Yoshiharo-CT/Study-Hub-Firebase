<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';

// Visit this file once in the browser after importing study_hub_db.sql.
// It creates the Owner/Manager admin account if one doesn't exist yet,
// or links an orphaned 'admin' user to the Owner/Manager role.

header('Content-Type: text/plain');

$stmt = $pdo->prepare('SELECT * FROM users WHERE username = :u');
$stmt->execute([':u' => 'admin']);
$user = $stmt->fetch();

if (!$user) {
    $hash = password_hash('admin123', PASSWORD_DEFAULT);
    $pdo->prepare("INSERT INTO users (username, password_hash, account_type, account_status) VALUES ('admin', :h, 'staff', 'active')")
        ->execute([':h' => $hash]);
    $userId = (int) $pdo->lastInsertId();

    $roleStmt = $pdo->query("SELECT role_id FROM staff_roles WHERE role_name = 'Owner/Manager' LIMIT 1");
    $roleId = (int) ($roleStmt->fetch()['role_id'] ?? 1);

    $pdo->prepare('INSERT INTO staff (user_id, role_id, first_name, last_name, phone_number) VALUES (:u, :r, "System", "Admin", "0000000000")')
        ->execute([':u' => $userId, ':r' => $roleId]);

    echo "Created admin account.\nUsername: admin\nPassword: admin123\nPlease change this password.\n";
    exit;
}

$staffStmt = $pdo->prepare('SELECT staff_id FROM staff WHERE user_id = :uid');
$staffStmt->execute([':uid' => $user['user_id']]);
if (!$staffStmt->fetch()) {
    $roleStmt = $pdo->query("SELECT role_id FROM staff_roles WHERE role_name = 'Owner/Manager' LIMIT 1");
    $roleId = (int) ($roleStmt->fetch()['role_id'] ?? 1);
    $pdo->prepare('INSERT INTO staff (user_id, role_id, first_name, last_name, phone_number) VALUES (:u, :r, "System", "Admin", "0000000000")')
        ->execute([':u' => $user['user_id'], ':r' => $roleId]);
    echo "Linked existing 'admin' user to the Owner/Manager role (password unchanged).\n";
    exit;
}

echo "Admin account already exists and is linked to a staff role. Nothing to do.\n";
