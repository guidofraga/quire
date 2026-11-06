import { render } from "solid-js/web";
import { api, exportJob } from "./api";
import { App } from "./App";
import "./styles.css";

if (import.meta.env.DEV) {
  const errors: string[] = [];
  (window as unknown as { __errors: string[] }).__errors = errors;
  window.addEventListener("error", (e) => errors.push(`${e.message}\n${e.error?.stack ?? ""}`));
  window.addEventListener("unhandledrejection", (e) => errors.push(`rejection: ${e.reason?.stack ?? e.reason}`));
}

// a headless export's first sign of life, before anything else can fail (issue #59)
if (exportJob) void api.exportStep("starting the page").catch(() => {});

render(() => <App />, document.getElementById("root")!);
