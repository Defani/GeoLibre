// Defani edition: DesktopShell publishes its geometry-edit handlers here so the
// ArcMap-style Editor menu in the header can start and stop editing sessions.

export interface EditorActions {
  toggle: (layerId: string) => Promise<void> | void;
  cancel: () => void;
}

let actions: EditorActions | null = null;

export function publishEditorActions(next: EditorActions): void {
  actions = next;
}

export function getEditorActions(): EditorActions | null {
  return actions;
}
