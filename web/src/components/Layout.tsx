import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { Badge, Button, StatusBadge, cn } from "./ui.tsx";
import AppIcon from "./AppIcon.tsx";
import { CreatorCredit, SupportLink } from "./Credits.tsx";
import RouteErrorBoundary from "./ErrorBoundary.tsx";
import {
  IconAlert,
  IconApps,
  IconArchive,
  IconChevronLeft,
  IconDashboard,
  IconLogout,
  IconMenu,
  IconPlus,
  IconServer,
  IconSettings,
} from "./icons.tsx";

function statusDotClass(status: string): string {
  switch (status) {
    case "running":
      return "bg-emerald-400";
    case "starting":
    case "restarting":
    case "deploying":
      return "bg-amber-400";
    case "crashed":
      return "bg-rose-500";
    default:
      return "bg-slate-600";
  }
}

const NAV = [
  { to: "/", label: "Dashboard", icon: IconDashboard, end: true },
  { to: "/apps", label: "Aplicações", icon: IconApps, end: true },
  { to: "/apps/new", label: "Nova aplicação", icon: IconPlus, end: false },
  { to: "/backups", label: "Backups", icon: IconArchive, end: false },
  { to: "/system", label: "Sistema", icon: IconServer, end: false },
  { to: "/settings", label: "Configurações", icon: IconSettings, end: false },
];

const COLLAPSE_KEY = "botpanel.sidebar.collapsed";

