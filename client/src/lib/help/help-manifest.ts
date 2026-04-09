/**
 * In-app Help: add **`client/src/assets/docs/*-manual.md`**, then **`npm run generate:help`**
 * (or **`prebuild`** on **`npm run build`**). See **`docs/MANUAL_CREATION.md`**.
 */
export type { HelpManual } from "./help-manifest.types";
export { HELP_MANUALS, helpManualById } from "./help-manifest.generated";
