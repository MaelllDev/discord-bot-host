import { useState } from "react";
import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { humanDuration } from "../format.ts";
import {
  Alert,
  Badge,
  Button,
  Card,
  DescriptionList,
  Field,
  InlineCode,
  Input,
  PageHeader,
  SkeletonCard,
} from "../components/ui.tsx";
import { IconAlert, IconLogout, IconSettings } from "../components/icons.tsx";
import { CREATOR, CreatorLinks, SupportLink } from "../components/Credits.tsx";
import AiSettingsCard from "../components/AiSettingsCard.tsx";
import WebhooksCard from "../components/WebhooksCard.tsx";
import ImageUpload from "../components/ImageUpload.tsx";
import LanguageSwitch from "../components/LanguageSwitch.tsx";
import { useI18n } from "../i18n/index.tsx";
import { useBranding } from "../branding.tsx";

/** Card de identidade visual: nome e ícone do painel, aplicados na hora. */
function BrandingCard() {
  const { t } = useI18n();
  const branding = useBranding();
  const [name, setName] = useState(branding.name);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim().length > 0 && name !== branding.name;

  const saveName = async (): Promise<void> => {
    setSaving(true);
    try {
      const result = await api.saveBranding({ name: name.trim() });
      branding.apply(result.branding);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t("settings.branding.title")} subtitle={t("settings.branding.hint")}>
      <div className="space-y-5">
        <Field label={t("settings.branding.name")} hint={t("settings.branding.name.hint")}>
          <div className="flex flex-wrap gap-2">
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={48} className="max-w-xs" />
            <Button variant="primary" disabled={!dirty} loading={saving} onClick={() => void saveName()}>
              {t("config.save")}
            </Button>
          </div>
        </Field>

        <ImageUpload
          value={branding.iconUrl === "/logo.png" ? "" : branding.iconUrl}
          onChange={(url) => {
            if (url) {
              void api
                .saveBranding({ iconUrl: url })
                .then((result) => branding.apply(result.branding));
            } else {
              void api
                .saveBranding({ iconUrl: "" })
                .then((result) => {
                  branding.apply(result.branding);
                  branding.resetIcon();
                });
            }
          }}
          label={t("settings.branding.icon")}
          hint={t("settings.branding.icon.hint")}
          size={64}
        />
      </div>
    </Card>
  );
}

interface SettingRow {
  variable: string;
  label: string;
  value: string | null;
  hint: string;
}

