import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode, RefObject } from "react";
import { useBlocker } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import { Button, Modal } from "./ui.tsx";
import { IconAlert, IconCheck, IconClose } from "./icons.tsx";

export interface UnsavedBarApi {
  /** true quando há alterações não salvas registradas na página atual. */
  dirty: boolean;
  /** Registra as alterações da página (ou limpa com false/null). */
  setDirty: (dirty: boolean | null) => void;
  /**
   * Salvar da página (registrado por quem está sujo), usado pela barra. Guardado
   * em ref: registrar não re-renderiza nada — a página chama a cada keystroke.
   */
  setRequestSave: (fn: (() => Promise<void>) | null) => void;
}

const UnsavedBarContext = createContext<UnsavedBarApi | null>(null);

/** Ref compartilhado provider ↔ viewport (o app tem uma única instância). */
const requestSaveRef: RefObject<(() => Promise<void>) | null> = { current: null };

export function useUnsavedBar(): UnsavedBarApi {
  const value = useContext(UnsavedBarContext);
  if (!value) throw new Error("useUnsavedBar fora do UnsavedBarProvider");
  return value;
}

export function UnsavedBarProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirtyState] = useState(false);

  const setDirty = useCallback((value: boolean | null): void => {
    setDirtyState(Boolean(value));
  }, []);

  const setRequestSave = useCallback((fn: (() => Promise<void>) | null): void => {
    requestSaveRef.current = fn;
  }, []);

  const api = useMemo<UnsavedBarApi>(() => ({ dirty, setDirty, setRequestSave }), [dirty, setDirty, setRequestSave]);

  // Recarregar a página ou fechar a aba: aviso nativo do navegador.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Chrome exige returnValue definido para mostrar o diálogo.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  return <UnsavedBarContext.Provider value={api}>{children}</UnsavedBarContext.Provider>;
}

/**
 * Parte visível do sistema. Deve ser renderizada DENTRO do roteador (o
 * `useBlocker` precisa do contexto de rotas) — o Layout a inclui no fim da
 * página. Sem data router, o boundary desativa só o diálogo de navegação e a
 * barra continua funcionando.
 */
export function UnsavedBarViewport() {
  // Sem provider (testes montam o Layout solto), o viewport funciona com os
  // defaults: sem página suja, a barra simplesmente não aparece.
  const api = useContext(UnsavedBarContext);
  const dirty = api?.dirty ?? false;
  return (
    <BlockerErrorBoundary fallback={<UnsavedFloatingBar dirty={dirty} />}>
      <UnsavedBlocking dirty={dirty} />
    </BlockerErrorBoundary>
  );
}

/** Barra fixa no rodapé com o estado pendente e as ações imediatas. */
function UnsavedFloatingBar({ dirty }: { dirty: boolean }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const save = async (): Promise<void> => {
    const fn = requestSaveRef.current;
    if (!fn) return;
    setSaving(true);
    try {
      await fn();
    } finally {
      setSaving(false);
    }
  };

  if (!dirty) return null;
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-xl border border-amber-500/40 bg-slate-900/95 px-4 py-3 shadow-xl shadow-black/40 backdrop-blur">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
            <IconAlert className="h-4 w-4" />
          </span>
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200">{t("unsaved.barMessage")}</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" onClick={() => setDiscardOpen(true)} disabled={saving}>
              <IconClose className="h-3.5 w-3.5" /> {t("unsaved.discard")}
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              <IconCheck className="h-3.5 w-3.5" /> {t("unsaved.save")}
            </Button>
          </div>
        </div>
      </div>
      {discardOpen ? (
        <Modal
          open
          title={t("unsaved.discardTitle")}
          onClose={() => setDiscardOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDiscardOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  // Descartar é desfazer manualmente: a página observa o evento
                  // e recarrega o formulário com os valores salvos.
                  setDiscardOpen(false);
                  window.dispatchEvent(new CustomEvent("botpanel:discard-changes"));
                }}
              >
                {t("unsaved.discardConfirm")}
              </Button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-slate-300">{t("unsaved.discardWarning")}</p>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * Barra + bloqueio de navegação interna. Ao trocar de página com alterações
 * pendentes, um diálogo pergunta: ficar, descartar ou salvar e sair.
 */
function UnsavedBlocking({ dirty }: { dirty: boolean }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  const save = async (): Promise<void> => {
    const fn = requestSaveRef.current;
    if (!fn) return;
    setSaving(true);
    try {
      await fn();
      if (blocker.state === "blocked") blocker.proceed();
    } finally {
      setSaving(false);
    }
  };

  const discard = (): void => {
    // O evento limpa o formulário (logo `dirty` cai) e a navegação segue.
    window.dispatchEvent(new CustomEvent("botpanel:discard-changes"));
    if (blocker.state === "blocked") blocker.proceed();
  };

  const stay = (): void => {
    if (blocker.state === "blocked") blocker.reset();
  };

  return (
    <>
      <UnsavedFloatingBar dirty={dirty} />
      {blocker.state === "blocked" ? (
        <Modal
          open
          title={t("unsaved.title")}
          onClose={stay}
          footer={
            <>
              <Button variant="ghost" onClick={stay}>
                {t("unsaved.stay")}
              </Button>
              <Button variant="ghost" onClick={discard}>
                {t("unsaved.discard")}
              </Button>
              {requestSaveRef.current ? (
                <Button variant="primary" loading={saving} onClick={() => void save()}>
                  {t("unsaved.saveAndLeave")}
                </Button>
              ) : (
                <Button variant="danger" onClick={() => blocker.proceed()}>
                  {t("unsaved.leave")}
                </Button>
              )}
            </>
          }
        >
          <div className="flex items-start gap-3 text-xs leading-relaxed text-slate-300">
            <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            {t("unsaved.leaveWarning")}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * Error Boundary dedicada: se o roteador atual não for um data router, o
 * `useBlocker` lança durante o render e este componente captura, mantendo o
 * resto da página (e a barra) funcionando.
 */
class BlockerErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    // Roteador sem suporte a bloqueio não é um erro do painel: apenas o
    // diálogo de navegação fica indisponível.
    console.warn("useBlocker indisponível neste roteador", error?.message);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
