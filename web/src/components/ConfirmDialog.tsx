import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Button, Modal, Toggle } from "./ui.tsx";

export interface ConfirmState {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /**
   * Opção de caixa de seleção exibida acima dos botões. O estado pertence ao
   * próprio diálogo: quem o abre só descreve a opção e recebe o valor no `run`.
   * Guardar o valor do lado de fora congelava a interface — o toggle só refletia
   * o clique (e o valor enviado à API era o antigo) porque o elemento criado
   * junto com o diálogo ficava com o valor do momento da abertura.
   */
  checkbox?: { label: ReactNode; initial?: boolean };
  /** Executa a ação com o valor da caixa de seleção (false quando não há uma). */
  run: (checked: boolean) => Promise<void>;
}

/**
 * Confirmação para ações destrutivas. Cuida do estado de carregamento e fecha
 * sozinho quando a ação termina sem erro.
 */
export default function ConfirmDialog({ state, onClose }: { state: ConfirmState | null; onClose: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);

  // Cada abertura/fechamento do diálogo reinicia o estado interno.
  useEffect(() => {
    setBusy(false);
    setChecked(state?.checkbox?.initial ?? false);
  }, [state]);

  const confirm = async (): Promise<void> => {
    if (!state) return;
    setBusy(true);
    try {
      await state.run(checked);
      onClose();
    } catch {
      // O erro já é notificado por quem abriu o diálogo; mantemos aberto.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={state !== null}
      title={state?.title ?? ""}
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant={state?.danger ? "danger" : "primary"} loading={busy} onClick={() => void confirm()}>
            {state?.confirmLabel ?? t("common.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-xs leading-relaxed text-slate-300">
        {state?.description}
        {state?.checkbox ? (
          <Toggle checked={checked} onChange={setChecked} label={state.checkbox.label} disabled={busy} />
        ) : null}
        {state?.danger ? <Alert tone="red">{t("common.irreversible")}</Alert> : null}
      </div>
    </Modal>
  );
}
