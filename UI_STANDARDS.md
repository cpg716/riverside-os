# Riverside OS — UI Standards (Zero-Browser-Dialog)

Riverside OS (ROS) enforces a **Zero-Browser-Dialog Discipline**. Native browser popups (`alert`, `confirm`, `prompt`) are strictly prohibited in all operational workspaces.

## Canonical Feedback Components

### 1. `useToast()` (Informative Feedback)
Used for transient success messages, warnings, or errors that do not block the user's flow.

```tsx
import { useToast } from '../ui/ToastProvider';

const MyComponent = () => {
  const { toast } = useToast();

  const handleSave = async () => {
    try {
      await api.save();
      toast("Changes saved successfully.", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };
};
```

### 2. `ConfirmationModal` (User Intent Verification)
Used for destructive or high-impact actions (delete, restore, finalize).

```tsx
import ConfirmationModal from '../ui/ConfirmationModal';

const [showConfirm, setShowConfirm] = useState(false);

return (
  <>
    <button onClick={() => setShowConfirm(true)}>Delete Item</button>
    
    <ConfirmationModal
      isOpen={showConfirm}
      onClose={() => setShowConfirm(false)}
      onConfirm={handleDelete}
      title="Delete Product?"
      message="This action cannot be undone."
      confirmLabel="Delete"
      variant="danger"
    />
  </>
);
```

### 3. `PromptModal` (User Input)
Used when the user needs to provide a string or selection during a workflow.

```tsx
import PromptModal from '../ui/PromptModal';

<PromptModal
  isOpen={showPrompt}
  onClose={() => setShowPrompt(false)}
  onSubmit={handleAssign}
  title="Assign Wedding"
  label="Enter Party Name or Groom ID"
  placeholder="e.g. Smith 2025"
/>
```

## Design Invariants
1. **Emerald Green Action Pattern (terminal completion)**: Primary **money / completion** actions use **`bg-emerald-600`** with a **heavy bottom border** (**`border-b-8 border-emerald-800`**) and sensible hover/active affordances. **POS:** **Complete Sale**, **Add to sale** (and similar). **Back Office (same pattern where the action finalizes operational work):** **Receiving → Post inventory**, embedded **Wedding Manager → Action Dashboard** quick **Done**, **Customers → Merge** confirm on duplicate merge. Prefer this over **`bg-app-accent`** for those “commit the workflow” controls so register and back-office completion reads consistently.
2. **Zero-Scroll Discipline**: Workspace drawers and POS components must be designed for zero-scrolling on 1080p (Back Office list-heavy surfaces may still scroll; see **`docs/CLIENT_UI_CONVENTIONS.md`**).
3. **True Dark Mode**: All non-POS workspaces (Weddings, CRM, Inventory) use the ROS True Dark palette (`bg-app-bg`).
4. **Reading vs chrome typography**: **`ConfirmationModal`**, **`PromptModal`**, and other **instructional** blocks use **`ui-type-instruction`** / **`ui-type-instruction-muted`** (sentence case, comfortable line-height). Reserve **`ui-type-chrome`** (uppercase micro-labels) for short labels only—see **`docs/CLIENT_UI_CONVENTIONS.md`** § Typography roles.

## See also

- **[`docs/CLIENT_UI_CONVENTIONS.md`](docs/CLIENT_UI_CONVENTIONS.md)** — layout primitives, **`useDialogAccessibility`**, lazy workspaces in **`App.tsx`**, embedded Wedding Manager wiring, **`client/UI_WORKSPACE_INVENTORY.md`** tab map.
- **[`docs/ROS_UI_CONSISTENCY_PLAN.md`](docs/ROS_UI_CONSISTENCY_PLAN.md)** — full-app **`data-theme`** / Tailwind **`dark:`** + typography sweep; **Phases 1–5** complete (2026-04-08); ongoing grep hygiene; guest **`/shop`** deferred.
