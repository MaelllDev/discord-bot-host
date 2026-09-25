import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { errorText } from "../hooks.ts";
import { Alert, Button, Field, Input } from "../components/ui.tsx";
import { IconAlert } from "../components/icons.tsx";
import { CreatorCredit } from "../components/Credits.tsx";
import { useI18n } from "../i18n/index.tsx";
import { useBranding } from "../branding.tsx";
import LanguageSwitch from "../components/LanguageSwitch.tsx";

export default function Login({ onSuccess, expired = false }: { onSuccess: () => void; expired?: boolean }) {
  const { t } = useI18n();
  const branding = useBranding();

  // A aba do navegador usa o nome personalizado também no login.
  useEffect(() => {
    document.title = branding.name;
  }, [branding.name]);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (password.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (caught) {
      setError(errorText(caught));
      setPassword("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <img
            src={branding.iconUrl || "/logo.png"}
            alt=""
            width={56}
            height={56}
            className="mx-auto h-14 w-14 rounded-xl border border-indigo-400/20 bg-slate-900 object-contain p-1 shadow-[0_0_34px_-16px_rgb(124_92_255/0.9)]"
          />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-slate-50">{branding.name}</h1>
          <p className="mt-1 text-xs text-slate-500">{t("login.subtitle")}</p>
        </div>

        <div className="mb-4 flex justify-center">
          <LanguageSwitch />
        </div>

        {expired ? (
          <div className="mb-4">
            <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
              {t("login.expired")}
            </Alert>
          </div>
        ) : null}

        <form onSubmit={submit} className="card space-y-4 p-5 sm:p-6">
          <Field label={t("login.password")}>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoFocus
              autoComplete="current-password"
              disabled={loading}
            />
          </Field>

          {error ? <Alert tone="red">{error}</Alert> : null}

          <Button type="submit" size="lg" variant="primary" className="w-full" loading={loading} disabled={password.length === 0}>
            {loading ? t("login.submitting") : t("login.submit")}
          </Button>

          <p className="text-[11px] leading-relaxed text-slate-500">
            {t("login.hint.before")} <code className="text-slate-400">BOTPANEL_PASSWORD</code>
            {t("login.hint.after")}
          </p>
        </form>

        <CreatorCredit className="mt-5 text-center" />
      </div>
    </div>
  );
}
