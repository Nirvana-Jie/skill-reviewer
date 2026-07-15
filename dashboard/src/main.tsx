import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";
import { UiPreferencesProvider } from "./ui-preferences";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Dashboard root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <UiPreferencesProvider>
      <App />
    </UiPreferencesProvider>
  </StrictMode>,
);
