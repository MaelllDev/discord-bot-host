# AI log analysis

Optional feature: send an excerpt of an application's log to a large language model and get a
structured explanation of what is going wrong. You bring your own provider key; BotPanel ships none
and works fine without it.

## Supported providers

| Provider | API shape | Key required | Notes |
|---|---|---|---|
| OpenAI (ChatGPT) | `chat/completions` | yes | `gpt-4o-mini` and friends |
| Anthropic (Claude) | `messages` | yes | uses `x-api-key` |
| Google (Gemini) | `generateContent` | yes | uses `x-goog-api-key` |
| DeepSeek | `chat/completions` | yes | cheap, good for logs |
| Groq | `chat/completions` | yes | very fast; model names change often — use **find models** |
| OpenRouter | `chat/completions` | yes | one key, hundreds of models |
| Ollama | OpenAI-compatible | no | local, private; set the base URL (e.g. `http://127.0.0.1:11434/v1`) |
| Other OpenAI-compatible | `chat/completions` | depends | any custom endpoint with a base URL |

## Configuring

**Settings → AI log analysis**:

1. **Enable** the analysis (while it is off, the *Analyze with AI* button is hidden in the Logs tab).
2. Pick the **provider**.
3. **API key** — paste it. The key is stored in the panel's SQLite database and is **never returned
   by the API**; after saving, the field shows a masked hint such as `gsk••••GVAY`. Leaving the field
   empty when saving keeps the stored key; *remove key* deletes it. Changing provider discards the
   previous key on purpose.
4. **Find models** — asks the provider which models your key can actually use and lists them as
   clickable buttons (with a filter when there are many). Pick one; you can also type a name by hand.
   The catalogue changes all the time, which is why the panel warns when the typed model is not in
   the list — that mismatch is the cause of the usual *"the model does not exist or you do not have
   access to it"* error.
5. **How many lines to send** (20–1000) and **creativity** (0 = objective, best for diagnosis).
6. **Test connection** — verifies key, model and endpoint. It uses exactly what is in the form, so
   you can test before saving.
7. For custom/Ollama, set the **base URL** (for example `http://127.0.0.1:11434/v1`).

## Analyzing a log

1. Open the application → **Logs** tab.
2. Optionally type a question (for example "why does it disconnect every 30 minutes?").
3. Press **Analyze with AI**.
4. The panel sends the last N lines that are on screen plus the application context and shows the
   answer in sections (summary, likely cause, what to check, suggested fix), together with the exact
   excerpt that was sent (credentials already masked).
5. Each analysis is stored per application — reopen the dialog to see the history, and delete
   individual entries when you no longer need them.

The call runs server-side with a 90-second timeout and sends at most ~48 000 characters.

## What is sent, and privacy

**Sent:**

- the chosen log excerpt (after redaction);
- a small context block: application name/slug, runtime, image, entry and start commands, current
  status, configured limits, the number of lines and the deployment/failure summary when available;
- your optional question.

**Never sent:**

- the application's environment variables;
- your panel password, session cookie or database;
- any file of the host other than the log excerpt.

**Redaction** runs before the request leaves your VPS. It rewrites values that look like secrets:

| Pattern | Example |
|---|---|
| Known key prefixes | `sk-…`, `sk-ant-…`, `gsk_…`, `AIza…`, `xoxb-…`, `ghp_…`, `AKIA…` |
| Authorization headers | `Authorization: Bearer eyJ…`, `Bot MTIz…` |
| Discord bot tokens | `MTIzNDU2Nzg5MDEyMzQ1Njc4.Gh1jKl.abcdefghijklmnopqrstuvwxyz1234567` |
| JWTs | three `eyJ…` segments separated by dots |
| Named values | `DISCORD_TOKEN=…`, `PASSWORD: …`, `api_key: …` |
| Credentials in URLs | `https://user:pass@host/…` |

They become `<redigido>` in the text that is sent.

**The redaction is best-effort and cannot be complete.** Logs also contain message contents, user
IDs, e-mails, order numbers, IP addresses — anything your application prints. Before using this
feature:

- review what your bot writes to the log (add your own filtering if needed);
- prefer sending only the lines that matter (lower the line count);
- prefer a **local Ollama** instance when the log is sensitive — nothing leaves the machine in that
  case;
- read the privacy policy of the provider you configure: the excerpt is processed by them and
  subject to their terms.

The panel shows this warning in the settings card and again in the analysis dialog, and the exact
excerpt is always visible before you trust the answer.

## Costs

The provider bills you directly. A few hundred log lines with a small model costs fractions of a
cent. Lower the line count and the temperature to keep responses fast and cheap.
