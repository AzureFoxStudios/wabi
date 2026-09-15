/** Published content and an editor draft are different states, even before live sharing exists. */
export interface LoreEditorState {
  editing: boolean;
  dirty: boolean;
  busy: boolean;
  submitted: boolean;
}

export function editorStatus(state: LoreEditorState): string {
  if (state.busy) return state.editing ? 'Saving changes…' : 'Opening editor…';
  if (!state.editing) return 'Published file';
  if (state.dirty) return 'Private draft · Unsaved changes';
  if (state.submitted) return 'Submitted for review · Not published';
  return 'Private draft · No unpublished changes';
}
