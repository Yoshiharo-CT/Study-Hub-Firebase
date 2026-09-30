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
