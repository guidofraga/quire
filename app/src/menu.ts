// A lightweight, keyboard-dismissable context menu (right-click on regions and the canvas).
import { createSignal } from "solid-js";

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  run?: () => void;
}

/** `null` items draw separators. */
export type MenuItems = (MenuItem | null)[];

export const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItems } | null>(null);

let regionMenuBuilder: (id: string | null) => MenuItems = () => [];

/** The app supplies the items (it owns the commands). */
export function setRegionMenuBuilder(fn: (id: string | null) => MenuItems) {
  regionMenuBuilder = fn;
}

export function openRegionMenu(e: MouseEvent, id: string | null) {
  openRegionMenuAt(e.clientX, e.clientY, id);
}

/** The same menu at a point (from the keyboard: ⇧F10 or the menu key). */
export function openRegionMenuAt(x: number, y: number, id: string | null) {
  setMenu({ x, y, items: regionMenuBuilder(id) });
}

export function closeMenu() {
  setMenu(null);
}
