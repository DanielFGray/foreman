import { RegistryProvider } from "@effect/atom-react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("foreman-ui: #root missing");
}

// The registry takes the page's default inputs (pageInputsAtom): this page's
// own origin and a reload of the page.
createRoot(root).render(
  <RegistryProvider>
    <App />
  </RegistryProvider>,
);
