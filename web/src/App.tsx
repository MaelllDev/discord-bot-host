import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { api, onUnauthorized } from "./api.ts";
import Layout from "./components/Layout.tsx";
import { ToastProvider } from "./components/Toasts.tsx";
import { Spinner } from "./components/ui.tsx";
import Login from "./pages/Login.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Apps from "./pages/Apps.tsx";
import Backups from "./pages/Backups.tsx";
import NewApp from "./pages/NewApp.tsx";
import AppDetail from "./pages/AppDetail.tsx";
import SystemPage from "./pages/System.tsx";
import Settings from "./pages/Settings.tsx";

type SessionState = "loading" | "authenticated" | "anonymous";

/**
 * O React Router reaproveita o componente ao trocar de aplicação (`/apps/a` →
 * `/apps/b`). Sem a `key`, o estado da aplicação anterior (dados carregados,
 * aba aberta, socket de tempo real) sobrevive por alguns instantes e aparece na
 * tela do novo bot. A chave força uma montagem limpa por slug.
 */
function AppDetailRoute() {
  const { slug } = useParams();
  return <AppDetail key={slug} />;
}

export default function App() {
  const [state, setState] = useState<SessionState>("loading");
  const [expired, setExpired] = useState(false);

  // Qualquer resposta 401 da API (sessão expirada no meio do uso) volta para o
  // login em vez de deixar a interface num estado quebrado.
  useEffect(() => {
    onUnauthorized(() => {
      setExpired(true);
      setState("anonymous");
    });
    return () => onUnauthorized(null);
  }, []);

  useEffect(() => {
    api
      .session()
      .then((session) => setState(session.authenticated ? "authenticated" : "anonymous"))
      .catch(() => setState("anonymous"));
  }, []);

  const handleLogin = useCallback(() => {
    setExpired(false);
    setState("authenticated");
  }, []);

  const handleLogout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setState("anonymous");
  }, []);

  if (state === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (state === "anonymous") {
    return <Login onSuccess={handleLogin} expired={expired} />;
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout onLogout={() => void handleLogout()} />}>
            <Route index element={<Dashboard />} />
            <Route path="apps" element={<Apps />} />
            <Route path="apps/new" element={<NewApp />} />
            <Route path="backups" element={<Backups />} />
            <Route path="apps/:slug" element={<AppDetailRoute />} />
            <Route path="system" element={<SystemPage />} />
            <Route path="settings" element={<Settings onLogout={() => void handleLogout()} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
