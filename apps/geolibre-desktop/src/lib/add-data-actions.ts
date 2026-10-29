// Defani edition: the Add Data menu publishes its handlers here so the
// QGIS-style "Manage Layers" toolbar can open the very same dialogs. A plain
// module-level registry (no React state): the toolbar reads it at click time.

export interface AddDataAction {
  onSelect: () => void;
  disabled?: boolean;
}

let actions: Record<string, AddDataAction> = {};

export function publishAddDataActions(next: Record<string, AddDataAction>): void {
  actions = next;
}

export function runAddDataAction(id: string): boolean {
  const action = actions[id];
  if (!action || action.disabled) return false;
  action.onSelect();
  return true;
}

export function isAddDataActionAvailable(id: string): boolean {
  const action = actions[id];
  return !!action && !action.disabled;
}
