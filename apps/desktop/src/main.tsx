import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { applyTheme, readThemePreference } from "./lib/theme";
import { resolveTransport } from "./lib/transport";

async function boot() {
  // Aplica o tema antes do primeiro paint para evitar o flash do modo errado.
  applyTheme(readThemePreference());
  const transport = await resolveTransport();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App transport={transport} />
    </React.StrictMode>,
  );
}

void boot();
