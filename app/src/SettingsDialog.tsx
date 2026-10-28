// Quire ▸ Settings… (⌘,): app-wide preferences and the defaults for new documents.
import { onCleanup, onMount, Show } from "solid-js";
import { directPdf } from "./export";
import { Check, Field, LANGS, Num, Section, Select, Text } from "./Inspector";
import { type Prefs, prefs, resetPrefs, setPref, setSettingsOpen, settingsOpen, type Theme } from "./settings";

const PAPERS: [string, string][] = ["A4", "A3", "A5", "Letter", "Legal"].map((p) => [p, p]);

export function SettingsDialog() {
  return (
    <Show when={settingsOpen()}>
      <Dialog />
    </Show>
  );
}

function Dialog() {
  const close = () => setSettingsOpen(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  const toggle = (key: keyof Prefs) => (on: boolean) => setPref(key, on as never);
  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="settings" role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <button class="settings-close" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>
        <div class="settings-body insp-body">
          <Section title="Appearance">
            <Field label="Theme">
              <Select<Theme>
                value={prefs.theme}
                options={[
                  ["system", "Match system"],
                  ["light", "Light"],
                  ["dark", "Dark"],
                ]}
                onChange={(v) => setPref("theme", v)}
              />
            </Field>
            <Check checked={prefs.flatUnits} label="Write units on one line (80 km/h, not a fraction)" onChange={toggle("flatUnits")} />
          </Section>
          <Section title="Editing">
            <Check checked={prefs.latex} label="Convert LaTeX names as you type (\alpha → α)" onChange={toggle("latex")} />
            <Check checked={prefs.nameNotes} label="Point out names that could mean a unit or a constant" onChange={toggle("nameNotes")} />
            <Check checked={prefs.tooltips} label="Explain units and constants on hover" onChange={toggle("tooltips")} />
            <Check
              checked={prefs.shiftContent}
              label="Return and Delete on empty space move the content below"
              onChange={toggle("shiftContent")}
            />
          </Section>
          <Section title="PDF export">
            <Field label="Image resolution">
              <Select
                value={String(prefs.exportDpi)}
                options={[
                  ["300", "300 dpi — print"],
                  ["150", "150 dpi — screen, smaller files"],
                  ["0", "Original images"],
                ]}
                onChange={(v) => setPref("exportDpi", Number(v))}
              />
            </Field>
            <Show when={directPdf}>
              <Check checked={prefs.compressPhotos} label="Compress photos (drawings stay lossless)" onChange={toggle("compressPhotos")} />
            </Show>
          </Section>
          <Section title="New documents">
            <div class="insp-row">
              <Field label="Paper">
                <Select value={prefs.paper} options={PAPERS} onChange={(v) => setPref("paper", v)} />
              </Field>
              <Field label="Opens in">
                <Select<Prefs["view"]>
                  value={prefs.view}
                  options={[
                    ["pages", "Pages"],
                    ["canvas", "Canvas"],
                  ]}
                  onChange={(v) => setPref("view", v)}
                />
              </Field>
            </div>
            <div class="insp-row">
              <Field label="Text font">
                <Text value={prefs.font} placeholder="System" onCommit={(v) => setPref("font", v)} />
              </Field>
              <Field label="Size (pt)">
                <Num value={prefs.size} onCommit={(v) => setPref("size", v && v > 0 ? v : 10)} />
              </Field>
            </div>
            <div class="insp-row">
              <Field label="Decimals">
                <Num value={prefs.decimals} onCommit={(v) => setPref("decimals", v === undefined ? 4 : Math.max(0, Math.min(15, v)))} />
              </Field>
              <Field label="Language">
                <Select value={prefs.lang} options={[["", "System"], ...LANGS]} onChange={(v) => setPref("lang", v)} />
              </Field>
            </div>
          </Section>
          <button class="insp-link" onClick={resetPrefs}>
            Restore defaults
          </button>
        </div>
      </div>
    </div>
  );
}
