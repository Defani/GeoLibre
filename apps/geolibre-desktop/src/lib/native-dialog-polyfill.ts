// Native window.confirm / alert / prompt (Defani edition).
//
// tauri-plugin-dialog 2.8.1 replaces window.confirm with an async function that
// invokes `plugin:dialog|confirm`, a command its own default permission set does
// not grant: every confirm() rejected ("not allowed by ACL") and, being a
// Promise, was truthy, so `if (!confirm(...)) return` never stopped anything.
// The app's ~20 callers expect the synchronous browser dialog, so restore it
// from a same-origin blank frame, whose dialog functions are untouched.

function restoreNativeDialogs(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (!tauri) return;
  try {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    (document.body ?? document.documentElement).appendChild(frame);
    const native = frame.contentWindow as (Window & typeof globalThis) | null;
    if (!native) return;
    const nConfirm = native.confirm.bind(native);
    const nAlert = native.alert.bind(native);
    const nPrompt = native.prompt.bind(native);
    window.confirm = (message?: string) => nConfirm(message);
    window.alert = (message?: unknown) => nAlert(message);
    window.prompt = (message?: string, value?: string) => nPrompt(message, value);
  } catch (error) {
    console.warn("[GeoLibre] Could not restore native dialogs", error);
  }
}

restoreNativeDialogs();
