import { useEffect, useRef } from "react";
import { useDeployment } from "../hooks.ts";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Badge, Spinner } from "./ui.tsx";
import { IconAlert, IconCheck } from "./icons.tsx";
import DeployProgress from "./DeployProgress.tsx";

export default function DeploymentLogView({
  slug,
  deploymentId,
  onFinished,
  showPhases = true,
}: {
  slug: string;
  deploymentId: number;
  onFinished?: (status: string) => void;
  showPhases?: boolean;
}) {
  const { t } = useI18n();
  const deployment = useDeployment(slug, deploymentId, onFinished);
  const containerRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [deployment.log]);

  const failed = deployment.status === "failed";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!deployment.finished ? (
          <>
            <Spinner className="h-3.5 w-3.5 text-indigo-400" />
            <Badge tone="amber">{t("deploy.publishing")}</Badge>
          </>
        ) : failed ? (
          <Badge tone="red">
            <IconAlert className="h-3 w-3" /> {t("deploy.failed")}
          </Badge>
        ) : (
          <Badge tone="green">
            <IconCheck className="h-3 w-3" /> {t("deploy.published")}
          </Badge>
        )}
      </div>

      {deployment.error ? <Alert tone="red">{deployment.error}</Alert> : null}

      {showPhases ? (
        <DeployProgress
          log={deployment.log}
          finished={deployment.finished}
          failed={failed}
          extra={
            failed ? (
              <Alert tone="amber">
                {t("deploy.previousStillActive.before")} <strong>{t("deploy.previousStillActive.strong")}</strong>{" "}
                {t("deploy.previousStillActive.after")} <code>/data</code> {t("deploy.previousStillActive.tail")}
              </Alert>
            ) : null
          }
        />
      ) : null}

      <pre
        ref={containerRef}
        className="terminal max-h-[45vh] overflow-auto rounded-lg border border-white/8 bg-slate-950 p-3 whitespace-pre-wrap text-slate-300"
      >
        {deployment.log || t("deploy.waiting")}
      </pre>
    </div>
  );
}
