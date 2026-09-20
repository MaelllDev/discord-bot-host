import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { humanDuration } from "../format.ts";
import { Alert, Badge, Button, Card, DescriptionList, InlineCode, SkeletonCard } from "../components/ui.tsx";
import { IconAlert, IconLogout } from "../components/icons.tsx";
import { CREATOR, CreatorLinks, SupportLink } from "../components/Credits.tsx";
import AiSettingsCard from "../components/AiSettingsCard.tsx";

interface SettingRow {
  variable: string;
  label: string;
  value: string | null;
  hint: string;
}

export default function Settings({ onLogout }: { onLogout?: () => void }) {
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
        <h1 className="text-xl font-semibold text-slate-100">Configurações</h1>
        <Alert tone="red">{systemState.error ?? "Não foi possível ler a configuração do painel."}</Alert>
      </div>
    );
  }

  const config = system.config;

  const rows: SettingRow[] = [
    {
      variable: "BOTPANEL_NAME",
      label: "Nome exibido no painel",
      value: system.panelName,
      hint: "Aparece na sidebar e no título das páginas.",
    },
    {
      variable: "BOTPANEL_HOST",
      label: "Endereço de escuta",
      value: config.host,
      hint: "0.0.0.0 expõe em todas as interfaces. Coloque um proxy com HTTPS na frente.",
    },
    {
      variable: "BOTPANEL_PORT",
      label: "Porta",
      value: String(config.port),
      hint: "Porta HTTP do painel.",
    },
    {
      variable: "BOTPANEL_COOKIE_SECURE",
      label: "Cookie seguro",
      value: config.cookieSecure ? "ativado (1)" : "desativado (0)",
      hint: "Ative somente quando o painel estiver acessível via HTTPS.",
    },
    {
      variable: "BOTPANEL_DATA_DIR",
      label: "Diretório de dados",
      value: system.dataDir,
      hint: "Banco, releases e volumes /data de todas as aplicações.",
    },
    {
      variable: "BOTPANEL_DOCKER_SOCKET",
      label: "Socket do Docker",
      value: config.dockerSocket,
      hint: "Onde o painel fala com o daemon.",
    },
    {
      variable: "BOTPANEL_RUN_UID / BOTPANEL_RUN_GID",
      label: "Usuário dentro dos containers",
      value: `${config.runUid}:${config.runGid}`,
      hint: "Donos dos arquivos das aplicações dentro do container.",
    },
    {
      variable: "BOTPANEL_MAX_UPLOAD_MB",
      label: "Tamanho máximo de ZIP",
      value: `${config.maxUploadMb} MB`,
      hint: "Limite por upload de código.",
    },
    {
      variable: "BOTPANEL_KEEP_RELEASES",
      label: "Retenção de versões",
      value: config.keepReleases === 0 ? "manter todas" : `últimas ${config.keepReleases}`,
      hint: "Versões mais antigas são removidas depois de cada deploy bem-sucedido.",
    },
    {
      variable: "BOTPANEL_SESSION_TTL_HOURS",
      label: "Duração da sessão",
      value: `${config.sessionTtlHours} h (${humanDuration(config.sessionTtlHours * 3600)})`,
      hint: "Depois desse tempo o painel volta para a tela de login.",
    },
    {
      variable: "BOTPANEL_ALLOWED_IMAGES",
      label: "Imagens permitidas",
      value: config.allowedImages === null ? "qualquer imagem" : config.allowedImages.join(", "),
      hint: "Restringe as imagens Docker usáveis pelas aplicações.",
    },
    {
      variable: "BOTPANEL_PASSWORD / BOTPANEL_PASSWORD_HASH",
      label: "Senha do painel",
      value: "definida por variável de ambiente",
      hint: "A senha nunca é exposta pela API. Alterar exige editar /etc/botpanel.env e reiniciar o serviço.",
    },
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-100">Configurações</h1>
        <p className="mt-1 text-xs text-slate-500">
          Valores efetivos em execução. Esta página é <strong>somente leitura</strong>.
        </p>
      </header>

      <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
        A API do painel expõe a configuração apenas para leitura (<InlineCode>GET /api/system</InlineCode>) — não existe
        endpoint para gravar configuração. Para alterar qualquer valor, edite <InlineCode>/etc/botpanel.env</InlineCode>,
        rode <InlineCode>systemctl daemon-reload</InlineCode> quando mudar o unit e reinicie com{" "}
        <InlineCode>systemctl restart botpanel</InlineCode>. A senha e o segredo de sessão seguem a mesma regra e jamais
        são devolvidos pela API.
      </Alert>

      <Card
        title="Configuração efetiva"
        subtitle="Fonte: /etc/botpanel.env e o unit systemd do serviço"
        footer={
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[11px] text-slate-500">
              Instância <InlineCode>{config.instanceId}</InlineCode> · os containers e redes criados por ela carregam
              esse identificador.
            </span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" onClick={() => void systemState.reload()}>
                Recarregar
              </Button>
              {onLogout ? (
                <Button size="sm" variant="secondary" onClick={onLogout}>
                  <IconLogout className="h-3.5 w-3.5" /> Encerrar sessão
                </Button>
              ) : null}
            </div>
          </div>
        }
      >
        <ul className="divide-y divide-slate-800/70">
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
        <Card title="Operação do serviço" subtitle="Comandos úteis no host">
          <DescriptionList
            items={[
              { label: "Estado do painel", value: <InlineCode>systemctl status botpanel</InlineCode> },
              { label: "Logs do painel", value: <InlineCode>journalctl -u botpanel -f</InlineCode> },
              { label: "Estado do Docker", value: <InlineCode>systemctl status docker</InlineCode> },
              { label: "Containers do painel", value: <InlineCode>docker ps --filter label=botpanel.app</InlineCode> },
            ]}
          />
        </Card>

        <Card title="Senha e sessão" subtitle="Como o acesso é protegido">
          <div className="space-y-3 text-xs leading-relaxed text-slate-300">
            <p>
              O acesso usa uma senha única de administrador, verificada no servidor. A sessão é um cookie{" "}
              <InlineCode>httpOnly</InlineCode> assinado com HMAC-SHA256 e válido por{" "}
              {config.sessionTtlHours} h.
            </p>
            <p>
              O botão <strong>Encerrar sessão</strong> invalida todos os tokens emitidos até agora (a geração da sessão
              muda no banco), não apenas apaga o cookie deste navegador.
            </p>
            <p className="text-slate-500">
              Não há multiusuário, permissões por aplicação ou chaves de API — é um painel privado de administrador
              único, conforme o escopo do projeto.
            </p>
          </div>
        </Card>
      </div>

      <Card title="Créditos" subtitle={`Projeto criado e mantido por ${CREATOR.name}`}>
        <div className="flex flex-wrap items-start gap-4">
          <img
            src="/logo.png"
            alt=""
            width={56}
            height={56}
            className="h-14 w-14 shrink-0 rounded-2xl border border-slate-700/60 bg-slate-950/40 object-contain p-1"
          />
          <div className="min-w-0 flex-1 space-y-3 text-xs leading-relaxed text-slate-300">
            <p>
              O BotPanel é distribuído para <strong>self-host</strong>: qualquer pessoa pode subir o próprio painel na
              VPS. Os links abaixo são do autor do projeto — se ele te foi útil, siga e acompanhe as novidades.
            </p>
            <CreatorLinks />
            <p className="text-[11px] text-slate-500">BotPanel — projeto de {CREATOR.name}.</p>
            <div className="max-w-xs pt-1">
              <SupportLink />
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
