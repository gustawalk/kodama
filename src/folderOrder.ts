import type { Folder } from "./types";

export function reorderSiblingFolder(folders: Folder[], sourceId: string, targetId: string, after: boolean): Folder[] {
  const source = folders.find((folder) => folder.id === sourceId);
  const target = folders.find((folder) => folder.id === targetId);
  if (!source || !target || sourceId === targetId || source.parentId !== target.parentId) return folders;
  const reordered = [...folders];
  reordered.splice(reordered.findIndex((folder) => folder.id === sourceId), 1);
  const targetIndex = reordered.findIndex((folder) => folder.id === targetId);
  reordered.splice(targetIndex + (after ? 1 : 0), 0, source);
  return reordered;
}

export function moveSiblingFolder(folders: Folder[], folderId: string, direction: -1 | 1): Folder[] {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return folders;
  const siblings = folders.filter((item) => item.parentId === folder.parentId);
  const target = siblings[siblings.findIndex((item) => item.id === folderId) + direction];
  return target ? reorderSiblingFolder(folders, folderId, target.id, direction > 0) : folders;
}
