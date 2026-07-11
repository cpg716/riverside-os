# Release Code Signing

Riverside updater signatures and operating-system code signatures protect different boundaries. `TAURI_SIGNING_PRIVATE_KEY` signs updater payloads so an installed Riverside application can reject a tampered update. Windows Authenticode and Apple Developer ID signing establish publisher trust with Windows and macOS.

## Current release gate

- Every updater build requires `TAURI_SIGNING_PRIVATE_KEY` and `RIVERSIDE_UPDATER_PUBLIC_KEY`.
- Windows release artifacts can be checked with `deployment/windows/verify-release-code-signing.ps1` after a trusted certificate is configured.
- macOS release artifacts must pass both `codesign --verify --deep --strict` and `spctl --assess` after Apple signing and notarization are configured.
- Do not substitute a self-signed certificate for production publisher trust.

## Credentials still required from certificate authorities

Windows needs an organization-validated or extended-validation code-signing certificate whose private key is available to the GitHub runner through a protected secret or managed signing service. macOS needs an Apple Developer ID Application certificate plus Apple notarization credentials. These credentials must be stored as GitHub environment secrets with release-only access and must never be committed.

Recommended secret names are `WINDOWS_CODE_SIGNING_PFX_BASE64`, `WINDOWS_CODE_SIGNING_PASSWORD`, `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_PASSWORD`, and `APPLE_TEAM_ID`.

After signing is configured, set the repository variable `RIVERSIDE_REQUIRE_AUTHENTICODE=true` and the macOS variable `RIVERSIDE_REQUIRE_APPLE_SIGNING=true`. The release workflows then fail before publishing if Windows signatures, Apple signatures, or Apple trust assessment are invalid.

Once the certificates are available, import them into an ephemeral runner key store, pass the selected identity to Tauri, verify every generated executable/installer, notarize the macOS bundle, and remove the key store before the job ends.