export default function Settings({ onLogout }: { onLogout?: () => void }) {
  const { t } = useI18n();
  const systemState = useAsync(() => api.system(), [], { pollMs: 30_000 });
  const system = systemState.data;

  if (systemState.loading && !system) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  if (!system) {
    return (
      <div className="space-y-3">
        <PageHeader title={t("nav.settings")} icon={<IconSettings className="h-4 w-4" />} />
        <Alert tone="red">{systemState.error ?? t("settings.readFailed")}</Alert>
      </div>
    );
  }

  const config = system.config;

  const rows: SettingRow[] = [
    {
      variable: "BOTPANEL_NAME",
      label: t("settings.row.panelName"),
      value: system.panelName,
      hint: t("settings.row.panelName.hint"),
    },
    {
      variable: "BOTPANEL_HOST",
      label: t("settings.row.host"),
      value: config.host,
      hint: t("settings.row.host.hint"),
    },
    {
      variable: "BOTPANEL_PORT",
      label: t("settings.row.port"),
      value: String(config.port),
      hint: t("settings.row.port.hint"),
    },
    {
      variable: "BOTPANEL_COOKIE_SECURE",
      label: t("settings.row.cookieSecure"),
      value: config.cookieSecure
        ? t("settings.row.cookieSecure.valueOn")
        : t("settings.row.cookieSecure.valueOff"),
      hint: t("settings.row.cookieSecure.hint"),
    },
    {
      variable: "BOTPANEL_DATA_DIR",
      label: t("system.env.dataDir"),
      value: system.dataDir,
      hint: t("settings.row.dataDir.hint"),
    },
    {
      variable: "BOTPANEL_DOCKER_SOCKET",
      label: t("system.env.dockerSocket"),
      value: config.dockerSocket,
      hint: t("settings.row.dockerSocket.hint"),
    },
    {
      variable: "BOTPANEL_RUN_UID / BOTPANEL_RUN_GID",
      label: t("settings.row.runUser"),
      value: `${config.runUid}:${config.runGid}`,
      hint: t("settings.row.runUser.hint"),
    },
    {
      variable: "BOTPANEL_MAX_UPLOAD_MB",
      label: t("settings.row.maxUpload"),
      value: `${config.maxUploadMb} MB`,
      hint: t("settings.row.maxUpload.hint"),
    },
    {
      variable: "BOTPANEL_KEEP_RELEASES",
      label: t("system.env.keepReleases"),
      value:
        config.keepReleases === 0
          ? t("settings.row.keepReleases.all")
          : t("system.env.keepLast", { count: config.keepReleases }),
      hint: t("settings.row.keepReleases.hint"),
    },
    {
      variable: "BOTPANEL_SESSION_TTL_HOURS",
      label: t("settings.row.sessionTtl"),
      value: `${config.sessionTtlHours} h (${humanDuration(config.sessionTtlHours * 3600)})`,
      hint: t("settings.row.sessionTtl.hint"),
    },
    {
      variable: "BOTPANEL_ALLOWED_IMAGES",
      label: t("settings.row.allowedImages"),
      value: config.allowedImages === null ? t("settings.row.allowedImages.any") : config.allowedImages.join(", "),
      hint: t("settings.row.allowedImages.hint"),
    },
    {
      variable: "BOTPANEL_PASSWORD / BOTPANEL_PASSWORD_HASH",
      label: t("settings.row.password"),
      value: t("settings.row.password.value"),
      hint: t("settings.row.password.hint"),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("nav.settings")}
        icon={<IconSettings className="h-4 w-4" />}
        subtitle={t("settings.subtitle")}
        actions={
          <Button size="sm" variant="outline" onClick={() => void systemState.reload()}>
            {t("common.refresh")}
          </Button>
        }
      />

      <BrandingCard />

      <WebhooksCard />

      <Card title={t("settings.language.title")} subtitle={t("settings.language.hint")}>
        <LanguageSwitch />
      </Card>

      <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
        {t("settings.readonly.before")} <InlineCode>GET /api/system</InlineCode>{" "}
        {t("settings.readonly.afterApi")} <InlineCode>/etc/botpanel.env</InlineCode>{", "}
        {t("settings.readonly.beforeReload")} <InlineCode>systemctl daemon-reload</InlineCode>{" "}
        {t("settings.readonly.afterReload")} <InlineCode>systemctl restart botpanel</InlineCode>
        {t("settings.readonly.tail")}
      </Alert>

      <Card
        title={t("settings.config.title")}
        subtitle={t("settings.config.hint")}
        footer={
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[11px] text-slate-500">
              {t("settings.instance.before")} <InlineCode>{config.instanceId}</InlineCode>{" "}
              {t("settings.instance.after")}
            </span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" onClick={() => void systemState.reload()}>
                {t("settings.reload")}
              </Button>
              {onLogout ? (
                <Button size="sm" variant="secondary" onClick={onLogout}>
                  <IconLogout className="h-3.5 w-3.5" /> {t("settings.logout")}
                </Button>
              ) : null}
            </div>
          </div>
        }
      >
        <ul className="divide-y divide-white/6">
          {rows.map((row) => (
            <li key={row.variable} className="space-y-2 py-3.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-slate-200">{row.label}</p>
                <Badge>
                  <span className="font-mono">{row.variable}</span>
                </Badge>
              </div>
              <p className="text-[11px] text-slate-500">{row.hint}</p>
              <p className="max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-white/5 bg-slate-950/60 px-3 py-2 font-mono text-[11px] text-slate-200">
                {row.value ?? "—"}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <AiSettingsCard />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("settings.ops.title")} subtitle={t("settings.ops.hint")}>
          <DescriptionList
            items={[
              { label: t("settings.ops.status"), value: <InlineCode>systemctl status botpanel</InlineCode> },
              { label: t("settings.ops.logs"), value: <InlineCode>journalctl -u botpanel -f</InlineCode> },
              { label: t("settings.ops.docker"), value: <InlineCode>systemctl status docker</InlineCode> },
              { label: t("settings.ops.containers"), value: <InlineCode>docker ps --filter label=botpanel.app</InlineCode> },
            ]}
          />
        </Card>

        <Card title={t("settings.auth.title")} subtitle={t("settings.auth.hint")}>
          <div className="space-y-3 text-xs leading-relaxed text-slate-300">
            <p>
              {t("settings.auth.body1.before")} <InlineCode>httpOnly</InlineCode>{" "}
              {t("settings.auth.body1.after")} {config.sessionTtlHours} h.
            </p>
            <p>
              {t("settings.auth.body2.before")} <strong>{t("settings.logout")}</strong>{" "}
              {t("settings.auth.body2.after")}
            </p>
            <p className="text-slate-500">{t("settings.auth.body3")}</p>
          </div>
        </Card>
      </div>

      <Card title={t("settings.credits.title")} subtitle={t("settings.credits.hint", { name: CREATOR.name })}>
        <div className="flex flex-wrap items-start gap-4">
          <img
            src="/logo.png"
            alt=""
            width={56}
            height={56}
            className="h-14 w-14 shrink-0 rounded-xl border border-white/10 bg-slate-950/60 object-contain p-1"
          />
          <div className="min-w-0 flex-1 space-y-3 text-xs leading-relaxed text-slate-300">
            <p>
              {t("settings.credits.body.before")} <strong>{t("settings.credits.body.strong")}</strong>
              {t("settings.credits.body.after")}
            </p>
            <CreatorLinks />
            <p className="text-[11px] text-slate-500">
              {t("settings.credits.footer", { name: CREATOR.name })}
            </p>
            <div className="max-w-xs pt-1">
              <SupportLink />
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
