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
