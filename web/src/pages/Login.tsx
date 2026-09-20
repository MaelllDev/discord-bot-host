import { useState } from "react";
import { api } from "../api.ts";
import { errorText } from "../hooks.ts";
import { Alert, Button, Field, Input } from "../components/ui.tsx";
import { IconAlert } from "../components/icons.tsx";
import { CreatorCredit } from "../components/Credits.tsx";

export default function Login({ onSuccess, expired = false }: { onSuccess: () => void; expired?: boolean }) {
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
            src="/logo.png"
            alt=""
            width={56}
            height={56}
            className="mx-auto h-14 w-14 rounded-2xl border border-slate-700/60 bg-slate-900/60 object-contain p-1"
          />
          <h1 className="mt-4 text-xl font-semibold text-slate-100">BotPanel</h1>
          <p className="mt-1 text-xs text-slate-500">Acesso restrito ao administrador</p>
        </div>

        {expired ? (
          <div className="mb-4">
            <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
              Sua sessão expirou. Entre novamente para continuar.
            </Alert>
          </div>
        ) : null}

        <form onSubmit={submit} className="card space-y-4 p-5">
          <Field label="Senha do painel">
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

          <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={password.length === 0}>
            {loading ? "Entrando…" : "Entrar"}
          </Button>

          <p className="text-[11px] leading-relaxed text-slate-500">
            A senha é definida pela variável <code className="text-slate-400">BOTPANEL_PASSWORD</code>. No primeiro boot o
            painel gera uma senha e a registra no log do serviço.
          </p>
        </form>

        <CreatorCredit className="mt-5 text-center" />
      </div>
    </div>
  );
}
