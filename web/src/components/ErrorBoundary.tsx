import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import { Button, Card, InlineCode } from "./ui.tsx";

interface Props {
  /** Muda quando a rota muda: a tela em erro ganha uma nova chance. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * A mensagem fica em um componente de função porque o idioma vem de um hook —
 * e o `PageErrorBoundary` abaixo precisa continuar sendo uma classe para capturar
 * o erro de renderização.
 */
function ErrorCard({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <Card title={t("errors.page.title")} subtitle={t("errors.page.subtitle")}>
      <div className="space-y-4 text-xs leading-relaxed text-slate-300">
        <p>{t("errors.page.body")}</p>
        <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 font-mono text-[11px] break-all text-rose-100">
          {error.message || String(error)}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={onRetry}>
            {t("errors.page.retry")}
          </Button>
          <Button onClick={() => window.location.reload()}>{t("errors.page.reload")}</Button>
        </div>
        <p className="text-[11px] text-slate-500">
          {t("errors.page.technical.before")} <InlineCode>F12</InlineCode> {t("errors.page.technical.after")}
        </p>
      </div>
    </Card>
  );
}

/**
 * Sem isto, qualquer erro de render em uma página derruba a árvore inteira e o
 * usuário vê uma tela em branco sem nenhuma pista (foi o que aconteceu em
 * Configurações). Aqui o erro fica contido na área de conteúdo: a sidebar e o
 * resto do painel continuam de pé, e a mensagem aparece na tela.
 */
class PageErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Não há telemetria externa: o console do navegador é onde o erro fica.
    console.error("[botpanel] erro ao renderizar a página:", error, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return <ErrorCard error={error} onRetry={() => this.setState({ error: null })} />;
  }
}

/** Boundary ligado à rota atual: trocar de página limpa o estado de erro. */
export default function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <PageErrorBoundary resetKey={location.pathname}>{children}</PageErrorBoundary>;
}