export default function Layout({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      // armazenamento indisponível (modo privado): a preferência só não persiste
    }
  }, [collapsed]);

  const appsState = useAsync(() => api.apps(), [], { pollMs: 5000 });
  const systemState = useAsync(() => api.system(), [], { pollMs: 20_000 });

  const apps = appsState.data?.apps ?? [];
  const system = systemState.data;
  const dockerOk = system?.docker.available ?? true;
  const runningCount = apps.filter((app) => app.status === "running").length;

  const navLink = ({ isActive }: { isActive: boolean }): string =>
    cn(
      "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition",
      collapsed && "lg:justify-center lg:px-0",
      isActive
        ? "bg-gradient-to-r from-indigo-500/20 to-violet-500/10 text-white ring-1 ring-inset ring-white/10"
        : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
    );

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-screen w-72 flex-col border-r border-white/10 bg-slate-950/85 backdrop-blur-xl transition-all duration-200 ease-out lg:relative lg:translate-x-0",
          collapsed ? "lg:w-[4.75rem]" : "lg:w-72",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2.5 border-b border-white/5 px-4 py-4",
            collapsed && "lg:flex-col lg:gap-2 lg:px-2",
          )}
        >
          <Link to="/" className="flex min-w-0 flex-1 items-center gap-2.5" onClick={() => setOpen(false)}>
            <img
              src="/logo.png"
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 shrink-0 rounded-xl border border-white/10 bg-slate-950/40 object-contain"
            />
            <span className={cn("min-w-0", collapsed && "lg:hidden")}>
              <span className="block truncate text-sm font-semibold text-slate-100">
                {system?.panelName ?? "BotPanel"}
              </span>
              <span className="block text-[11px] text-slate-500">
                {apps.length} app(s) · {runningCount} ativa(s)
              </span>
            </span>
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            onClick={() => setOpen(false)}
            aria-label="Fechar menu"
          >
            ✕
          </Button>
        </div>

        <nav className={cn("space-y-1 p-2.5", collapsed && "lg:px-2")}>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={navLink}
              onClick={() => setOpen(false)}
              title={collapsed ? item.label : undefined}
            >
              <item.icon className="h-[18px] w-[18px] shrink-0" />
              <span className={cn("truncate", collapsed && "lg:hidden")}>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className={cn("flex-1 overflow-y-auto px-2.5 pb-3", collapsed && "lg:px-2")}>
          <p
            className={cn(
              "px-2 pb-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-slate-500",
              collapsed && "lg:sr-only",
            )}
          >
            Minhas aplicações
          </p>
          <ul className="space-y-0.5">
            {apps.map((app) => {
              const active = location.pathname === `/apps/${app.slug}`;
              return (
                <li key={app.id}>
                  <Link
                    to={`/apps/${app.slug}`}
                    onClick={() => setOpen(false)}
                    title={app.name}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition",
                      collapsed && "lg:justify-center lg:px-0",
                      active ? "bg-white/10 text-slate-100" : "text-slate-300 hover:bg-white/5",
                    )}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        statusDotClass(app.status),
                        collapsed && "lg:hidden",
                      )}
                    />
                    {collapsed ? (
                      <span className="hidden lg:block">
                        <AppIcon app={app} size="sm" />
                      </span>
                    ) : null}
                    <span className={cn("truncate", collapsed && "lg:hidden")}>{app.name}</span>
                    <span className={cn("ml-auto shrink-0 text-[10px] uppercase text-slate-500", collapsed && "lg:hidden")}>
                      {app.runtime}
                    </span>
                  </Link>
                </li>
              );
            })}
            {apps.length === 0 && !appsState.loading && !collapsed ? (
              <li className="px-2 py-3 text-xs text-slate-500">
                Nenhuma aplicação ainda.{" "}
                <Link to="/apps/new" className="text-indigo-300 hover:text-indigo-200" onClick={() => setOpen(false)}>
                  Criar a primeira
                </Link>
              </li>
            ) : null}
          </ul>
        </div>

        <div className={cn("space-y-2 border-t border-white/5 p-2.5", collapsed && "lg:px-2")}>
          {dockerOk ? (
            <Badge tone="green" className={cn(collapsed && "lg:hidden")}>
              Docker conectado{system?.docker.version ? ` · ${system.docker.version}` : ""}
            </Badge>
          ) : (
            <Badge tone="red" className={cn(collapsed && "lg:hidden")}>
              <IconAlert className="h-3 w-3" /> Docker indisponível
            </Badge>
          )}
          {collapsed ? (
            <div
              className="hidden justify-center lg:flex"
              title={dockerOk ? "Docker conectado" : "Docker indisponível"}
            >
              <span className={cn("h-2.5 w-2.5 rounded-full", dockerOk ? "bg-emerald-400" : "bg-rose-500")} />
            </div>
          ) : null}

          <SupportLink compact iconOnly={collapsed} />

          <Button
            variant="secondary"
            size="sm"
            className={cn("w-full", collapsed && "lg:px-0")}
            onClick={onLogout}
            title="Sair"
          >
            <IconLogout className="h-3.5 w-3.5" />
            <span className={cn(collapsed && "lg:hidden")}>Sair</span>
          </Button>

          <CreatorCredit className={cn("px-1 pt-1", collapsed && "lg:hidden")} />
        </div>

        {/* Recolher/expandir (somente desktop) */}
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "Expandir menu" : "Minimizar menu"}
          title={collapsed ? "Expandir menu" : "Minimizar menu"}
          className={cn(
            "absolute -right-3 top-20 hidden h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-slate-900 text-slate-400 shadow-lg transition hover:text-slate-100 lg:flex",
          )}
        >
          <IconChevronLeft className={cn("h-3.5 w-3.5 transition-transform", collapsed && "rotate-180")} />
        </button>
      </aside>

      {open ? (
        <button
          type="button"
          aria-label="Fechar menu"
          className="fixed inset-0 z-30 bg-slate-950/70 lg:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-white/5 bg-slate-950/80 px-4 py-3 backdrop-blur-xl lg:hidden">
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)} aria-label="Abrir menu">
            <IconMenu className="h-4 w-4" />
          </Button>
          <img src="/logo.png" alt="" width={24} height={24} className="h-6 w-6 shrink-0 rounded-lg" />
          <span className="truncate text-sm font-semibold text-slate-100">{system?.panelName ?? "BotPanel"}</span>
          <span className="ml-auto">
            {dockerOk ? <StatusBadge status="running" /> : <Badge tone="red">Docker off</Badge>}
          </span>
        </header>

        {!dockerOk ? (
          <div className="border-b border-rose-900/40 bg-rose-950/30 px-4 py-2 text-[11px] text-rose-200">
            O Docker está inacessível. Os estados das aplicações aparecem como <strong>Desconhecido</strong> — não como
            paradas — até o daemon voltar.
          </div>
        ) : null}

        <main className="min-w-0 flex-1 p-4 sm:p-6">
          {/* Um erro em uma página não pode derrubar o painel inteiro. */}
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </main>
      </div>
    </div>
  );
}
