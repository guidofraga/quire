import { render } from "solid-js/web";
import { App } from "./App";
import "./styles.css";

if (import.meta.env.DEV) {
  const errors: string[] = [];
  (window as unknown as { __errors: string[] }).__errors = errors;
  window.addEventListener("error", (e) => errors.push(`${e.message}\n${e.error?.stack ?? ""}`));
  window.addEventListener("unhandledrejection", (e) => errors.push(`rejection: ${e.reason?.stack ?? e.reason}`));
}

render(() => <App />, document.getElementById("root")!);
