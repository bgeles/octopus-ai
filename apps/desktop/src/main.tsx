import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { resolveTransport } from "./lib/transport";

async function boot() {
  const transport = await resolveTransport();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App transport={transport} />
    </React.StrictMode>,
  );
}

void boot();
