<?php
declare(strict_types=1);
require __DIR__ . '/connection-pdo.php';

$op = get_operation();

switch ($op) {

    // ---------------- Phase 1.2 / 1.3 — Login (staff or customer) ----------------
    case 'login': {
        $identifier = trim((string) input('identifier', ''));
        $password = (string) input('password', '');
        if ($identifier === '' || $password === '') {
            json_response(['success' => false, 'message' => 'Enter your username/email/phone and password.']);
        }

        // Find the user by username, or (for customers) by email/phone.
        $stmt = $pdo->prepare(
            'SELECT u.* FROM users u
             LEFT JOIN customers c ON c.user_id = u.user_id
               WHERE u.username = :username OR c.email = :email OR c.phone_number = :phone
             LIMIT 1'
        );
        $stmt->execute([
            ':username' => $identifier,
            ':email' => $identifier,
            ':phone' => $identifier,
        ]);
        $user = $stmt->fetch();

        if (!$user || !password_verify($password, $user['password_hash'])) {
            json_response(['success' => false, 'message' => 'Incorrect username/email/phone or password.']);
        }
        if ($user['account_status'] !== 'active') {
            json_response(['success' => false, 'message' => 'This account is ' . $user['account_status'] . '. Contact the Study Hub staff.']);
        }

        if ($user['account_type'] === 'staff') {
            $stmt = $pdo->prepare(
                'SELECT s.staff_id, s.user_id, s.first_name, s.last_name, s.role_id,
                        r.role_name, r.permissions
                 FROM staff s JOIN staff_roles r ON s.role_id = r.role_id
                 WHERE s.user_id = :uid'
            );
            $stmt->execute([':uid' => $user['user_id']]);
            $staff = $stmt->fetch();
            if (!$staff) {
                json_response(['success' => false, 'message' => 'Staff record not found for this account.']);
            }
            $_SESSION['staff'] = $staff;
            unset($_SESSION['customer']);
            log_audit($pdo, 'login', 'users', (int) $user['user_id'], 'Staff login: ' . $staff['first_name'] . ' ' . $staff['last_name']);
            json_response([
                'success' => true,
                'account_type' => 'staff',
                'staff_id' => $staff['staff_id'],
                'name' => $staff['first_name'] . ' ' . $staff['last_name'],
                'role' => $staff['role_name'],
                'permissions' => $staff['permissions'],
            ]);
        } else {
            $stmt = $pdo->prepare('SELECT * FROM customers WHERE user_id = :uid');
            $stmt->execute([':uid' => $user['user_id']]);
            $customer = $stmt->fetch();
            if (!$customer) {
                json_response(['success' => false, 'message' => 'Customer record not found for this account.']);
            }
            $customer['user_id'] = $user['user_id'];
            $_SESSION['customer'] = $customer;
            unset($_SESSION['staff']);
            log_audit($pdo, 'login', 'users', (int) $user['user_id'], 'Customer login: ' . $customer['first_name'] . ' ' . $customer['last_name']);
            json_response([
                'success' => true,
                'account_type' => 'customer',
                'customer_id' => $customer['customer_id'],
                'name' => $customer['first_name'] . ' ' . $customer['last_name'],
            ]);
        }
    }

    // ---------------- Phase 1.1 — Customer registration ----------------
    case 'memberRegister': {
        $first = trim((string) input('first_name', ''));
        $last = trim((string) input('last_name', ''));
        $phone = trim((string) input('phone_number', ''));
        $email = trim((string) input('email', ''));
        $username = trim((string) input('username', '')) ?: $email;
        $password = (string) input('password', '');

        if ($first === '' || $last === '' || $phone === '' || $email === '' || strlen($password) < 6) {
            json_response(['success' => false, 'message' => 'Fill in all fields (password must be at least 6 characters).']);
        }

        $dupe = $pdo->prepare('SELECT customer_id FROM customers WHERE email = :email OR phone_number = :phone');
        $dupe->execute([':email' => $email, ':phone' => $phone]);
        if ($dupe->fetch()) {
            json_response(['success' => false, 'message' => 'An account with that email or phone number already exists.']);
        }
        $dupeUser = $pdo->prepare('SELECT user_id FROM users WHERE username = :u');
        $dupeUser->execute([':u' => $username]);
        if ($dupeUser->fetch()) {
            $username = $email . '.' . substr(bin2hex(random_bytes(2)), 0, 4);
        }

        try {
            $pdo->beginTransaction();

            $hash = password_hash($password, PASSWORD_DEFAULT);
            $stmt = $pdo->prepare(
                "INSERT INTO users (username, password_hash, account_type, account_status)
                 VALUES (:u, :p, 'customer', 'active')"
            );
            $stmt->execute([':u' => $username, ':p' => $hash]);
            $userId = (int) $pdo->lastInsertId();

            $stmt = $pdo->prepare(
                'INSERT INTO customers (user_id, first_name, last_name, phone_number, email)
                 VALUES (:uid, :f, :l, :ph, :e)'
            );
            $stmt->execute([':uid' => $userId, ':f' => $first, ':l' => $last, ':ph' => $phone, ':e' => $email]);
            $customerId = (int) $pdo->lastInsertId();

            log_audit($pdo, 'register', 'users', $userId, "Customer registered: $first $last");
            $pdo->commit();

            json_response(['success' => true, 'message' => 'Account created.', 'customer_id' => $customerId, 'username' => $username]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            json_response(['success' => false, 'message' => 'Registration failed: ' . $e->getMessage()], 500);
        }
    }

    // ---------------- Session check (used by index.html on load) ----------------
    case 'me': {
        if ($staff = current_staff()) {
            json_response(['success' => true, 'account_type' => 'staff', 'staff' => $staff]);
        }
        if ($cust = current_customer()) {
            json_response(['success' => true, 'account_type' => 'customer', 'customer' => $cust]);
        }
        json_response(['success' => false, 'message' => 'Not logged in.'], 401);
    }

    // ---------------- Logout ----------------
    case 'logout': {
        $_SESSION = [];
        session_destroy();
        json_response(['success' => true, 'message' => 'Logged out.']);
    }

    default:
        json_response(['success' => false, 'message' => 'Unknown operation.'], 400);
}
