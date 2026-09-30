<<<<<<< HEAD
# Study Hub on Firebase Spark

This version runs without Cloud Functions. The browser uses Firebase Authentication and Cloud Firestore directly, with Firestore Security Rules controlling access. Firebase Hosting serves the static app. No paid backend deployment is configured.

## Firebase setup

1. In Firebase Console for project `study-hub-bf7e1`, create the default Firestore database and enable **Email/Password** under Authentication sign-in providers.
2. Confirm the Firebase web app values in `assets/js/config.js` match **Project settings > Your apps**. These client configuration values identify the app; they are not Admin credentials.
3. Install and sign in to the Firebase CLI, then deploy only Spark-supported services:

   ```powershell
   firebase login
   firebase deploy --only firestore:rules,hosting
   ```

4. Open the Firebase Hosting URL. For local testing:

   ```powershell
   firebase emulators:start --only auth,firestore,hosting
   ```

## Login and permissions

Customers sign in with their email address. Staff sign in with their username; the client maps it to the internal Firebase email assigned during import. Customer phone-number login is not supported because resolving phone numbers before authentication would require a publicly readable account lookup.

The importer converts each staff role's permission string to a Firestore array. Run the importer again after applying this version if staff profiles were already imported, so Firestore Rules see the permission arrays. Firestore Rules deny access by default and gate writes by the authenticated profile's account type/status and staff permissions.

Because Spark has no trusted server code, all business operations execute on the client. Security Rules can constrain access and record shapes, but they cannot make privileged client-side billing/payment calculations tamper-proof against an authorized staff account. Do not use this deployment for real-money processing or sensitive production records without a trusted backend.

## Import existing MySQL data

The migration utility is a local script; it is not deployed as a Function. It preserves SQL primary keys as Firestore document IDs, imports existing bcrypt hashes into Firebase Authentication, and writes the application collections.

1. Install the migration dependencies:

   ```powershell
   npm --prefix functions install
   ```

2. Sign in to Google Cloud Application Default Credentials using an account with permission to manage the Firebase project's Firestore data and Authentication users:

   ```powershell
   gcloud auth application-default login
   ```

3. Set SQL connection values if needed, then run the importer:

   ```powershell
   $env:DB_HOST = "127.0.0.1"
   $env:DB_NAME = "study_hub_db"
   $env:DB_USER = "root"
   $env:DB_PASS = ""
   npm --prefix functions run migrate:sql
   ```

The importer updates matching records and skips Auth UIDs already present. Back up both systems before migration. After changing imported profile fields or rules, rerun it to update profiles.

## Collections

Firestore is schemaless and does not show empty collections. All 25 SQL tables have importer mappings; `users` is split between Firebase Authentication and the `users` profile collection. `space_maintenance`, `walkin_queue`, `receipts`, `notifications`, and `audit_log` have no seed rows in the SQL dump, so they appear in the Firestore console only after the app writes documents to them.

## Validation

Run `npm --prefix functions run check` to syntax-check the migration utility and Hosting smoke test. Run `npm --prefix functions run test:hosting` to verify Firebase Hosting serves the login and Firebase client assets without a Function rewrite. Auth/Firestore behavior still needs an emulator or the actual project to verify.
=======
# Study Hub on Firebase

The app uses Firebase Authentication, Cloud Firestore, and an HTTPS Cloud Function for its API. The browser does not read or write Firestore directly; `firestore.rules` denies client access, and the function verifies Firebase ID tokens and staff permissions before handling protected operations.

## Firebase setup

1. In Firebase Console for `study-hub-bf7e1`, create the default Firestore database and enable **Email/Password** under Authentication sign-in providers.
2. The web app configuration is in `assets/js/config.js`. These values identify the Firebase web app and are not service-account credentials.
3. Install the Firebase CLI, sign in with `firebase login`, then deploy from the project folder:

   ```powershell
   firebase deploy --only firestore:rules,functions,hosting
   ```

   Cloud Functions deployment requires the Blaze plan with billing enabled.

4. Open the Hosting URL. For local development, use the Firebase emulators rather than XAMPP because `/api/**` is routed through Cloud Functions:

   ```powershell
   firebase emulators:start --only auth,firestore,functions,hosting
   ```

## Import existing MySQL data

The importer is intended to run once per Firebase project, before staff and customers begin using it. It keeps MySQL primary keys as Firestore document IDs and imports existing bcrypt password hashes into Firebase Authentication. Staff usernames are assigned internal Firebase email addresses and remain valid sign-in identifiers; customer email and phone identifiers are preserved.

1. Keep MySQL available and install the Functions dependencies:

   ```powershell
   npm --prefix functions install
   ```

2. Authenticate the Google Cloud SDK for Admin SDK access. This uses your local credential store, not a key file:

   ```powershell
   gcloud auth application-default login
   ```

3. Set SQL connection variables if they differ from the XAMPP defaults, then run the importer:

   ```powershell
   $env:DB_HOST = "127.0.0.1"
   $env:DB_NAME = "study_hub_db"
   $env:DB_USER = "root"
   $env:DB_PASS = ""
   npm --prefix functions run migrate:sql
   ```

The importer updates matching Firestore documents and skips Firebase Auth UIDs already present, so it can resume after a partial import. Back up both systems before migration. The old PHP API has been removed; `study_hub_db.sql` remains only as a schema/backup reference and is excluded from Hosting.

## Existing accounts

The SQL seed accounts are imported by the migration script. Their passwords are preserved if Firebase accepts the imported bcrypt hashes. Verify a test account before switching users over; if Firebase rejects a legacy hash variant, reset that account's password through Firebase Authentication.

## Validation

After installing dependencies, run `npm --prefix functions run check` to syntax-check the Cloud Function and migration script. Run `npm --prefix functions run test:routes` for a Functions/Hosting rewrite and authentication-gate smoke test. `npm --prefix functions run test:emulator` additionally exercises Firebase Auth, Firestore, signup, and role enforcement; it requires the Firestore emulator to run successfully on the local Java installation.

With Java installed, run `npm --prefix functions run test:emulator` to start Firebase Auth, Firestore, Functions, and Hosting emulators and verify signup, token authentication, role checks, and Firestore rules. The command uses the demo project ID and does not touch production data.
>>>>>>> 4dba2c479cc71a1b85a56d73b8a823cf1dd36aba
