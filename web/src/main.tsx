import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { I18nProvider } from "./i18n/index.tsx";
import { BrandingProvider } from "./branding.tsx";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Elemento #root não encontrado");

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <BrandingProvider>
        <App />
      </BrandingProvider>
    </I18nProvider>
  </StrictMode>,
);
