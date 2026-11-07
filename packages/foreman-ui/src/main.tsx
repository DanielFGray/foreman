import { RegistryProvider } from "@effect/atom-react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installSocketTracking } from "./sockets.ts";
import "./styles.css";

installSocketTracking();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("foreman-ui: #root missing");
}

createRoot(root).render(
  <RegistryProvider>
    <App />
  </RegistryProvider>,
);
