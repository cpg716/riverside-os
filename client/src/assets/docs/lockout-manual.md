# Lockout Recovery Manual

If you or your staff are unable to sign in to the Riverside OS Back Office or POS Register, follow these steps to restore access.

## Common Causes
1. **Incorrect Staff Member Selected**: Ensure the correct name is selected on the touch-grid before entering the PIN.
2. **Expired Session**: If the application was open for a long time, refresh the page to ensure the login gate has the latest staff roster.
3. **Corrupted Security Hash**: Occasionally, a staff member's security hash may become mismatched after a database migration or bulk import.

## Level 1: Self-Service Repair (Requires one working Admin)
If at least one staff member with **Admin** access can still log in:
1. Go to the **Team** workspace.
2. Select the staff member who is locked out.
3. Locate the **PIN / Code** field (left column).
4. Re-type their 4-digit code (e.g., `1234`) even if it is already displayed.
5. Click **Save Changes**.
6. This forces the server to re-calculate and sync their security hash. They should now be able to log in.

## Level 2: Emergency Terminal Reset
If **no one** can log in (all admins are locked out), you must use the physical terminal where the server is running.

1. Open a Terminal window.
2. Navigate to the `riverside-os` directory.
3. Run the following command:
   ```bash
   ./scripts/ros-reset-admin-pin.sh "Your Full Name" "1234"
   ```
   *(Replace "Your Full Name" with the exact name in the system and "1234" with your desired temporary PIN).*
4. This script bypasses all security checks and resets that user to a "Legacy" state, allowing immediate login.
5. Once logged in, immediately go to your profile in the Team workspace and hit "Save" to re-harden your account with a secure hash.

## Level 3: Network Diagnostics
If the login screen displays "Auth server unreachable":
1. Check that the **Riverside OS Server** (Rust backend) is running.
2. Verify that the computer's network connection is active.
3. If using an iPad/Satellite, ensure the server computer and the iPad are on the same Tailscale network or local Wi-Fi.

## Diagnostic Feedback
The login screen provides specific clues:
- **"Invalid PIN"**: The credential did not match the stored hash.
- **"PIN belongs to another staff member"**: You entered a valid PIN, but for a different person than the one selected.
- **"404 Not Found"**: The server endpoint moved or is unreachable. Refresh the app.
