export const WEDDING_MEMBER_ROLE_OPTIONS = [
  "Groom",
  "Groomsman",
  "Best Man",
  "Father",
  "Father of Groom",
  "Father of Bride",
  "Child",
  "Usher",
  "Ring Bearer",
  "Other",
] as const;

export function isPresetWeddingMemberRole(role: string | null | undefined): boolean {
  return WEDDING_MEMBER_ROLE_OPTIONS.some(
    (option) => option !== "Other" && option === role,
  );
}
