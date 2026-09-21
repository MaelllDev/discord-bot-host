import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { Badge, Button, cn } from "./ui.tsx";
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

const NAV_GROUPS = [
  {
    label: null,
    items: [
      { to: "/", label: "Dashboard", icon: IconDashboard, end: true },
      { to: "/apps", label: "Aplicações", icon: IconApps, end: true },
      { to: "/apps/new", label: "Nova aplicação", icon: IconPlus, end: false },
    ],
  },
  {
    label: "Gerenciar",
    items: [
      { to: "/backups", label: "Backups", icon: IconArchive, end: false },
      { to: "/system", label: "Sistema", icon: IconServer, end: false },
      { to: "/settings", label: "Configurações", icon: IconSettings, end: false },
    ],
  },
] as const;

const PAGE_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/apps": "Aplicações",
  "/apps/new": "Nova aplicação",
  "/backups": "Backups",
  "/system": "Sistema",
  "/settings": "Configurações",
};

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
  const panelName = system?.panelName ?? "BotPanel";

  // Título da barra superior: a rota atual, ou o nome da aplicação aberta.
  const detailSlug = location.pathname.startsWith("/apps/") ? location.pathname.slice("/apps/".length) : null;
  const currentApp = detailSlug ? apps.find((app) => app.slug === detailSlug) : undefined;
  const pageTitle = currentApp?.name ?? PAGE_TITLES[location.pathname] ?? panelName;

  const navLink = ({ isActive }: { isActive: boolean }): string =>
    cn(
      "group relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-200",
      collapsed && "lg:justify-center lg:px-0",
      isActive
        ? "bg-indigo-500/15 text-white shadow-[inset_0_0_0_1px_rgb(124_92_255/0.22)]"
        : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200",
    );

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-screen w-64 flex-col border-r border-white/8 bg-slate-900 transition-[width,transform] duration-200 ease-out lg:relative lg:translate-x-0",
          collapsed ? "lg:w-16" : "lg:w-64",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-2.5 border-b border-white/8 px-4",
            collapsed && "lg:justify-center lg:px-0",
          )}
        >
          <Link
            to="/"
            className={cn("flex min-w-0 flex-1 items-center gap-2.5", collapsed && "lg:justify-center")}
            onClick={() => setOpen(false)}
          >
            <img
              src="/logo.png"
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 shrink-0 rounded-md border border-white/10 bg-slate-950/60 object-contain"
            />
            <span className={cn("truncate text-sm font-semibold text-slate-100", collapsed && "lg:hidden")}>
              {panelName}
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

        {/* Cartão da instância: identidade + resumo, como o “workspace” do topo. */}
        <div className={cn("px-2 py-2", collapsed && "lg:px-1")}>
          <div
            className={cn(
              "flex items-center gap-2.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2",
              collapsed && "lg:justify-center lg:px-0",
            )}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-indigo-500/15 text-[11px] font-semibold uppercase text-indigo-200">
              {panelName.slice(0, 1)}
            </span>
            <div className={cn("flex min-w-0 flex-1 flex-col", collapsed && "lg:hidden")}>
              <span className="truncate text-xs font-medium text-slate-200">Instância local</span>
              <span className="truncate text-[10.5px] text-slate-500">
                {apps.length} app(s) · {runningCount} no ar
              </span>
            </div>
            {!collapsed && runningCount > 0 ? (
              <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-300">
                {runningCount}
              </span>
            ) : null}
          </div>
        </div>

        <nav className={cn("flex-1 overflow-y-auto px-2 pb-3", collapsed && "lg:px-1")}>
          {NAV_GROUPS.map((group, groupIndex) => (
            <div key={group.label ?? `group-${groupIndex}`}>
              {groupIndex > 0 ? <div aria-hidden="true" className="mx-1.5 my-1.5 h-px bg-white/8" /> : null}
              {group.label ? (
                <p
                  className={cn(
                    "px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500",
                    collapsed && "lg:sr-only",
                  )}
                >
                  {group.label}
                </p>
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      className={navLink}
                      onClick={() => setOpen(false)}
                      title={collapsed ? item.label : undefined}
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon
                            className={cn(
                              "h-4 w-4 shrink-0 transition-colors duration-200",
                              isActive ? "text-indigo-300" : "text-slate-500 group-hover:text-slate-300",
                            )}
                          />
                          <span className={cn("truncate", collapsed && "lg:hidden")}>{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div aria-hidden="true" className="mx-1.5 my-1.5 h-px bg-white/8" />

          <p
            className={cn(
              "px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500",
              collapsed && "lg:sr-only",
            )}
          >
            Minhas aplicações
          </p>
          <ul className="flex flex-col gap-0.5">
            {apps.map((app) => {
              const active = location.pathname === `/apps/${app.slug}`;
              return (
                <li key={app.id}>
                  <Link
                    to={`/apps/${app.slug}`}
                    onClick={() => setOpen(false)}
                    title={app.name}
                    className={cn(
                      "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-200",
                      collapsed && "lg:justify-center lg:px-0",
                      active
                        ? "bg-white/[0.07] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]"
                        : "text-slate-300 hover:bg-white/[0.05] hover:text-slate-100",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
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
                    <span
                      className={cn(
                        "ml-auto shrink-0 text-[9.5px] uppercase tracking-wide text-slate-500",
                        collapsed && "lg:hidden",
                      )}
                    >
                      {app.runtime}
                    </span>
                  </Link>
                </li>
              );
            })}
            {apps.length === 0 && !appsState.loading && !collapsed ? (
              <li className="px-2.5 py-3 text-xs leading-relaxed text-slate-500">
                Nenhuma aplicação ainda.{" "}
                <Link
                  to="/apps/new"
                  className="text-indigo-300 transition-colors hover:text-indigo-200"
                  onClick={() => setOpen(false)}
                >
                  Criar a primeira
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>

        <div className={cn("flex flex-col gap-1.5 border-t border-white/8 p-2", collapsed && "lg:px-1")}>
          {dockerOk ? (
            <div
              className={cn(
                "flex h-8 items-center gap-2 px-2.5 text-[11px] font-medium text-emerald-400",
                collapsed && "lg:justify-center lg:px-0",
              )}
              title={system?.docker.version ? `Docker ${system.docker.version}` : "Docker conectado"}
            >
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              <span className={cn(collapsed && "lg:sr-only")}>Tudo operacional</span>
            </div>
          ) : (
            <div
              className={cn(
                "flex h-8 items-center gap-2 rounded-md border border-rose-500/25 bg-rose-500/10 px-2.5 text-[11px] font-medium text-rose-300",
                collapsed && "lg:justify-center lg:px-0",
              )}
            >
              <IconAlert className="h-3.5 w-3.5 shrink-0" />
              <span className={cn(collapsed && "lg:sr-only")}>Docker indisponível</span>
            </div>
          )}

          <SupportLink compact iconOnly={collapsed} />

          <Button
            variant="ghost"
            size="sm"
            className={cn("justify-start", collapsed && "lg:justify-center lg:px-0")}
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
          className="absolute -right-3 top-4 hidden h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-slate-800 text-slate-400 shadow-lg transition-colors hover:border-white/20 hover:text-slate-100 lg:flex"
        >
          <IconChevronLeft className={cn("h-3.5 w-3.5 transition-transform duration-200", collapsed && "rotate-180")} />
        </button>
      </aside>

      {open ? (
        <button
          type="button"
          aria-label="Fechar menu"
          className="fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-sm lg:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-white/8 bg-slate-950/85 px-4 backdrop-blur-xl sm:px-6">
          <Button
            variant="outline"
            size="sm"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Abrir menu"
          >
            <IconMenu className="h-4 w-4" />
          </Button>
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="truncate text-sm font-semibold text-slate-100">{pageTitle}</h1>
            {currentApp ? (
              <span className="hidden truncate font-mono text-[11px] text-slate-500 sm:inline">
                {currentApp.slug}
              </span>
            ) : null}
            {currentApp ? (
              <span className="hidden md:inline-flex">
                <Badge
                  tone={currentApp.status === "running" ? "green" : currentApp.status === "unknown" ? "red" : "slate"}
                >
                  {currentApp.status === "running" ? "no ar" : currentApp.status === "unknown" ? "desconhecido" : "parada"}
                </Badge>
              </span>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {dockerOk ? (
              <Badge tone="green" className="hidden sm:inline-flex">
                Docker conectado
              </Badge>
            ) : (
              <Badge tone="red">
                <IconAlert className="h-3 w-3" /> Docker off
              </Badge>
            )}
            {location.pathname === "/apps/new" ? null : (
              <Link to="/apps/new">
                <Button variant="primary" size="sm">
                  <IconPlus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Nova aplicação</span>
                </Button>
              </Link>
            )}
          </div>
        </header>

        {!dockerOk ? (
          <div className="border-b border-rose-900/40 bg-rose-950/30 px-4 py-2 text-[11px] text-rose-200">
            O Docker está inacessível. Os estados das aplicações aparecem como <strong>Desconhecido</strong> — não como
            paradas — até o daemon voltar.
          </div>
        ) : null}

        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-7">
          {/* Um erro em uma página não pode derrubar o painel inteiro. */}
          <div className="mx-auto w-full max-w-[1500px]">
            <RouteErrorBoundary>
              <Outlet />
            </RouteErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
