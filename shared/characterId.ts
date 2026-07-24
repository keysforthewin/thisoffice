/** "X Bot (1).fbx" -> "X_Bot_1"; returns null if nothing safe remains. */
export function sanitizeCharacterId(name: string): string | null {
  const id = name
    .replace(/\.(fbx|glb)$/i, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}
