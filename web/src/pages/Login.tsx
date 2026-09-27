import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { errorText } from "../hooks.ts";
import { Alert, Button, Field, InlineCode, Input } from "../components/ui.tsx";
import { IconAlert } from "../components/icons.tsx";
import { CreatorCredit } from "../components/Credits.tsx";
import { useI18n } from "../i18n/index.tsx";
import { useBranding } from "../branding.tsx";
import LanguageSwitch from "../components/LanguageSwitch.tsx";
import ThemeSwitch from "../components/ThemeSwitch.tsx";

/** Tamanho mínimo da nova senha — igual ao exigido pelo backend (auth.ts). */
const MIN_PASSWORD = 8;

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

  // Recuperação de senha: o link aparece sempre, mas o reset só é oferecido
  // quando o painel controla a senha (nenhuma env var) — aí o fluxo gera um
  // token de uso único e troca a senha. Com BOTPANEL_PASSWORD* o painel apenas
  // explica como trocar a senha no servidor. `null` = ainda consultando.
  const [recovery, setRecovery] = useState<boolean | null>(null);
  const [recoverStage, setRecoverStage] = useState<
    "idle" | "confirm" | "token" | "busy" | "done" | "unavailable"
  >("idle");
  const [recoverMessage, setRecoverMessage] = useState<string | null>("");
  const [tokenFile, setTokenFile] = useState("");
  const [tokenMinutes, setTokenMinutes] = useState(0);
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  /** Erro de requisição: 429 vira a mensagem de espera, o resto é do backend. */
  const recoverError = (caught: unknown): string => {
    const details = caught as { status?: number; details?: { retryAfterSeconds?: number } };
    if (details.status === 429) {
      const minutes = Math.max(1, Math.round((details.details?.retryAfterSeconds ?? 600) / 60));
      return t("login.recover.wait", { minutes: String(minutes) });
    }
    return errorText(caught);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .recoverStatus()
      .then((status) => {
        if (!cancelled) setRecovery(status.available);
      })
      .catch(() => {
        if (!cancelled) setRecovery(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Abre a recuperação decidindo entre o fluxo por token e a explicação. */
  const openRecovery = async (): Promise<void> => {
    setRecoverMessage(null);
    let available = recovery;
    if (available === null) {
      try {
        available = (await api.recoverStatus()).available;
        setRecovery(available);
      } catch {
        available = false;
      }
    }
    setRecoverStage(available ? "confirm" : "unavailable");
  };

  const requestToken = async (): Promise<void> => {
    setRecoverStage("busy");
    setRecoverMessage(null);
    try {
      const result = await api.recoverToken();
      setTokenFile(result.tokenFile);
      setTokenMinutes(Math.max(1, Math.round(result.expiresInSeconds / 60)));
      setToken("");
      setNewPassword("");
      setConfirmPassword("");
      setRecoverStage("token");
    } catch (caught) {
      setRecoverMessage(recoverError(caught));
      setRecoverStage("idle");
    }
  };

  const submitReset = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (token.trim().length === 0) {
      setRecoverMessage(t("login.recover.needToken"));
      return;
    }
    if (newPassword.length < MIN_PASSWORD) {
      setRecoverMessage(t("login.recover.tooShort", { count: String(MIN_PASSWORD) }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setRecoverMessage(t("login.recover.mismatch"));
      return;
    }
    setRecoverStage("busy");
    setRecoverMessage(null);
    try {
      await api.recoverReset(token.trim(), newPassword);
      setToken("");
      setNewPassword("");
      setConfirmPassword("");
      setRecoverStage("done");
    } catch (caught) {
      setRecoverMessage(recoverError(caught));
      setRecoverStage("token");
    }
  };

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
            className="accent-brand-glow mx-auto h-14 w-14 rounded-xl border border-indigo-400/20 bg-slate-900 object-contain p-1"
          />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-slate-50">{branding.name}</h1>
          <p className="mt-1 text-xs text-slate-500">{t("login.subtitle")}</p>
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-center gap-2">
          <ThemeSwitch compact />
          <LanguageSwitch compact />
        </div>

        {expired ? (
          <div className="mb-4">
            <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
              {t("login.expired")}
            </Alert>
          </div>
        ) : null}

        <div className="card space-y-4 p-5 sm:p-6">
          <form onSubmit={submit} className="space-y-4">
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

          <div className="space-y-3 border-t border-white/8 pt-4">
            {recoverStage === "idle" ? (
              <button
                type="button"
                onClick={() => void openRecovery()}
                className="mx-auto block rounded-sm text-[11px] text-slate-500 underline-offset-4 transition-colors hover:text-slate-300 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-400/50 outline-none"
              >
                {t("login.recover.link")}
              </button>
            ) : null}

            {recoverStage === "unavailable" ? (
              <div className="space-y-2.5 rounded-md border border-white/10 bg-white/[0.04] p-3">
                <p className="text-[11px] font-medium text-slate-200">{t("login.recover.env.title")}</p>
                <p className="text-[11px] leading-relaxed text-slate-400">{t("login.recover.env.body")}</p>
                <div className="flex flex-col gap-1.5 text-[11px] text-slate-400">
                  <InlineCode>sudo nano /etc/botpanel.env</InlineCode>
                  <InlineCode>sudo systemctl restart botpanel</InlineCode>
                  <InlineCode>sudo cat &lt;DATA_DIR&gt;/.initial-password</InlineCode>
                </div>
                <div className="flex justify-end">
                  <Button size="sm" variant="ghost" onClick={() => setRecoverStage("idle")}>
                    {t("common.close")}
                  </Button>
                </div>
              </div>
            ) : null}

              {recoverStage === "confirm" || recoverStage === "busy" ? (
                <div className="space-y-2.5 rounded-md border border-amber-400/20 bg-amber-500/10 p-3">
                  <p className="text-[11px] font-medium text-amber-200">{t("login.recover.title")}</p>
                  <p className="text-[11px] leading-relaxed text-amber-100/80">{t("login.recover.body")}</p>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRecoverStage("idle")}
                      disabled={recoverStage === "busy"}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={recoverStage === "busy"}
                      onClick={() => void requestToken()}
                    >
                      {t("login.recover.confirm")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {recoverStage === "token" ? (
                <form
                  onSubmit={submitReset}
                  className="space-y-2.5 rounded-md border border-amber-400/20 bg-amber-500/10 p-3"
                >
                  <p className="text-[11px] font-medium text-amber-200">
                    {t("login.recover.token.title", { minutes: String(tokenMinutes) })}
                  </p>
                  <p className="text-[11px] leading-relaxed text-amber-100/80">{t("login.recover.token.body")}</p>
                  <InlineCode>sudo cat {tokenFile}</InlineCode>

                  <Field label={t("login.recover.token")}>
                    <Input
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      autoComplete="off"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field label={t("login.recover.newPassword")}>
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      autoComplete="new-password"
                    />
                  </Field>
                  <Field label={t("login.recover.confirmPassword")}>
                    <Input
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      autoComplete="new-password"
                    />
                  </Field>

                  <div className="flex justify-end gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRecoverStage("idle")}>
                      {t("common.cancel")}
                    </Button>
                    <Button type="submit" size="sm" variant="primary">
                      {t("login.recover.submit")}
                    </Button>
                  </div>
                </form>
              ) : null}

              {recoverStage === "done" ? (
                <div className="rounded-md border border-emerald-400/20 bg-emerald-500/10 p-3">
                  <p className="text-[11px] leading-relaxed text-emerald-200">{t("login.recover.reset")}</p>
                </div>
              ) : null}

            {recoverMessage ? <Alert tone="amber">{recoverMessage}</Alert> : null}
          </div>
        </div>

        <CreatorCredit className="mt-5 text-center" />
      </div>
    </div>
  );
}
