/** Appends a toast message to a redirect path. Server actions call `redirect(toastPath(...))`
 *  instead of a bare `revalidatePath`, so the client can pick the message up from the URL —
 *  see components/ToastListener.tsx, which reads and then strips this param. */
export function toastPath(path: string, message: string, type: "success" | "error" = "success") {
  const sep = path.includes("?") ? "&" : "?";
  const typeParam = type !== "success" ? `&toastType=${type}` : "";
  return `${path}${sep}toast=${encodeURIComponent(message)}${typeParam}`;
}
