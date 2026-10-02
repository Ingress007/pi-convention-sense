/**
 * Everything injected into the model context is wrapped in tags such as `<local-convention>`. Names
 * that come from the repository (paths, module and package names, profile text) must not be able to
 * open, close or forge those tags.
 */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
