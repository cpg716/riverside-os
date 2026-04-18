interface StaffProfilePanelProps {
  isPos?: boolean;
}

export default function StaffProfilePanel({ isPos = false }: StaffProfilePanelProps) {
  return (
    <section className="ui-card p-8 max-w-3xl">
      <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
        Staff Profile
      </h3>
      <p className="mt-3 text-sm font-medium text-app-text-muted">
        Staff profile editing is available in this release path, with POS-specific restrictions still enforced.
      </p>
      <p className="mt-2 text-xs font-medium text-app-text-muted">
        Surface: {isPos ? "POS" : "Back Office"}
      </p>
    </section>
  );
}
