import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import AppIcon from "../components/AppIcon.tsx";
import BackupsPanel from "../components/panels/BackupsPanel.tsx";
import { Alert, Button, EmptyState, PageHeader, SkeletonCard, StatusBadge } from "../components/ui.tsx";
import { IconArchive, IconApps, IconPlus } from "../components/icons.tsx";
import { runtimeLabel } from "../format.ts";
import { useI18n } from "../i18n/index.tsx";

/**
 * Página de backups: um cartão por aplicação, com criação, download e exclusão
 * dos ZIPs. Todo o trabalho é feito pela API — o frontend não manipula arquivos.
 */
export default function Backups() {
  const { t } = useI18n();
  const appsState = useAsync(() => api.apps(), [], { pollMs: 15_000 });
  const apps = appsState.data?.apps ?? [];
  const loading = appsState.loading && appsState.data === null;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("nav.backups")}
        icon={<IconArchive className="h-4 w-4" />}
        subtitle={t("backups.page.subtitle")}
        actions={
          <Link to="/apps">
            <Button variant="outline">
              <IconApps className="h-4 w-4" /> {t("backups.page.viewApps")}
            </Button>
          </Link>
        }
      />

      {appsState.error ? <Alert tone="red">{appsState.error}</Alert> : null}

      {loading ? (
        <div className="grid gap-4">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      ) : null}

      {!loading && apps.length === 0 ? (
        <EmptyState
          title={t("backups.page.empty.title")}
          description={t("backups.page.empty.description")}
          action={
            <Link to="/apps/new">
              <Button variant="primary">
                <IconPlus className="h-4 w-4" /> {t("nav.newApp")}
              </Button>
            </Link>
          }
        />
      ) : null}

      {apps.map((app) => (
        <div key={app.id} className="space-y-2">
          <div className="flex items-center gap-2.5 px-1">
            <AppIcon app={app} size="sm" />
            <Link to={`/apps/${app.slug}`} className="text-sm font-medium text-slate-200 hover:text-indigo-300">
              {app.name}
            </Link>
            <StatusBadge status={app.status} />
            <span className="text-[11px] text-slate-500">
              {runtimeLabel(app.runtime)}
              {app.activeRelease > 0 ? ` · v${app.activeRelease}` : ` · ${t("apps.noVersion")}`}
            </span>
          </div>
          <BackupsPanel app={app} />
        </div>
      ))}
    </div>
  );
}
