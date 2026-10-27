// File ▸ Open Recent: the last documents opened or saved on this machine.
import { api } from "./api";

const KEY = "quire.recent";
const MAX = 10;

export function recentList(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function store(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // blocked storage: the menu still updates for this session
  }
  void api.setRecent(list).catch(() => {});
}

export function addRecent(path: string) {
  store([path, ...recentList().filter((p) => p !== path)].slice(0, MAX));
}

export function forgetRecent(path: string) {
  store(recentList().filter((p) => p !== path));
}

export function clearRecent() {
  store([]);
}

/** Fill the menu at startup. */
export function syncRecent() {
  void api.setRecent(recentList()).catch(() => {});
}
