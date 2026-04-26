# Staff avatar SVGs

Bundled portraits used as `staff.avatar_key` in the database (`/staff-avatars/{key}.svg`).

## Regenerating

From `client/`:

```bash
npm run generate:staff-avatars
```

This runs `client/scripts/generate-staff-avatars.mjs`, which:

- Writes SVG files here
- Regenerates `client/src/lib/staffAvatarCatalog.generated.ts`
- Regenerates `server/src/auth/staff_avatar_allowlist.inc`

## License

Generated with [DiceBear](https://www.dicebear.com/) v9 (MIT) using these styles (see each package on npm for full terms):

- `@dicebear/lorelei`
- `@dicebear/avataaars`
- `@dicebear/adventurer`

Attribution: [DiceBear](https://www.dicebear.com) (required for some styles; MIT applies to the listed packages above).
